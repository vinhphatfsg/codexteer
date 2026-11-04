import { listRecords, writeRecord } from "../src/store.mjs";
import { createFinding } from "../src/findings.mjs";
import { sendTrackedMessage } from "../src/journal.mjs";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { observationServer } from "../test-support/observation-server.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject, projectEvent } from "../src/project-sync.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { startWork } from "../src/work-start.mjs";
import { sendOnClient } from "../src/app-server.mjs";
import { sendDesktopCloudInput } from "../src/desktop-cloud.mjs";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", session = "22222222-2222-4222-8222-000000000001";
const msg = (id, text = id) => ({ id, type: "agentMessage", text });
const user = id => ({ id, type: "userMessage", content: [{ type: "text", text: id }] });
async function fixture(t, mode, managed = true) {
  const home = await mkdtemp(tempPrefix("ct-adapter-")); t.after(() => rm(home, { recursive: true, force: true }));
  const cloud = mode.startsWith("desktop-cloud"), id = cloud ? `durable_${uuid}` : uuid;
  const thread = { id, historyMode: mode.endsWith("paged") ? "paginated" : "aggregate", status: { type: "active", activeFlags: [] },
    ...(cloud ? { environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: "config" }] } : {}),
    turns: [{ id: "t0", status: "inProgress", items: [user("order")] }] };
  const server = observationServer(thread), runtime = { discover: async () => ({ paths: { socket: "fake" } }), connect: async () => server.client };
  const read = (target, options) => observeThread(target, options, runtime);
  if (managed) {
    const initial = await read(id, {});
    await registerManagedThread(id, { projectId: "adapter", connection: cloud ? "desktop-cloud" : "shared", syncCursor: initial.cursor,
      ...(cloud ? { environmentConfigId: "config" } : {}) }, { home });
    await registerSupervisor(id, session, { home, connection: cloud ? "desktop-cloud" : "shared" });
  }
  return { home, id, thread, server, read, cloud };
}
const modes = ["aggregate", "paged", "desktop-cloud", "desktop-cloud-paged"];
for (const mode of modes) {
  test(`${mode}: omitted initial history never becomes an observed or complete basis`, async t => {
    const f = await fixture(t, mode, false); let creates = 0;
    f.thread.status = { type: "idle" }; f.thread.turns[0].status = "completed";
    f.thread.turns[0].items.push(...Array.from({ length: 1100 }, (_, i) => msg(`old-${i}`)));
    const input = { project: "adapter", title: "large initial", order: "inspect", root: f.home, connection: f.cloud ? "desktop-cloud" : "shared", ...(f.cloud ? { environment: "config" } : {}) };
    const deps = { storage: f, read: f.read, resolveEnvironment: async () => ({ id: "config" }), create: async input => { creates++; return { thread_id: f.id,
      environment_config_id: "config", attempt_id: input.attemptId, prompt_sha256: createHash("sha256").update(input.prompt).digest("hex") }; } };
    for (let i = 0; i < 2; i++) {
      await assert.rejects(startWork(input, deps), error => error.code === "WORK_INITIAL_HISTORY_GAP" && error.observed === false && error.history_gap);
      const sync = await syncProject("adapter", {}, { storage: f, read: f.read });
      assert.equal(sync.complete, false); assert.equal(sync.works[0].history_gap, true); assert.equal(sync.works[0].cursor, null);
      assert.equal((await getManagedThread(f.id, f)).sync_cursor, undefined);
    }
    assert.equal(creates, 1); assert.equal((await listRecords("work-starts", f))[0].sync_cursor, undefined);
  });

  test(`${mode}: missing initial-boundary proof fails closed even with has_more false`, async t => {
    for (const omitted of [undefined, null]) {
      const f = await fixture(t, mode, false);
      const input = { project: "adapter", title: "unproven", order: "inspect", root: f.home };
      await assert.rejects(startWork(input, { storage: f, create: async () => ({ thread_id: f.id }), read: async (id, options) => ({ ...await f.read(id, options), omitted_older_events: omitted }) }), { code: "WORK_INITIAL_HISTORY_GAP" });
      assert.equal((await getManagedThread(f.id, f)).sync_cursor, undefined);
    }
  });

  test(`${mode}: supervised low-level send cannot bypass the absent complete sync`, async t => {
    const f = await fixture(t, mode), cursor = (await f.read(f.id, {})).cursor;
    const finding = await createFinding(f.id, { key: "bypass", title: "Bypass", condition: "Review", basedOn: cursor, home: f.home });
    await assert.rejects(sendTrackedMessage(f.id, "bypass", { supervisor: session, basedOn: cursor, finding: finding.id,
      connection: f.cloud ? "desktop-cloud" : "shared" }, { home: f.home, send: () => assert.fail("delivery") }), { code: "MANAGED_INTERVENTION_REQUIRED" });
    assert.equal(f.server.calls.some(c => c.method.startsWith("turn/")), false);
  });

  test(`${mode}: a sync published during the final backend read invalidates delivery`, async t => {
    const f = await fixture(t, mode); await syncProject("adapter", {}, { storage: f, read: f.read });
    let published = false;
    const finalClient = { request: async (...args) => {
      if (!published) { published = true; await syncProject("adapter", {}, { storage: f, read: f.read }); }
      return f.server.client.request(...args);
    } };
    await assert.rejects(tellWork(f.id, "old basis", {}, { storage: f, read: f.read, send: async (_id, _wire, options) => {
      await options.beforeSend(f.thread, finalClient); assert.fail("delivery");
    } }), { code: "WORK_TELL_SYNC_CONFLICT" });
    assert.equal(published, true);
    assert.equal(f.server.calls.some(c => c.method.startsWith("turn/")), false);
  });

  for (const change of ["event", "updated", "question", "approval"]) test(`${mode}: delivery-boundary ${change} refuses mutation`, async t => {
    const f = await fixture(t, mode);
    if (change === "updated") f.thread.turns[0].items.push(msg("tail", "before"));
    await syncProject("adapter", {}, { storage: f, read: f.read });
    let mutated = false;
    const send = async (id, wire, options) => {
      // This runs after tell's initial freshness observation and finding creation,
      // immediately before the real delivery adapter obtains its send state.
      if (change === "updated") f.thread.turns[0].items.at(-1).text = "after";
      else if (change === "approval") f.thread.status.activeFlags = ["waitingOnApproval"];
      else f.thread.turns[0].items.push({ ...msg("late"), ...(change === "question" ? { questions: ["Which?"] } : {}) });
      const receipt = f.cloud
        ? await sendDesktopCloudInput(id, wire, options, { home: f.home, connect: async () => f.server.client })
        : await sendOnClient(f.server.client, id, wire, options);
      mutated = true; return receipt;
    };
    await assert.rejects(tellWork(f.id, "reviewed instruction", {}, { storage: f, read: f.read, send }), error => ["WORK_TELL_STALE_SYNC", "WORK_TELL_HUMAN_REQUIRED"].includes(error.code));
    assert.equal(mutated, false);
    assert.equal(f.server.calls.some(c => c.method.startsWith("turn/")), false);
  });

  test(`${mode}: sync persists public full text, outputs and diffs through observe`, async t => {
    const f = await fixture(t, mode), long = "長".repeat(30000), output = "out".repeat(15000);
    f.thread.turns[0].items.push(msg("long", long), { id: "command", type: "commandExecution", command: "test", status: "completed", exitCode: 0, aggregatedOutput: output },
      { id: "file", type: "fileChange", status: "completed", changes: [{ path: "a", kind: "update", diff: long }] }, { id: "hidden", type: "reasoning", text: "private" });
    const result = await syncProject("adapter", { pageLimit: 2 }, { storage: f, read: f.read });
    assert.equal(result.complete, true);
    const events = await Promise.all(result.works[0].events.map(async e => (await projectEvent(e.token, f)).event));
    assert.equal(events.find(e => e.id === "long").text, long);
    assert.equal(events.find(e => e.id === "command").output, output);
    assert.equal(events.find(e => e.id === "file").changes[0].diff, long);
    assert.equal(events.some(e => e.type === "reasoning"), false);
  });

  test(`${mode}: real observation resolves flags and answered questions but preserves failure`, async t => {
    const f = await fixture(t, mode), sync = () => syncProject("adapter", {}, { storage: f, read: f.read });
    f.thread.status.activeFlags = ["waitingOnUserInput"];
    f.thread.turns[0].items.push({ ...msg("question"), questions: ["Which?"] });
    assert.equal((await sync()).works[0].attention, "human");
    f.thread.status.activeFlags = [];
    assert.equal((await sync()).works[0].attention, "human", "question needs answer evidence");
    f.thread.turns[0].items.push(user("human-answer"));
    assert.equal((await sync()).works[0].attention, "none");
    f.thread.turns[0].status = "failed"; f.thread.status = { type: "systemError" };
    assert.equal((await sync()).works[0].attention, "failure");
    f.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
    assert.equal((await sync()).works[0].attention, "human");
    f.thread.status.activeFlags = [];
    assert.equal((await sync()).works[0].attention, "failure", "empty flags cannot clear failure");
    f.thread.turns.push({ id: "recovery", status: "completed", items: [user("retry"), msg("done")] });
    f.thread.status = { type: "idle" };
    assert.equal((await sync()).works[0].attention, "review");
  });

  test(`${mode}: start's completed initial report is presented by next sync exactly once`, async t => {
    const f = await fixture(t, mode, false);
    await writeFile(`${f.home}/CODEXTEER.md`, "Keep scope focused.\n");
    f.thread.status = { type: "idle" }; f.thread.turns[0].status = "completed";
    const long = "initial conclusion".repeat(3000); f.thread.turns[0].items.push(msg("initial-result", long));
    // Creation is stubbed; initial observation and all subsequent reads use observe.
    await startWork({ project: "adapter", title: "short task", order: "investigate", root: f.home, connection: f.cloud ? "desktop-cloud" : "shared", ...(f.cloud ? { environment: "config" } : {}) }, {
      storage: f, resolveEnvironment: async () => ({ id: "config" }),
      create: async input => ({ thread_id: f.id, project_id: "adapter", environment_config_id: "config", attempt_id: input.attemptId,
        prompt_sha256: createHash("sha256").update(input.prompt).digest("hex") }), read: f.read,
    });
    assert.equal((await getManagedThread(f.id, f)).sync_cursor, undefined);
    const first = await syncProject("adapter", {}, { storage: f, read: f.read });
    assert.equal(first.complete, true); assert.equal(first.works[0].group, "検収待ち");
    const event = first.works[0].events.find(e => e.event_id === "initial-result"); assert.ok(event);
    assert.equal((await projectEvent(event.token, f)).event.text, long);
    assert.deepEqual((await syncProject("adapter", {}, { storage: f, read: f.read })).works[0].events, []);
  });
}
