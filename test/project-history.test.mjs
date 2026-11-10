import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { readRecord, writeRecord, listRecords, storePath, recordStats } from "../src/store.mjs";
import { syncProject, projectEvent, continueProjectSync } from "../src/project-sync.mjs";
import { pruneProjectHistory, withHistoryReservation, writeHistoryRecord, assertHistoryBatch, HISTORY_LIMIT_BYTES, HISTORY_BATCH_BYTES } from "../src/project-history.mjs";
import { startWork } from "../src/work-start.mjs";
import { fail } from "../src/cli.mjs";

const id = "11111111-1111-4111-8111-000000000001", other = "22222222-2222-4222-8222-000000000002";
const key = name => createHash("sha256").update(name).digest("hex").slice(0,40);
const message = (name, text = name) => ({ id: name, type: "agentMessage", text });
async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-history-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, thread = { id, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [] }] };
  await registerManagedThread(id, { projectId: "history", connection: "shared", syncCursor: readSnapshot(thread).cursor }, storage);
  const read = async (_id, options) => readSnapshot(thread, options), sync = () => syncProject("history", {}, { storage, read });
  return { home, storage, thread, read, sync };
}

test("prune protects latest continuation/detail and old unresolved question evidence, expiring older tokens", async t => {
  const f = await fixture(t); f.thread.turns[0].items.push({ ...message("question", "Choose"), questions: ["Which?"] });
  const first = await f.sync(), questionToken = first.works[0].events[0].token;
  f.thread.turns[0].items.push(message("old", "x".repeat(30000))); const second = await f.sync(), oldToken = second.works[0].events.find(e => e.event_id === "old").token;
  f.thread.turns[0].items.push(message("new", "y".repeat(30000))); const latest = await f.sync();
  const result = await pruneProjectHistory("history", f.storage);
  assert.ok(result.reclaimed_bytes > 0); assert.ok(result.deleted.results >= 2);
  assert.equal((await projectEvent(questionToken, f.storage)).event.id, "question");
  assert.equal((await projectEvent(latest.works[0].detail_token, f.storage)).event.type, "workDetails");
  assert.equal((await continueProjectSync(latest.sync_token, {}, f.storage)).sync_token, latest.sync_token);
  await assert.rejects(projectEvent(oldToken, f.storage), { code: "PROJECT_EVENT_NOT_FOUND" });
  await assert.rejects(continueProjectSync(first.sync_token, {}, f.storage), { code: "PROJECT_SYNC_CONTINUATION_NOT_FOUND" });
  assert.equal((await getManagedThread(id, f.storage)).sync_cursor, latest.works[0].cursor);
});

test("prune preserves unpresented initial results and removes the duplicate payload only after publication", async t => {
  const f = await fixture(t); await writeFile(`${f.home}/CODEXTEER.md`, "Keep scope.\n");
  const thread = { id: other, status: { type: "idle" }, turns: [{ id: "short", status: "completed", items: [message("initial", "result".repeat(5000))] }] };
  await startWork({ project: "history", title: "short", order: "inspect", root: f.home }, {
    storage: f.storage, create: async () => ({ thread_id: other }), read: async (_id, options) => readSnapshot(thread, options),
  });
  await pruneProjectHistory("history", f.storage);
  assert.ok((await listRecords("work-starts", f.storage))[0].initial_events.length);
  const sync = await syncProject("history", {}, { storage: f.storage, read: async (target, options) => readSnapshot(target === other ? thread : f.thread, options) });
  const token = sync.works.find(w => w.thread_id === other).events.find(e => e.event_id === "initial").token;
  await pruneProjectHistory("history", f.storage);
  const receipt = (await listRecords("work-starts", f.storage))[0];
  assert.equal(receipt.initial_events, undefined); assert.ok(receipt.sync_cursor); assert.ok(receipt.prompt_sha256);
  assert.equal((await projectEvent(token, f.storage)).event.text, "result".repeat(5000));
});

test("prune keeps an interrupted publication generation and does not affect another project", async t => {
  const f = await fixture(t), old = await f.sync();
  const pinned = "11111111-1111-4111-8111-000000000003", unrelated = "11111111-1111-4111-8111-000000000004";
  await writeRecord("project-sync-events", pinned, { sync_token: "pending", project_id: "history", event: message("pending") }, f.storage);
  await writeRecord("project-sync-events", unrelated, { sync_token: "unrelated", project_id: "another", event: message("unrelated") }, f.storage);
  await writeRecord("project-sync-heads", key("history"), { sync_token: "pending", publication_pending: true, unresolved_attention: {} }, f.storage);
  await pruneProjectHistory("history", f.storage);
  assert.equal((await projectEvent(pinned, f.storage)).event.id, "pending");
  assert.equal((await projectEvent(unrelated, f.storage)).event.id, "unrelated");
  assert.equal(await readRecord("project-sync-results", old.sync_token, f.storage), null);
});

test("history quota is checked before cursor publication and initial receipts cannot bypass it", async t => {
  const f = await fixture(t), baseline = (await getManagedThread(id, f.storage)).sync_cursor;
  await writeRecord("project-sync-events", "filler", {}, f.storage);
  // A valid large JSON record, streamed in bounded memory. Quota accounting uses
  // file metadata, so it need not hydrate this payload to refuse the next write.
  const file = await open(storePath("project-sync-events", "filler", f.home), "w", 0o600), chunk = Buffer.alloc(1024 * 1024, 32);
  try { await file.write('{}'); for (let i = 0; i < 256; i++) await file.write(chunk); } finally { await file.close(); }
  f.thread.turns[0].items.push(message("new"));
  const full = await f.sync().catch(error => error);
  assert.equal(full.code, "PROJECT_HISTORY_LIMIT"); assert.equal(full.limit_bytes, HISTORY_LIMIT_BYTES);
  assert(full.storage_bytes >= 256 * 1024 * 1024 && full.required_bytes > 1024 * 1024);
  const numbers = { storage_bytes: full.storage_bytes, required_bytes: full.required_bytes, limit_bytes: full.limit_bytes };
  const printed = (t, json) => {
    const stream = t.mock.method(console, json ? "log" : "error", () => {}), priorExit = process.exitCode;
    try { fail(full, json); } finally { stream.mock.restore(); process.exitCode = priorExit; }
    return stream.mock.calls.map(call => call.arguments[0]);
  };
  const { error } = JSON.parse(printed(t, true)[0]);
  assert.equal(error.code, "PROJECT_HISTORY_LIMIT");
  assert.deepEqual({ storage_bytes: error.storage_bytes, required_bytes: error.required_bytes, limit_bytes: error.limit_bytes }, numbers);
  const text = printed(t, false);
  for (const [name, value] of Object.entries(numbers)) assert(text.includes(`${name}: ${value}`));
  assert.equal((await getManagedThread(id, f.storage)).sync_cursor, baseline);
  assert.equal((await listRecords("project-sync-results", f.storage)).length, 0);
  await assert.rejects(writeHistoryRecord("work-starts", "new", { initial_events: [message("x")] }, f.storage), { code: "PROJECT_HISTORY_LIMIT" });
  assert.equal(await readRecord("work-starts", "new", f.storage), null);
});

test("quota also bounds actual publication writes independently of conservative reservation", async t => {
  const f = await fixture(t);
  await assert.rejects(withHistoryReservation({}, async write => write("project-sync-results", "too-large", { text: "x".repeat(HISTORY_LIMIT_BYTES) }), f.storage), { code: "PROJECT_HISTORY_LIMIT" });
  assert.equal(await readRecord("project-sync-results", "too-large", f.storage), null);
});

test("prune and initial/sync persistence share a fail-closed lock; no protected record is removed mid-write", async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(r => { enter = r; }), gate = new Promise(r => { release = r; });
  const held = withHistoryReservation({}, async write => { enter(); await gate; await write("project-sync-results", "unpublished", { project_id: "history", works: [] }); }, f.storage);
  await entered;
  await assert.rejects(pruneProjectHistory("history", f.storage), { code: "RECORD_BUSY" });
  await assert.rejects(writeHistoryRecord("work-starts", "racing", {}, f.storage), { code: "RECORD_BUSY" });
  release(); await held;
  assert.ok(await readRecord("project-sync-results", "unpublished", f.storage));
});

test("project prune is available from local and Desktop Cloud CLI without contacting a backend", async t => {
  const f = await fixture(t); await f.sync();
  for (const connection of [[], ["--connection", "desktop-cloud"]]) {
    const result = spawnSync(process.execPath, ["bin/codexteer.mjs", ...connection, "project", "prune", "--project", "history", "--json"], { cwd: new URL("../", import.meta.url), env: { ...process.env, CODEX_HOME: f.home }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).command, "project.prune");
  }
});

test("legacy initial snapshots with an unproven tail stay pinned and cannot advance sync", async t => {
  const f = await fixture(t), thread = { id: other, status: { type: "idle" }, turns: [{ id: "legacy", status: "completed", items: Array.from({ length: 1100 }, (_, i) => message(`legacy-${i}`)) }] };
  await registerManagedThread(other, { projectId: "history", connection: "shared" }, f.storage);
  const observed = readSnapshot(thread, { limit: 1000, fullEvents: true });
  await writeHistoryRecord("work-starts", "legacy", { project_id: "history", thread_id: other, sync_cursor: observed.cursor, initial_events: observed.events }, f.storage);
  const result = await syncProject("history", {}, { storage: f.storage, read: async (target, options) => readSnapshot(target === other ? thread : f.thread, options) });
  assert.equal(result.complete, false); assert.equal(result.works.find(w => w.thread_id === other).history_gap, true);
  assert.equal((await getManagedThread(other, f.storage)).sync_cursor, undefined);
  await pruneProjectHistory("history", f.storage);
  assert.equal((await readRecord("work-starts", "legacy", f.storage)).initial_events.length, 1000);
});

test("legacy orphaned events are reclaimable after interruption removed their old result", async t => {
  const f = await fixture(t); await f.sync();
  const token = "11111111-1111-4111-8111-000000000005";
  await writeRecord("project-sync-events", token, { thread_id: id, sync_token: "removed-result", event: message("orphan") }, f.storage);
  await pruneProjectHistory("history", f.storage);
  await assert.rejects(projectEvent(token, f.storage), { code: "PROJECT_EVENT_NOT_FOUND" });
});

test("oversized real observation does not advance the saved sync cursor", async t => {
  const f = await fixture(t), baseline = (await getManagedThread(id, f.storage)).sync_cursor;
  f.thread.turns[0].items.push(message("too-big", "x".repeat(17 * 1024 * 1024)));
  const result = await f.sync();
  assert.equal(result.complete, false); assert.equal(result.works[0].error, "PROJECT_HISTORY_BATCH_LIMIT");
  assert.throws(() => assertHistoryBatch("x".repeat(HISTORY_BATCH_BYTES)), { code: "PROJECT_HISTORY_BATCH_LIMIT", required_bytes: HISTORY_BATCH_BYTES + 2, limit_bytes: HISTORY_BATCH_BYTES });
  assert.equal((await getManagedThread(id, f.storage)).sync_cursor, baseline);
  assert.equal((await listRecords("project-sync-events", f.storage)).some(row => row.event?.id === "too-big"), false);
});
