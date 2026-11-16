import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { desktopCloudService } from "../test-support/desktop-cloud-service.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { observeThread, readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { syncProject, projectEvent } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { writeRecord } from "../src/store.mjs";

const MiB = 1024 * 1024, id = "11111111-1111-4111-8111-000000000001", other = "22222222-2222-4222-8222-000000000002";
const message = (name, size = MiB) => ({ id: name, type: "agentMessage", text: `${name}:`.padEnd(size, "x") });
const backlog = (prefix, count) => Array.from({ length: count }, (_, n) => message(`${prefix}-${n}`));

async function local(t, ids = [id], fields = {}) {
  const home = await mkdtemp(tempPrefix("ct-backlog-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, threads = new Map();
  for (const thread of ids) {
    threads.set(thread, { id: thread, status: { type: "idle", activeFlags: [] }, turns: [{ id: `${thread}-turn-0`, status: "completed", items: [message(`${thread}-start`, 10)] }] });
    await registerManagedThread(thread, { projectId: "P", connection: "shared", syncCursor: readSnapshot(threads.get(thread)).cursor, ...fields }, storage);
  }
  const read = async (thread, options) => readSnapshot(threads.get(thread), options);
  return { storage, threads, read, sync: (options = {}) => syncProject("P", options, { storage, read }) };
}

// Syncs until the member's row is complete, keeping what each sync presented.
async function drain(f, thread, options = {}, limit = 12) {
  const rows = [], cursors = [];
  for (let n = 0; n < limit; n++) {
    const result = await f.sync(options), row = result.works.find(work => work.thread_id === thread);
    rows.push(row); cursors.push((await getManagedThread(thread, f.storage)).sync_cursor);
    if (row.complete) return { rows, cursors, result };
  }
  assert.fail(`the member stayed incomplete after ${limit} syncs: ${JSON.stringify(rows.map(row => row.error))}`);
}
const presented = rows => rows.flatMap(row => row.events.filter(event => event.type === "agentMessage").map(event => event.event_id));

for (const [name, options] of [["pages that together exceed one batch", { pageLimit: 3 }], ["one page that alone exceeds the batch", {}]]) {
  test(`a backlog larger than one history batch is published across syncs, from ${name}`, async t => {
    const f = await local(t), items = backlog("m", 24), before = (await getManagedThread(id, f.storage)).sync_cursor;
    f.threads.get(id).turns.push({ id: "turn-1", status: "completed", items });
    const { rows, cursors } = await drain(f, id, options);
    assert.ok(rows.length > 1, "more than one sync was needed");
    for (const row of rows.slice(0, -1)) {
      assert.equal(row.complete, false); assert.equal(row.cursor, null); assert.equal(row.error, "PROJECT_HISTORY_BACKLOG");
      assert.equal(row.history_gap, false); assert.ok(row.events.length > 0, "each incomplete sync presents part of the backlog");
    }
    assert.equal(new Set([before, ...cursors]).size, cursors.length + 1, "every sync moved the stored cursor");
    assert.deepEqual(presented(rows), items.map(item => item.id), "each event is presented once, in order");
    const token = rows[0].events.find(event => event.type === "agentMessage").token;
    assert.equal((await projectEvent(token, f.storage)).event.text, items[0].text, "the full event of an incomplete sync is kept");
  });
}

test("an event larger than one batch still refuses the read and keeps the cursor", async t => {
  const f = await local(t), before = (await getManagedThread(id, f.storage)).sync_cursor;
  f.threads.get(id).turns.push({ id: "turn-1", status: "completed", items: [message("small", 100), message("huge", 17 * MiB)] });
  const first = await f.sync({ pageLimit: 1 });
  assert.equal(first.works[0].error, "PROJECT_HISTORY_BACKLOG", "the events before it are published");
  const second = await f.sync({ pageLimit: 1 }), cursor = (await getManagedThread(id, f.storage)).sync_cursor;
  assert.equal(second.works[0].error, "PROJECT_HISTORY_BATCH_LIMIT"); assert.notEqual(cursor, before);
  await f.sync({ pageLimit: 1 });
  assert.equal((await getManagedThread(id, f.storage)).sync_cursor, cursor);
});

test("work tell reaches a member once syncs read its backlog, after a question answered inside the backlog", async t => {
  const policy = "Keep scope.\n", f = await local(t, [id], { policySha256: createHash("sha256").update(policy).digest("hex") });
  const root = await mkdtemp(tempPrefix("ct-backlog-root-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(`${root}/CODEXTEER.md`, policy);
  await registerSupervisor(id, "33333333-3333-4333-8333-000000000003", { ...f.storage, owner: "fixture", connection: "shared" });
  await writeRecord("work-starts", "fixture", { schema: 1, project_id: "P", thread_id: id, root, created_at: new Date().toISOString() }, f.storage);
  const thread = f.threads.get(id); thread.status = { type: "active", activeFlags: [] };
  thread.turns.push({ id: "turn-1", status: "inProgress", items: [{ ...message("question", 10), questions: ["Which?"] },
    { id: "answer", type: "userMessage", content: [{ type: "text", text: "This one." }] }, ...backlog("m", 20)] });
  let sent = 0;
  const tell = () => tellWork(id, "next", {}, { storage: f.storage, read: f.read, send: async (_id, _wire, options) => {
    await options.beforeSend(thread); sent++; return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-1" };
  } });
  assert.equal((await f.sync()).works[0].attention, "unknown", "the question and its answer were read in one batch");
  await assert.rejects(tell(), { code: "WORK_TELL_SYNC_INCOMPLETE" });
  await drain(f, id);
  await tell();
  assert.equal(sent, 1);
});

test("a wait probe that reads from an older baseline never moves the stored cursor back", async t => {
  const f = await local(t, [id, other]);
  await f.sync();
  f.threads.get(id).turns.push({ id: "turn-1", status: "completed", items: backlog("m", 40) });
  await f.sync(); await f.sync();
  const advanced = (await getManagedThread(id, f.storage)).sync_cursor;
  f.threads.get(other).turns.push({ id: "turn-1", status: "completed", items: [message("done", 10)] });
  const waited = await waitProject("P", { timeoutMs: 0 }, { storage: f.storage, read: f.read, processIdentity: async () => "same", orchestratorIdentity: async () => null, parentPid: () => 1 });
  assert.equal(waited.reason, "work_changed");
  assert.equal(waited.sync.works.find(work => work.thread_id === id).complete, false);
  assert.equal((await getManagedThread(id, f.storage)).sync_cursor, advanced);
});

test("a Desktop Cloud backlog larger than one batch is published across syncs and resumes in a new reader", async t => {
  const home = await mkdtemp(tempPrefix("ct-backlog-dc-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000901", task = `durable_${uuid}`, environment = "fixture~asenvcfg_1";
  const service = desktopCloudService(uuid, { environment });
  await registerManagedThread(task, { projectId: "P", connection: "desktop-cloud", environmentConfigId: environment }, storage);
  service.append([{ id: "opening", type: "userMessage", clientId: null, content: [{ type: "text", text: "order" }] }, message("first", 10)]);
  // Each sync connects anew, as each CLI call does.
  const read = (thread, options) => observeThread(thread, options, { connect: async () => new DesktopCloudClient(service.rpc) });
  const f = { storage, sync: (options = {}) => syncProject("P", options, { storage, read }) };
  assert.equal((await f.sync()).works[0].complete, true);
  const items = [];
  for (let n = 0; n < 6; n++) { const turn = backlog(`t${n}`, 4); items.push(...turn); service.append(turn); }
  service.append([{ id: "running", type: "userMessage", clientId: null, content: [{ type: "text", text: "go on" }] }], { status: "inProgress" });
  service.state.status = "active";
  const { rows } = await drain(f, task);
  assert.ok(rows.length > 1, "more than one sync was needed");
  assert.deepEqual(presented(rows), items.map(item => item.id), "each event is presented once, in order");
});

test("wait still returns turn ends of a member more than one batch past its baseline while another member stays unreadable", async t => {
  const f = await local(t, [id, other]); let broken = false;
  const read = async (thread, options) => { if (broken && thread === other) throw Object.assign(new Error("rejected"), { code: "RPC_REJECTED" }); return f.read(thread, options); };
  const wait = () => waitProject("P", { timeoutMs: 0 }, { storage: f.storage, read, processIdentity: async () => "same", orchestratorIdentity: async () => null, parentPid: () => 1, unreadGraceMs: 0 });
  assert.equal((await wait()).reason, "initial_sync");
  broken = true;
  f.threads.get(id).turns.push({ id: "turn-1", status: "completed", items: backlog("m", 40) });
  await drain({ ...f, sync: () => syncProject("P", {}, { storage: f.storage, read }) }, id);
  const reasons = [];
  while (reasons.length < 10 && reasons.slice(-2).join() !== "timeout,timeout") {
    const result = await wait();
    reasons.push(result.reason);
    assert.equal(result.unreadable.some(entry => entry.thread_id === id), false, "a member read one batch at a time is not unreadable");
  }
  assert.ok(reasons.includes("work_changed"), `the backlog's turn end is returned: ${reasons}`);
  assert.deepEqual(reasons.slice(-2), ["timeout", "timeout"], "then wait goes quiet");
  f.threads.get(id).turns.push({ id: "turn-2", status: "completed", items: [message("after", 10)] });
  const next = await wait();
  assert.equal(next.reason, "work_changed", "the next turn end is returned");
  const row = next.sync.works.find(work => work.thread_id === id);
  assert.equal(row.complete, true); assert.ok(row.events.some(event => event.event_id === "after"));
});

test("a wait that reads a backlog from behind the stored cursor keeps a later question a sync already found", async t => {
  const f = await local(t, [id, other]); let broken = false;
  const read = async (thread, options) => { if (broken && thread === other) throw Object.assign(new Error("rejected"), { code: "RPC_REJECTED" }); return f.read(thread, options); };
  const wait = () => waitProject("P", { timeoutMs: 0 }, { storage: f.storage, read, processIdentity: async () => "same", orchestratorIdentity: async () => null, parentPid: () => 1 });
  assert.equal((await wait()).reason, "initial_sync");
  broken = true;
  f.threads.get(id).turns.push({ id: "turn-1", status: "inProgress", items: [{ ...message("first", 10), questions: ["Which?"] },
    { id: "answer", type: "userMessage", content: [{ type: "text", text: "This one." }] }, ...backlog("m", 20), { ...message("second", 10), questions: ["And now?"] }] });
  const sync = () => syncProject("P", {}, { storage: f.storage, read });
  await drain({ ...f, sync }, id);
  assert.equal((await wait()).reason, "work_changed");
  assert.equal((await sync()).works.find(work => work.thread_id === id).attention, "human", "the open question stays in the head");
});

test("an orchestrator that syncs after each wait return reads a backlog through, without syncing on its own", async t => {
  const f = await local(t);
  const wait = () => waitProject("P", { timeoutMs: 0 }, { storage: f.storage, read: f.read, processIdentity: async () => "same", orchestratorIdentity: async () => null, parentPid: () => 1 });
  assert.equal((await wait()).reason, "initial_sync");
  const items = backlog("m", 40);
  f.threads.get(id).turns.push({ id: "turn-1", status: "completed", items });
  const reviewed = [];
  for (let n = 0; n < 10; n++) {
    const result = await wait();
    if (result.reason === "timeout") break;
    assert.equal(result.reason, "work_changed");
    reviewed.push(...presented(result.sync.works));
    const row = (await f.sync()).works[0];
    reviewed.push(...presented([row]));
    if (row.complete) break;
  }
  assert.equal((await f.sync()).works[0].complete, true);
  assert.deepEqual([...new Set(reviewed)], items.map(item => item.id), "every event reached the orchestrator");
});
