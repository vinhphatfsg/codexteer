import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { observationServer } from "../test-support/observation-server.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject, continueProjectSync, projectEvent, projectWaitSignal } from "../src/project-sync.mjs";
import { waitProject, guardProject, orchestratorIdentity, projectGuardStatus } from "../src/project-wait.mjs";
import { listRecords, readRecord, writeRecord } from "../src/store.mjs";
import { pruneProjectHistory } from "../src/project-history.mjs";
import { createHash } from "node:crypto";

const ID = "11111111-1111-4111-8111-000000000001", SESSION = "22222222-2222-4222-8222-000000000001";
async function fixture(t, mode = "aggregate") {
  const home = await mkdtemp(tempPrefix("ct-wait-")); t.after(() => rm(home, { recursive: true, force: true }));
  const cloud = mode.startsWith("cloud"), id = cloud ? `durable_${ID}` : ID;
  const thread = { id, historyMode: mode.endsWith("paged") ? "paginated" : "aggregate", status: { type: "idle" },
    ...(cloud ? { environments: [{ environmentId: "env", environmentConfigId: "config" }] } : {}),
    turns: [{ id: "t0", status: "completed", items: [{ id: "question", type: "agentMessage", text: "Need answer", questions: ["Which?"] }] }] };
  const server = observationServer(thread), read = (id, options) => observeThread(id, options, {
    discover: async () => ({ paths: { socket: "fixture" } }), connect: async () => server.client,
  });
  const storage = { home }, connection = cloud ? "desktop-cloud" : "shared";
  await registerManagedThread(id, { projectId: "P", connection, ...(cloud ? { environmentConfigId: "config" } : {}) }, storage);
  await registerSupervisor(id, SESSION, { ...storage, connection });
  const dependencies = { storage, read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  await syncProject("P", {}, dependencies);
  return { home, id, thread, server, storage, dependencies };
}

for (const mode of ["aggregate", "paged", "cloud", "cloud-paged"]) {
  test(`${mode}: an idle worker awaiting an answer stays watched through a Desktop turn and wakes once`, async t => {
    const f = await fixture(t, mode), before = await getManagedThread(f.id, f.storage);
    const unchanged = await waitProject("P", { timeoutMs: 15 }, f.dependencies);
    assert.equal(unchanged.changed, false); assert.equal(unchanged.timed_out, true); assert.equal(unchanged.sync, null);
    assert.deepEqual(await getManagedThread(f.id, f.storage), before, "timeout cannot consume a cursor or revision");
    let returned = false;
    const waiting = waitProject("P", { timeoutMs: 2000 }, f.dependencies).then(result => { returned = true; return result; });
    await delay(20); assert.equal(returned, false);
    f.thread.status = { type: "active", activeFlags: [] };
    f.thread.turns.push({ id: "t1", status: "inProgress", items: [{ id: "answer", type: "userMessage", content: [{ type: "text", text: "Approved" }] }] });
    await delay(20); assert.equal(returned, false, "starting/progress alone does not wake wait");
    f.thread.turns[1].status = "completed"; f.thread.status = { type: "idle" };
    f.thread.turns[1].items.push({ id: "report", type: "agentMessage", text: "Finished" });
    const result = await waiting;
    assert.equal(result.changed, true); assert.equal(result.reason, "work_changed"); assert.equal(result.sync.complete, true);
    const report = result.sync.works[0].events.find(e => e.event_id === "report");
    assert.equal((await projectEvent(report.token, f.storage)).event.text, "Finished");
    assert.equal((await waitProject("P", { timeoutMs: 15 }, f.dependencies)).timed_out, true, "same change is not returned twice");
    assert.deepEqual(await listRecords("project-waits", f.storage), []);
    assert.ok(f.server.calls.every(c => !c.method.startsWith("turn/")), "no delivery or control effect");
  });
}

for (const change of ["question", "approval", "failure", "cancelled"]) test(`wait catches new ${change} without treating persistent attention as new`, async t => {
  const f = await fixture(t);
  if (change === "question") f.thread.turns[0].items.push({ id: "q2", type: "agentMessage", text: "Another question", questions: ["Answer?"] });
  if (change === "approval") f.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  if (change === "failure") { f.thread.turns.push({ id: "failed-turn", status: "failed", items: [] }); f.thread.status = { type: "systemError" }; }
  if (change === "cancelled") f.thread.turns.push({ id: "cancelled-turn", status: "cancelled", items: [] });
  const result = await waitProject("P", { timeoutMs: 0 }, f.dependencies);
  assert.equal(result.changed, true); assert.equal(result.reason, "work_changed");
  assert.equal((await waitProject("P", { timeoutMs: 10 }, f.dependencies)).timed_out, true);
});

test("membership changes wake wait; empty projects establish a baseline then time out", async t => {
  const f = await fixture(t);
  await registerManagedThread("11111111-1111-4111-8111-000000000002", { projectId: "P", connection: "shared" }, f.storage);
  const read = async (id, options) => ({ thread_id: id, cursor: options.since ?? "initial", omitted_older_events: 0, events: [], has_more: false, status: "idle", attention: [] });
  const changed = await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read });
  assert.equal(changed.reason, "membership_changed");
  assert.equal((await waitProject("empty", { timeoutMs: 0 }, f.dependencies)).reason, "initial_sync");
  assert.equal((await waitProject("empty", { timeoutMs: 0 }, f.dependencies)).timed_out, true);
});

test("failed observations are explicit, preserve the complete baseline and do not hide a later successful turn", async t => {
  const f = await fixture(t);
  const failed = await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read: async () => { throw Object.assign(new Error(), { code: "CLOUD_RATE_LIMITED" }); } });
  assert.equal(failed.changed, false); assert.equal(failed.timed_out, false); assert.equal(failed.reason, "observation_failed");
  assert.equal(failed.sync.complete, false);
  assert.deepEqual(failed.sync.works.map(work => work.error), ["CLOUD_RATE_LIMITED"]);
  f.thread.turns.push({ id: "t2", status: "completed", items: [{ id: "late", type: "agentMessage", text: "late report" }] });
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).changed, true);
});

for (const restart of [false, true]) test(`renewed approval in one running turn wakes wait after a flag clears (${restart ? "across timeouts" : "same process"})`, async t => {
  const f = await fixture(t);
  f.thread.turns.push({ id: "running-approval", status: "inProgress", items: [] });
  f.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  await syncProject("P", {}, f.dependencies);
  const basis = await getManagedThread(f.id, f.storage);
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).timed_out, true, "persistent approval stays quiet");
  if (restart) {
    f.thread.status.activeFlags = [];
    assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).timed_out, true);
    assert.deepEqual(await getManagedThread(f.id, f.storage), basis, "observed clear must not consume the reviewed cursor");
    f.thread.status.activeFlags = ["waitingOnApproval"];
  }
  let reads = 0;
  const dependencies = restart ? f.dependencies : { ...f.dependencies, read: (...args) => {
    f.thread.status.activeFlags = reads++ < 2 ? [] : ["waitingOnApproval"];
    return f.dependencies.read(...args);
  } };
  const renewed = await waitProject("P", { timeoutMs: 1000 }, dependencies);
  assert.equal(renewed.changed, true); assert.equal(renewed.reason, "work_changed");
  assert.equal(renewed.sync.works[0].turn_identity, "running-approval");
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).timed_out, true);
});

test("unknown attention stays distinct and fails observation without advancing wait's reviewed baseline", async t => {
  const f = await fixture(t), before = await getManagedThread(f.id, f.storage);
  const [head] = await listRecords("project-sync-heads", f.storage);
  assert.equal(projectWaitSignal({ attention: null }).attention, null);
  assert.equal(projectWaitSignal({}).attention, null);
  assert.deepEqual(projectWaitSignal({ attention: [] }).attention, []);
  f.thread.status = { type: "active", activeFlags: null };
  const unknown = await waitProject("P", { timeoutMs: 0 }, f.dependencies);
  assert.equal(unknown.changed, false); assert.equal(unknown.timed_out, false); assert.equal(unknown.reason, "observation_failed");
  assert.equal(unknown.sync.complete, false); assert.equal(unknown.sync.works[0].error, "PROJECT_WAIT_ATTENTION_UNKNOWN");
  assert.deepEqual(await getManagedThread(f.id, f.storage), before);
  assert.deepEqual((await listRecords("project-sync-heads", f.storage))[0].wait_baseline.works, head.wait_baseline.works);
  await syncProject("P", {}, f.dependencies);
  assert.equal((await listRecords("project-sync-heads", f.storage))[0].wait_baseline.works[f.id].signal.attention, null);
  f.thread.status.activeFlags = ["waitingOnApproval"];
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).changed, true, "known approval after an unknown baseline cannot be missed");
});

test("a partial project sync cannot consume changes against wait's last complete project baseline", async t => {
  const f = await fixture(t), other = "11111111-1111-4111-8111-000000000002";
  await registerManagedThread(other, { projectId: "P", connection: "shared", syncCursor: "o0" }, f.storage);
  let unavailable = false;
  const read = (id, options) => id === f.id ? f.dependencies.read(id, options) : unavailable ? Promise.reject(new Error("offline"))
    : Promise.resolve({ thread_id: id, cursor: "o0", events: [], has_more: false, status: "active", attention: [] });
  await syncProject("P", {}, { ...f.dependencies, read });
  f.thread.turns.push({ id: "after-baseline", status: "completed", items: [{ id: "important", type: "agentMessage", text: "Important" }] });
  unavailable = true;
  assert.equal((await syncProject("P", {}, { ...f.dependencies, read })).complete, false);
  unavailable = false;
  const result = await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read });
  assert.equal(result.changed, true); assert.ok(result.sync.works.find(w => w.thread_id === f.id).events.some(e => e.event_id === "important"));
});

test("latest wait snapshot remains recoverable through a new sync and explicit pruning", async t => {
  const f = await fixture(t);
  f.thread.turns.push({ id: "report", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Recoverable report" }] });
  const notified = await waitProject("P", { timeoutMs: 0 }, f.dependencies), token = notified.sync.sync_token;
  const recovered = await syncProject("P", {}, f.dependencies);
  assert.equal(recovered.wait_sync_token, token);
  await pruneProjectHistory("P", f.storage);
  const snapshot = await continueProjectSync(token, {}, f.storage);
  const report = snapshot.works[0].events.find(e => e.event_id === "report");
  assert.equal((await projectEvent(report.token, f.storage)).event.text, "Recoverable report");
});

test("legacy sync head replacement safely reinitializes wait once and subsequent completion stays observable", async t => {
  const f = await fixture(t), key = createHash("sha256").update("P").digest("hex").slice(0, 40);
  const [head] = await listRecords("project-sync-heads", f.storage);
  assert.ok(head.wait_baseline);
  // Older sync writers publish their known head fields rather than preserving
  // extensions. Reproduce that persisted shape without a second CLI install.
  const { wait_baseline, wait_sync_token, ...legacyHead } = head;
  await writeRecord("project-sync-heads", key, legacyHead, f.storage);
  const initial = await waitProject("P", { timeoutMs: 0 }, f.dependencies);
  assert.equal(initial.reason, "initial_sync"); assert.equal(initial.changed, true); assert.equal(initial.sync.complete, true);
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).timed_out, true);
  f.thread.turns.push({ id: "after-legacy", status: "completed", items: [{ id: "report", type: "agentMessage", text: "After legacy sync" }] });
  const changed = await waitProject("P", { timeoutMs: 0 }, f.dependencies);
  assert.equal(changed.reason, "work_changed");
  assert.ok(changed.sync.works[0].events.some(event => event.event_id === "report"));
});

test("guard counts paused and missing bindings, checks start identity, and allows empty or all-stopped projects", async t => {
  const f = await fixture(t), guard = () => guardProject("P", f.dependencies);
  assert.equal((await guard()).decision, "block");
  await controlSupervisor(f.id, "pause", f.storage);
  assert.equal((await guard()).decision, "block");
  await writeRecord("project-waits", "dead", { schema: 1, project_id: "P", pid: process.pid, process_start: "different-start" }, f.storage);
  assert.equal((await guard()).decision, "block", "PID alone does not prove wait liveness");
  await writeRecord("project-waits", "legacy", { schema: 1, project_id: "P", pid: process.pid, process_start: "same-start" }, f.storage);
  assert.equal((await guard()).decision, "block", "a live legacy wait without an owner cannot permit stop");
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const waiting = waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read: async (...args) => { enter(); await hold; return f.dependencies.read(...args); } });
  await entered;
  try {
  const foreign = await guardProject("P", { ...f.dependencies,
    orchestratorIdentity: async () => ({ pid: 456, process_start: "other-owner" }) });
  assert.equal(foreign.decision, "block", "another session's wait cannot notify this orchestrator");
  assert.match(foreign.reason, /one orchestrator|another session/i);
  assert.equal((await guardProject("P", { ...f.dependencies,
    orchestratorIdentity: async () => ({ pid: 123, process_start: "reused-pid" }) })).decision, "block");
  const unidentified = await guardProject("P", { ...f.dependencies, orchestratorIdentity: async () => null });
  assert.equal(unidentified.decision, undefined); assert.match(unidentified.systemMessage, /PROJECT_GUARD_OWNER_UNVERIFIED/);
  assert.deepEqual(await guard(), {});
  await assert.rejects(waitProject("P", { timeoutMs: 0 }, f.dependencies), { code: "RECORD_BUSY" });
  } finally { release(); await waiting; }
  assert.equal((await guard()).decision, "block");
  await controlSupervisor(f.id, "stop", f.storage); assert.deepEqual(await guard(), {});
  assert.deepEqual(await guardProject("empty", f.dependencies), {});
  await registerManagedThread("11111111-1111-4111-8111-000000000002", { projectId: "P", connection: "shared" }, f.storage);
  assert.equal((await guard()).decision, "block");
});

test("owner resolution uses the nearest CLI, excludes shared servers and never treats a shell as a session", async () => {
  const shell = { pid: 10, executable: "/bin/zsh", command: "zsh" };
  const claude = { pid: 20, executable: "/usr/bin/node", command: "node /opt/bin/claude" };
  const codex = { pid: 30, executable: "/opt/bin/codex", command: "codex" };
  const resolve = entries => orchestratorIdentity({ processAncestors: async () => entries, processIdentity: async pid => `start-${pid}` });
  assert.deepEqual(await resolve([shell, claude, codex]), { pid: 20, process_start: "start-20" });
  assert.deepEqual(await resolve([shell, codex]), { pid: 30, process_start: "start-30" });
  assert.equal(await resolve([shell, { ...codex, command: "codex app-server --listen socket" }]), null);
  assert.equal(await resolve([shell]), null);
  assert.deepEqual(await resolve([{ ...claude, command: '"/path with spaces/node" "/path with spaces/claude"' }]), { pid: 20, process_start: "start-20" });
});

test("an unidentified orchestrator warns and allows Stop instead of repeatedly blocking", async t => {
  const f = await fixture(t);
  const deps = { ...f.dependencies, orchestratorIdentity: async () => null };
  for (const hasWait of [false, true]) {
    if (hasWait) await writeRecord("project-waits", "live", { schema: 1, project_id: "P", pid: 123,
      process_start: "same-start", owner: { pid: 456, process_start: "some-owner" } }, f.storage);
    const result = await guardProject("P", deps);
    assert.equal(result.decision, undefined);
    assert.match(result.systemMessage, /cannot identify.*orchestrator session.*stop is allowed/i);
  }
});

test("the documented native Claude version path resolves as a session without recognizing unrelated version binaries", async () => {
  const resolve = executable => orchestratorIdentity({
    processAncestors: async () => [{ pid: 20, executable, command: `${executable} --version` }],
    processIdentity: async () => "native-start",
  });
  assert.deepEqual(await resolve("/home/example/.local/share/claude/versions/2.1.318"), { pid: 20, process_start: "native-start" });
  assert.equal(await resolve("/home/example/.local/share/unrelated/versions/2.1.318"), null);
});

test("hook markers require this project's live launcher and cannot cross nested CLI sessions", async () => {
  const launcher = { pid: 30, executable: "/usr/bin/node", command: "node codexteer.mjs orchestrate" };
  const agent = { pid: 20, executable: "/bin/claude", command: "claude" };
  const marker = { project_id: "P", pid: 30, process_start: "launcher-start" };
  const deps = { processAncestors: async () => [agent, launcher], processIdentity: async () => "launcher-start",
    env: { CODEXTEER_STOP_GUARD: JSON.stringify(marker) } };
  assert.equal((await projectGuardStatus("P", deps)).stop_hook, "configured");
  assert.equal((await projectGuardStatus("Q", deps)).stop_hook, "unverified");
  assert.equal((await projectGuardStatus("P", { ...deps, processIdentity: async () => "reused-pid" })).stop_hook, "unverified");
  assert.equal((await projectGuardStatus("P", { ...deps, processAncestors: async () => [{ ...agent, pid: 19 }, agent, launcher] })).stop_hook, "unverified");
  assert.equal((await projectGuardStatus("P", { ...deps, processAncestors: async () => [agent] })).stop_hook, "unverified");
  assert.equal((await projectGuardStatus("P", { ...deps, processAncestors: async () => { throw Object.assign(new Error(), { code: "EPERM" }); } })).stop_hook, "unverified");
});

test("invalid wait options and inspection failures do not masquerade as monitoring", async t => {
  const f = await fixture(t);
  for (const timeoutMs of [-1, NaN, Infinity, 0.5]) await assert.rejects(waitProject("P", { timeoutMs }, f.dependencies), { code: "PROJECT_WAIT_INVALID" });
  await assert.rejects(waitProject("P", {}, { ...f.dependencies, processIdentity: async () => null }), { code: "PROJECT_WAIT_IDENTITY_UNAVAILABLE" });
  await writeRecord("project-waits", "uninspectable", { schema: 1, project_id: "P", pid: process.pid, process_start: "start",
    owner: await f.dependencies.orchestratorIdentity() }, f.storage);
  const guard = await guardProject("P", { ...f.dependencies, processIdentity: async () => { throw Object.assign(new Error(), { code: "EPERM" }); } });
  assert.equal(guard.decision, undefined); assert.match(guard.systemMessage, /could not verify.*EPERM/);
});

test("a wait whose orchestrator exited ends without publishing and frees the project for the next session", async t => {
  const f = await fixture(t), headKey = createHash("sha256").update("P").digest("hex").slice(0, 40);
  let owner = "owner-start", reads = 0;
  const dependencies = { ...f.dependencies, processIdentity: async pid => pid === 123 ? owner : "same-start",
    read: async (...args) => {
      const page = await f.dependencies.read(...args);
      // The session dies between polls, right after a turn it never saw finished.
      if (++reads === 2) { owner = null; f.thread.turns.push({ id: "t1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Done" }] }); }
      return page;
    } };
  const head = await readRecord("project-sync-heads", headKey, f.storage);
  const orphan = await waitProject("P", { timeoutMs: 5000 }, dependencies);
  assert.deepEqual(orphan, { project_id: "P", changed: false, timed_out: false, reason: "owner_exited", unreadable: [], sync: null });
  assert.equal(reads, 2, "the exited owner is noticed before the next read");
  assert.deepEqual(await listRecords("project-waits", f.storage), []);
  assert.deepEqual(await readRecord("project-sync-heads", headKey, f.storage), head, "nothing is published for an orchestrator that is gone");
  const resumed = await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, orchestratorIdentity: async () => ({ pid: 456, process_start: "resumed" }),
    processIdentity: async pid => pid === 456 ? "resumed" : "same-start" });
  assert.equal(resumed.reason, "work_changed", "the next session's wait takes the lock and still sees the change");

  for (const [name, identity, orchestrator] of [["unidentified owner", async pid => pid === 123 ? null : "same-start", async () => null],
    ["uninspectable owner", async pid => { if (pid === 123) throw Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" }); return "same-start"; }, f.dependencies.orchestratorIdentity]]) {
    const waited = await waitProject("P", { timeoutMs: 30 }, { ...f.dependencies, processIdentity: identity, orchestratorIdentity: orchestrator });
    assert.equal(waited.reason, "timeout", `${name} keeps waiting`);
  }
});
