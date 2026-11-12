import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { fail } from "../src/cli.mjs";
import { startWork } from "../src/work-start.mjs";
import { createDesktopCloudTask, reconcileDesktopCloudCreation, desktopCloudReceipt, sendDesktopCloudInput } from "../src/desktop-cloud.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { fetchThread, readSnapshot, observeThread } from "../src/observe.mjs";
import { listRecords } from "../src/store.mjs";
import { historyBucket } from "../src/project-history.mjs";
import { getManagedThread, managedMembershipDigest } from "../src/project-index.mjs";
import { getSupervisor, registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { controlProject } from "../src/project-control.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { repositorySource } from "../src/repository-source.mjs";
import { resolveCloudModelSelection, setCloudModelDefaults } from "../src/desktop-cloud-models.mjs";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000009", ID = `durable_${uuid}`, ENV = "fixture~asenvcfg_work";
const sha = s => createHash("sha256").update(s).digest("hex");
async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-dc-home-")), root = await mkdtemp(tempPrefix("ct-dc-root-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const policy = "方針 ${literal}\r\n末尾\n"; await writeFile(`${root}/CODEXTEER.md`, policy);
  const state = { turns: [], flags: [], environment: ENV, status: "idle", lost: false, missing: false, calls: [] };
  const rpc = { close() {}, async request(method, params) {
    state.calls.push({ method, params });
    if (method === "model/list") return { data: [{ model: "neutral-default", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }] };
    if (method === "thread/start" && state.lostCreate) throw Object.assign(new Error("creation receipt lost"), { uncertain: true });
    if (method === "thread/start") return { thread: { id: uuid } };
    if (method === "thread/name/set") return {};
    if (method === "thread/read") {
      if (state.missing) throw Object.assign(new Error("not visible"), { code: "THREAD_NOT_FOUND" });
      return { thread: { id: uuid, name: "worker", status: { type: state.status, ...(state.flags === null ? {} : { activeFlags: state.flags }) },
        environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: state.environment }] } };
    }
    if (method === "thread/turns/list") return { data: state.turns.map(turn => ({ ...turn, itemsView: "full" })), nextCursor: null, backwardsCursor: null };
    if (method === "turn/start") {
      const turn = { id: `turn-${state.turns.length}`, status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", clientId: state.nullClientId ? null : params.clientUserMessageId, content: params.input }] };
      state.turns.push(turn); state.status = "active";
      if (state.lost) throw Object.assign(new Error("lost receipt"), { uncertain: true });
      return { turn: { id: turn.id } };
    }
    if (method === "turn/steer") { state.turns.at(-1).items.push({ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input }); return { turnId: state.turns.at(-1).id }; }
    throw new Error(`Unexpected ${method}`);
  } };
  const storage = { home }, connect = async () => new DesktopCloudClient(rpc), environments = async () => ({ environments: [{ id: ENV, name: "Fixture" }] });
  const transport = { ...storage, connect, environments };
  const read = async (id, options) => readSnapshot(await fetchThread(await connect(), id), options);
  const deps = { storage, resolveEnvironment: async selector => { assert.ok([ENV, "Fixture"].includes(selector)); return { id: ENV, name: "Fixture" }; },
    resolveModelSelection: options => resolveCloudModelSelection(options, transport),
    create: ({ environmentConfigId, prompt, title, attemptId, modelSelection }) => createDesktopCloudTask(environmentConfigId, prompt, { title, attemptId, modelSelection }, transport),
    reconcile: record => reconcileDesktopCloudCreation(record, transport), read };
  const input = { project: "coordination-only", title: "tests", order: "Report a focused result.", root, environment: "Fixture", connection: "desktop-cloud" };
  return { home, root, policy, state, storage, transport, read, deps, input };
}
const creates = f => f.state.calls.filter(c => c.method === "thread/start").length;
const deliveries = f => f.state.calls.filter(c => ["turn/start", "turn/steer"].includes(c.method)).length;

test("new work reads saved defaults immediately and a reserved order keeps its original selection across changes", async t => {
  const f = await fixture(t); let paused = false;
  await setCloudModelDefaults({ model: "neutral-default", thinking: "high" }, f.transport);
  f.deps.hook = async boundary => { if (!paused && boundary === "attempt_saved") { paused = true; throw Object.assign(Error("pause"), { code: "INTERRUPTED" }); } };
  await assert.rejects(startWork(f.input, f.deps), { code: "INTERRUPTED" });
  await setCloudModelDefaults({ model: "neutral-default", thinking: "low" }, f.transport);
  const result = await startWork(f.input, f.deps);
  assert.equal(result.model_selection.thinking, "high");
  assert.equal(f.state.calls.find(c => c.method === "turn/start").params.effort, "high");
  await startWork(f.input, f.deps); assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  await assert.rejects(startWork({ ...f.input, thinking: "low" }, f.deps), { code: "WORK_START_CONFLICT" });
  // A separate new order resolves the newly saved value before allocation.
  let resolved;
  f.deps.hook = async (boundary, record) => { if (boundary === "attempt_saved") { resolved = record.model_selection; throw Object.assign(Error("pause"), { code: "INTERRUPTED" }); } };
  await assert.rejects(startWork({ ...f.input, title: "next worker" }, f.deps), { code: "INTERRUPTED" });
  assert.equal(resolved.thinking, "low"); assert.equal(creates(f), 1);
});

test("Desktop Cloud work start pins configuration, policy bytes and provenance without Desktop project assignment", async t => {
  const f = await fixture(t);
  f.deps.hook = async name => { if (name === "membership_registered") { assert.equal((await getManagedThread(ID, f.storage)).environment_config_id, ENV); assert.equal(await getSupervisor(ID, f.storage), null); } };
  const result = await startWork(f.input, f.deps), member = await getManagedThread(ID, f.storage), record = (await listRecords(historyBucket("work-starts", "coordination-only"), f.storage))[0];
  assert.equal(JSON.parse(await readFile(result.receipt_path, "utf8")).policy_bytes_base64, Buffer.from(f.policy).toString("base64"));
  assert.equal(result.stage, "observed"); assert.equal(result.environment_config_id, ENV); assert.equal(result.environment_verified, true); assert.equal(member.project_id, "coordination-only");
  assert.equal(member.connection, "desktop-cloud"); assert.equal(member.backend_project_id, null); assert.equal(member.sync_cursor, undefined); assert.ok(record.initial_events.length);
  assert.equal(Buffer.from(record.policy_bytes_base64, "base64").toString(), f.policy); assert.equal(record.policy_sha256, sha(f.policy));
  assert.equal(record.prompt.split(f.policy).length - 1, 1); assert.equal(result.source.root, f.root); assert.equal(result.source.cloud_checkout_match, "unverified");
  assert.equal((await getSupervisor(ID, f.storage)).connection, "desktop-cloud");
  assert.ok(f.state.calls.every(c => c.params.projectId === undefined));
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  await startWork({ ...f.input, environment: ENV }, f.deps); assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
});

for (const boundary of ["attempt_saved", "before_create_rpc", "create_returned", "child_saved", "membership_registered", "index_updated", "supervisor_registered", "initial_read"]) {
  test(`Desktop Cloud saga recovery at ${boundary} never re-creates or re-sends`, async t => {
    const f = await fixture(t); let injected = false;
    f.deps.hook = async name => { if (!injected && name === boundary) { injected = true; throw Object.assign(new Error("interrupt"), { code: "INTERRUPTED" }); } };
    await assert.rejects(startWork(f.input, f.deps), { code: "INTERRUPTED" }); delete f.deps.hook;
    assert.equal((await startWork(f.input, f.deps)).stage, "observed"); assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  });
}

test("Desktop Cloud recovery proves a creation whose stored message has no client ID by its accepted turn and digest", async t => {
  const f = await fixture(t); f.state.nullClientId = true; let injected = false;
  f.deps.hook = async name => { if (!injected && name === "create_returned") { injected = true; throw Object.assign(new Error("interrupt"), { code: "INTERRUPTED" }); } };
  await assert.rejects(startWork(f.input, f.deps), { code: "INTERRUPTED" }); delete f.deps.hook;
  assert.equal((await startWork(f.input, f.deps)).stage, "observed");
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
});

test("unknown initial delivery reconciles stored prompt read-only, and missing history never causes replay", async t => {
  const f = await fixture(t); f.state.lost = true;
  await assert.rejects(startWork(f.input, f.deps), error => error.delivery_status === "unknown" && error.thread_id === ID);
  const record = (await listRecords(historyBucket("work-starts", "coordination-only"), f.storage))[0];
  f.state.missing = true; await assert.rejects(startWork(f.input, f.deps), { code: "THREAD_NOT_FOUND" });
  f.state.missing = false; assert.equal((await startWork(f.input, f.deps)).stage, "observed");
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  for (const [field, value] of [["environment_config_id", "another"], ["prompt_sha256", "0".repeat(64)], ["model_selection", { model: "neutral-default", thinking: "high" }]]) await assert.rejects(reconcileDesktopCloudCreation({ ...record, [field]: value }, f.transport), { code: "WORK_RECONCILE_MISMATCH" });
  assert.equal(await reconcileDesktopCloudCreation({ ...record, attempt_id: randomUUID() }, f.transport), null);
  assert.equal((await desktopCloudReceipt(record.attempt_id, f.storage)).delivery_status, "accepted");
  await syncProject(f.input.project, {}, { storage: f.storage, read: f.read });
  const sent = await tellWork(ID, "Continue the same delegation.", {}, { storage: f.storage, read: f.read, send: (id, body, options) => sendDesktopCloudInput(id, body, options, f.transport) });
  assert.equal(sent.delivery_status, "accepted", "stored evidence clears the unknown reservation without a replay");
});

test("initial incomplete, unavailable, history-gap and route failures leave cursor absent and never recreate", async t => {
  for (const kind of ["incomplete", "unavailable", "gap", "route"]) {
    const f = await fixture(t), normal = f.deps.read; let n = 0;
    f.deps.read = async (id, options) => {
      if (kind === "unavailable") throw Object.assign(new Error("missing"), { code: "THREAD_NOT_FOUND" });
      if (kind === "incomplete" && n++) throw Object.assign(new Error("boundary"), { code: "OBSERVATION_CHANGED" });
      const page = await normal(id, options);
      return { ...page, ...(kind === "incomplete" ? { has_more: true } : kind === "gap" ? { omitted_older_events: 1 } : { environment_config_id: "another" }) };
    };
    let caught;
    await assert.rejects(startWork(f.input, f.deps), error => { caught = error; return error.thread_id === ID && typeof error.attempt_id === "string" && typeof error.receipt_path === "string"
      && error.observed === false && error.observation === (kind === "unavailable" ? "unavailable" : "incomplete") && (kind !== "gap" || error.history_gap === true); });
    const lines = [], priorExit = process.exitCode;
    const log = t.mock.method(console, "log", line => lines.push(line));
    try { fail(caught, true); } finally { log.mock.restore(); process.exitCode = priorExit; }
    const publicError = JSON.parse(lines[0]).error;
    assert.equal(publicError.thread_id, ID); assert.equal(publicError.observation, caught.observation); assert.equal(publicError.observed, false);
    assert.equal(publicError.receipt_path, caught.receipt_path);
    assert.equal((await getManagedThread(ID, f.storage)).sync_cursor, undefined);
    f.deps.read = normal; await startWork(f.input, f.deps); assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  }
});

test("Desktop Cloud stopped supervision is retained on saga retry", async t => {
  const f = await fixture(t);
  f.deps.hook = async name => { if (name === "membership_registered") { await registerSupervisor(ID, randomUUID(), { ...f.storage, connection: "desktop-cloud" }); await controlSupervisor(ID, "stop", f.storage); } };
  await assert.rejects(startWork(f.input, f.deps), { code: "MANAGED_SUPERVISOR_STOPPED" });
  assert.equal((await getSupervisor(ID, f.storage)).state, "stopped"); assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
});

test("Desktop Cloud sync/tell share real aggregate cursors, environment route and attention refusal", async t => {
  const f = await fixture(t); await startWork(f.input, f.deps);
  let synced = await syncProject(f.input.project, {}, { storage: f.storage, read: f.read }); assert.equal(synced.complete, true);
  const sent = await tellWork(ID, "Review the existing result.", {}, { storage: f.storage, read: f.read, send: (id, wire, options) => sendDesktopCloudInput(id, wire, options, f.transport) });
  assert.equal(sent.delivery_status, "accepted"); assert.equal(creates(f), 1);
  for (const [flags, expected] of [[["waitingOnApproval"], "WORK_TELL_HUMAN_REQUIRED"], [null, "WORK_TELL_ATTENTION_UNKNOWN"]]) {
    // A fresh independent fixture avoids clearing prior unresolved evidence by omission.
    const g = await fixture(t); await startWork(g.input, g.deps); g.state.flags = flags;
    synced = await syncProject(g.input.project, {}, { storage: g.storage, read: g.read }); assert.equal(synced.complete, true);
    await assert.rejects(tellWork(ID, "Do not answer", {}, { storage: g.storage, read: g.read, send: () => assert.fail("no dispatch") }), { code: expected });
  }
  await syncProject(f.input.project, {}, { storage: f.storage, read: f.read });
  f.state.environment = "another";
  await assert.rejects(tellWork(ID, "Do not switch routes", {}, { storage: f.storage, read: f.read, send: () => assert.fail("no send") }), { code: "WORK_TELL_ROUTE_MISMATCH" });
  const mismatch = await syncProject(f.input.project, {}, { storage: f.storage, read: f.read });
  assert.equal(mismatch.complete, false); assert.equal(mismatch.works[0].error, "PROJECT_ROUTE_MISMATCH");
  await assert.rejects(sendDesktopCloudInput(ID, "wrong route", {}, f.transport), { code: "DESKTOP_CLOUD_ROUTE_MISMATCH" });
});

test("Desktop Cloud start requires explicit root/environment and rejects legacy cloud without authentication", async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, root: undefined }, { ...f.input, environment: undefined }]) await assert.rejects(startWork(input, f.deps), { code: "WORK_START_OPTIONS_INVALID" });
  await assert.rejects(startWork({ ...f.input, connection: "cloud" }, f.deps), { code: "WORK_START_CONNECTION_UNSUPPORTED" });
  const result = spawnSync(process.execPath, ["bin/codexteer.mjs", "--connection", "cloud", "work", "start", "--project", "legacy", "--title", "x", "order", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout || result.stderr).error.code, "WORK_START_CONNECTION_UNSUPPORTED"); assert.equal(creates(f), 0);
});

test("repository provenance removes URL credentials and environment identity changes the membership digest", async t => {
  const f = await fixture(t);
  const remote = new URL("https://example.test/repo.git"); remote.username = "fixture-user"; remote.password = "fixture-secret"; remote.search = "?token=fixture-secret";
  for (const args of [["init", f.root], ["-C", f.root, "config", "remote.origin.url", remote.href]]) assert.equal(spawnSync("git", args).status, 0);
  const source = repositorySource(f.root); assert.equal(source.remote_url, "https://example.test/repo.git"); assert.doesNotMatch(JSON.stringify(source), /secret/);
  await startWork(f.input, f.deps); const member = await getManagedThread(ID, f.storage);
  assert.notEqual(managedMembershipDigest([member]), managedMembershipDigest([{ ...member, environment_config_id: "changed" }]));
});

test("an unknown thread allocation is never recreated and concurrent starts share one attempt", async t => {
  const f = await fixture(t); f.state.lostCreate = true;
  await assert.rejects(startWork(f.input, f.deps));
  await assert.rejects(startWork(f.input, f.deps), { code: "WORK_CREATE_UNKNOWN" });
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 0);
  const g = await fixture(t);
  const results = await Promise.allSettled([startWork(g.input, g.deps), startWork(g.input, g.deps)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(creates(g), 1); assert.equal(deliveries(g), 1);
});

test("Desktop Cloud lost history, missing tasks, questions and pause/stop refuse tell without replay", async t => {
  for (const kind of ["gap", "missing", "question", "pause", "stop"]) {
    const f = await fixture(t); await startWork(f.input, f.deps);
    await syncProject(f.input.project, {}, { storage: f.storage, read: f.read });
    if (kind === "gap") f.state.turns = [];
    if (kind === "missing") f.state.missing = true;
    if (kind === "question") f.state.turns.at(-1).items.push({ id: "question", type: "agentMessage", text: "Which?", questions: ["A or B?"] });
    if (["pause", "stop"].includes(kind)) await controlSupervisor(ID, kind, f.storage);
    else {
      const result = await syncProject(f.input.project, {}, { storage: f.storage, read: f.read });
      if (kind === "gap") assert.equal(result.works[0].history_gap, true);
      if (kind === "missing") assert.equal(result.works[0].observation, "unavailable");
      if (kind === "question") assert.equal(result.works[0].attention, "human");
    }
    await assert.rejects(tellWork(ID, "No proxy answer", {}, { storage: f.storage, read: f.read, send: (id, body, options) => sendDesktopCloudInput(id, body, options, f.transport) }),
      { code: kind === "question" ? "WORK_TELL_HUMAN_REQUIRED" : kind === "pause" ? "SUPERVISOR_PAUSED" : kind === "stop" ? "SUPERVISOR_STOPPED" : "WORK_TELL_SYNC_INCOMPLETE" });
    assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
  }
});

test("changing a Desktop Cloud configuration never silently creates another worker for the same order", async t => {
  const f = await fixture(t); await startWork(f.input, f.deps);
  f.deps.resolveEnvironment = async () => ({ id: "different-config", name: "Other" });
  await assert.rejects(startWork({ ...f.input, environment: "Other" }, f.deps), { code: "WORK_START_CONFLICT" });
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 1);
});

test("initial delivery verifies the selected environment before sending any prompt", async t => {
  const f = await fixture(t); f.state.environment = "another";
  await assert.rejects(startWork(f.input, f.deps), { code: "DESKTOP_CLOUD_ROUTE_MISMATCH" });
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 0);
  f.state.environment = ENV;
  await assert.rejects(startWork(f.input, f.deps), { code: "WORK_CREATE_UNKNOWN" });
  assert.equal(creates(f), 1); assert.equal(deliveries(f), 0, "a created but unsent task is not resumed by an automatic send");
});

// The app-server ThreadStatus of a finished task is idle, or notLoaded once the
// server unloaded it; neither carries activeFlags.
for (const finished of ["idle", "notLoaded"]) {
  test(`a stopped Desktop Cloud task that finished (${finished}) is settled by one sync and not read again`, async t => {
    const f = await fixture(t); await startWork(f.input, f.deps);
    const read = (id, options) => observeThread(id, options, { connect: f.transport.connect }), reads = () => f.state.calls.filter(c => c.method === "thread/read").length;
    f.state.turns.at(-1).items.push({ id: "report", type: "agentMessage", text: "Done." }); f.state.turns.at(-1).status = "completed";
    Object.assign(f.state, { status: finished, flags: null });
    assert.equal((await controlProject(f.input.project, "stop", { work: ID }, f.storage)).changed, 1);
    const initial = reads(), first = await syncProject(f.input.project, {}, { storage: f.storage, read });
    assert.ok(reads() > initial, "the sync that first sees the stop reads the task"); assert.equal(first.complete, true); assert.equal(first.works[0].execution, "idle"); assert.equal(first.works[0].settled.basis, "observed");
    assert.ok(first.works[0].events.some(event => event.event_id === "report"), "the final report is presented before the task is left alone");
    const before = reads(), second = await syncProject(f.input.project, {}, { storage: f.storage, read });
    assert.equal(reads(), before, "the settled task is not read"); assert.equal(second.complete, true);
    assert.equal(second.works[0].observation, "settled"); assert.equal(second.works[0].settled.basis, "observed");
  });
}
