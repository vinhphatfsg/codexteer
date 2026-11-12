import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject, projectEvent, continueProjectSync } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { startWork } from "../src/work-start.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { pruneProjectHistory, withHistoryReservation } from "../src/project-history.mjs";
import { readRecord, writeRecord, removeRecord, listRecords, recordStats, storePath } from "../src/store.mjs";

const KiB = 1024, MiB = 1024 * KiB, P = "alpha", Q = "beta";
const families = ["project-sync-events", "project-sync-results", "work-starts"];
const message = size => ({ id: randomUUID(), type: "agentMessage", text: "x".repeat(size) });
const idle = (id, items = []) => ({ id, name: id, status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed", items }] });
const headKey = project => createHash("sha256").update(project).digest("hex").slice(0, 40);
const tokens = page => page.works.flatMap(work => [work.detail_token, ...work.events.map(event => event.token)]).filter(Boolean);

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-isolation-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, f = { home, storage, threads: new Map(), member: { [P]: randomUUID(), [Q]: randomUUID() } };
  await writeFile(path.join(home, "CODEXTEER.md"), "Keep scope.\n");
  for (const project of [P, Q]) {
    const id = f.member[project], thread = idle(id); f.threads.set(id, thread);
    await registerManagedThread(id, { projectId: project, connection: "shared", syncCursor: readSnapshot(thread).cursor }, storage);
    await registerSupervisor(id, randomUUID(), { home, owner: "fixture", connection: "shared" });
  }
  f.read = async (id, options) => readSnapshot(f.threads.get(id), options);
  f.dependencies = { storage, read: f.read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  f.add = (project, count, size) => f.threads.get(f.member[project]).turns[0].items.push(...Array.from({ length: count }, () => message(size)));
  f.sync = project => syncProject(project, {}, f.dependencies);
  f.wait = project => waitProject(project, { timeoutMs: 0 }, f.dependencies);
  f.start = (project, title, size) => {
    const id = randomUUID(); f.threads.set(id, idle(id, [message(size)]));
    return startWork({ project, title, order: "inspect", root: home }, { storage, create: async () => ({ thread_id: id }), read: f.read });
  };
  f.tell = (project, body, options = {}) => tellWork(f.member[project], body, options, { storage, read: f.read,
    send: async (id, _wire, sent) => { await sent.beforeSend(f.threads.get(id)); return { sent: true, delivery_status: "accepted", client_message_id: sent.clientMessageId, turn_id: "turn-1" }; } });
  f.used = async () => { let sum = 0; for (const { bytes } of await rows(f)) sum += bytes; return sum; };
  return f;
}

// Every history record on disk, in the flat bucket that earlier versions used
// or in any other bucket of the same family.
async function rows(f) {
  const names = await readdir(path.dirname(storePath(families[0], null, f.home)));
  const result = [];
  for (const family of families) for (const bucket of names.filter(name => name === family || name.startsWith(`${family}-`))) {
    for (const row of await recordStats(bucket, f.storage)) result.push({ family, bucket, ...row });
  }
  return result;
}
// The previous version wrote the same records into the flat buckets: those
// `run` writes, or without it every record.
async function asPrevious(f, run) {
  const before = new Set(run ? (await rows(f)).map(row => `${row.bucket}/${row.id}`) : []), result = await run?.();
  for (const row of await rows(f)) if (row.bucket !== row.family && !before.has(`${row.bucket}/${row.id}`)) {
    const record = await readRecord(row.bucket, row.id, f.storage);
    await writeRecord(row.family, row.id, row.family === "work-starts" ? { ...record, receipt_path: storePath(row.family, row.id, f.home) } : record, f.storage);
    await removeRecord(row.bucket, row.id, f.storage);
  }
  return result;
}
async function corrupt(f, bucket) {
  const id = randomUUID(); await writeRecord(bucket, id, {}, f.storage); await writeFile(storePath(bucket, id, f.home), "{");
}
async function readable(f, page) {
  assert.equal((await continueProjectSync(page.sync_token, {}, f.storage)).sync_token, page.sync_token);
  for (const token of tokens(page)) assert.equal((await projectEvent(token, f.storage)).token, token);
}
async function gone(f, page) {
  await assert.rejects(continueProjectSync(page.sync_token, {}, f.storage), { code: "PROJECT_SYNC_CONTINUATION_NOT_FOUND" });
}

test("a project whose history fills its quota does not refuse another project's wait, sync or work start", async t => {
  const f = await fixture(t);
  f.add(P, 4, 256 * KiB); const first = await f.sync(P);
  f.add(P, 2, 256 * KiB); f.storage.historyLimitBytes = await f.used() + KiB;
  const refused = await f.sync(P).catch(error => error);
  assert.equal(refused.code, "PROJECT_HISTORY_LIMIT", "the full project is still held to its own quota");
  assert.equal(refused.storage_bytes, await f.used());
  f.add(Q, 2, 64 * KiB);
  const waited = await f.wait(Q);
  assert.equal(waited.sync.complete, true); assert.equal(waited.sync.history_pruned, undefined);
  f.add(Q, 1, 64 * KiB);
  const synced = await f.sync(Q);
  assert.equal(synced.complete, true); assert.equal(synced.history_pruned, undefined);
  const started = await f.start(Q, "next", 64 * KiB);
  assert.equal(started.observed, true); assert.equal(started.history_pruned, undefined);
  const pruned = await pruneProjectHistory(Q, f.storage);
  assert.ok(pruned.storage_bytes > 128 * KiB && pruned.storage_bytes < MiB, `storage_bytes ${pruned.storage_bytes} counts this project's history only`);
  await readable(f, first);
  for (const page of [waited.sync, synced]) await readable(f, page);
  assert.equal((await f.sync(P).catch(error => error)).code, "PROJECT_HISTORY_LIMIT");
});

test("another project's prune, manual or automatic, and its corrupt records never remove or fail this project's history", async t => {
  const f = await fixture(t);
  f.add(P, 1, 8 * KiB); const old = await f.sync(P);
  f.add(P, 1, 8 * KiB); const latest = await f.sync(P);
  const own = new Set((await rows(f)).map(row => row.bucket));
  for (const bucket of new Set([...own, ...families])) await corrupt(f, bucket);
  const before = await f.used();
  f.add(Q, 1, 8 * KiB); const replaced = await f.sync(Q);
  f.add(Q, 1, 8 * KiB); const kept = await f.sync(Q);
  const manual = await pruneProjectHistory(Q, f.storage);
  assert.equal(manual.deleted.results, 1); await gone(f, replaced); await readable(f, kept);
  f.add(Q, 1, 8 * KiB); const third = await f.sync(Q);
  f.storage.historyLimitBytes = await f.used() - before + KiB;
  f.add(Q, 1, 8 * KiB); const fourth = await f.sync(Q);
  assert.equal(fourth.complete, true); assert.equal(fourth.history_pruned.deleted.results, 1, "this project's own quota pruned its own history");
  await gone(f, kept); await readable(f, third); await readable(f, fourth);
  delete f.storage.historyLimitBytes;
  const started = await f.start(Q, "corrupt neighbour", 4 * KiB);
  assert.equal(started.observed, true);
  assert.equal((await f.tell(Q, "Continue with the tests.")).delivery_status, "accepted");
  await readable(f, old); await readable(f, latest);
});

test("every token resolves whichever layout holds its record, by token alone and through the project", async t => {
  const f = await fixture(t);
  f.add(P, 2, 4 * KiB); const waited = (await f.wait(P)).sync;
  f.add(P, 1, 4 * KiB); const earlier = await f.sync(P);
  f.add(Q, 1, 4 * KiB); const neighbour = await f.sync(Q);
  await asPrevious(f);
  for (const page of [waited, earlier, neighbour]) await readable(f, page);
  const head = await readRecord("project-sync-heads", headKey(P), f.storage);
  assert.equal(head.wait_sync_token, waited.sync_token);
  assert.equal((await continueProjectSync(head.wait_sync_token, {}, f.storage)).sync_token, waited.sync_token, "the wait result is recovered from the previous layout");
  assert.equal((await f.tell(P, "Basis in the previous layout.")).sync_token, earlier.sync_token);
  f.add(P, 1, 4 * KiB); const current = await f.sync(P);
  for (const page of [waited, earlier, neighbour, current]) await readable(f, page);
  assert.equal((await f.tell(P, "Basis in the current layout.", { syncToken: current.sync_token })).sync_token, current.sync_token);
  await assert.rejects(f.tell(P, "Named basis of another project.", { syncToken: neighbour.sync_token }), { code: "WORK_TELL_SYNC_CONFLICT" });
});

test("a store the previous layout wrote keeps working after the upgrade and its history is pruned per project", async t => {
  const f = await fixture(t);
  const startedP = await f.start(P, "earlier", 4 * KiB), startedQ = await f.start(Q, "earlier", 4 * KiB);
  f.add(P, 4, 64 * KiB); const replaced = (await f.wait(P)).sync;
  f.add(P, 1, 64 * KiB); const superseded = await f.sync(P);
  f.add(P, 1, 64 * KiB); const latest = await f.sync(P);
  f.add(Q, 2, 64 * KiB); const neighbour = await f.sync(Q);
  await asPrevious(f);
  const legacy = await f.used();
  assert.ok(legacy > 512 * KiB);
  f.storage.historyLimitBytes = 256 * KiB;
  f.add(P, 1, 64 * KiB); const upgraded = await f.sync(P);
  assert.equal(upgraded.complete, true); assert.equal(upgraded.history_pruned, undefined, "records of the previous layout count against no quota");
  for (const page of [replaced, superseded, latest, neighbour, upgraded]) await readable(f, page);
  const again = await f.start(P, "earlier", 4 * KiB);
  assert.equal(again.thread_id, startedP.thread_id); assert.equal(again.attempt_id, startedP.attempt_id);
  assert.equal((await f.tell(P, "After the upgrade.")).sync_token, upgraded.sync_token);
  delete f.storage.historyLimitBytes;
  const pruned = await pruneProjectHistory(P, f.storage);
  assert.equal(pruned.deleted.results, 2); assert.ok(pruned.deleted.events >= 6); assert.equal(pruned.deleted.initial_payloads, 1);
  assert.ok(pruned.reclaimed_bytes > 128 * KiB);
  await gone(f, superseded); await gone(f, latest);
  for (const page of [replaced, upgraded, neighbour]) await readable(f, page);
  const starts = await listRecords("work-starts", f.storage);
  assert.ok(starts.find(start => start.thread_id === startedQ.thread_id).initial_events, "another project's previous-layout records stay");
  assert.equal(starts.find(start => start.thread_id === startedP.thread_id).initial_events, undefined);
  assert.equal((await getManagedThread(startedP.thread_id, f.storage)).project_id, P);
});

test("after the upgrade the previous version still reads its own layout without error and a later run of this version continues", async t => {
  const f = await fixture(t);
  f.add(P, 1, 4 * KiB); const before = await asPrevious(f, () => f.sync(P));
  f.add(P, 1, 4 * KiB); const current = await f.sync(P);
  const head = await readRecord("project-sync-heads", headKey(P), f.storage);
  assert.equal(head.sync_token, current.sync_token);
  for (const family of families) { await listRecords(family, f.storage); await recordStats(family, f.storage); }
  await readRecord("project-sync-results", head.sync_token, f.storage);
  f.add(P, 1, 4 * KiB); const rolledBack = await asPrevious(f, () => f.sync(P));
  assert.equal((await readRecord("project-sync-results", rolledBack.sync_token, f.storage)).project_id, P, "the previous version's fresh result is in its layout");
  f.add(P, 1, 4 * KiB); const upgraded = await f.sync(P);
  assert.equal(upgraded.complete, true);
  for (const page of [before, current, rolledBack, upgraded]) await readable(f, page);
  assert.equal((await f.tell(P, "Upgraded again.")).sync_token, upgraded.sync_token);
  const pruned = await pruneProjectHistory(P, f.storage);
  assert.equal(pruned.deleted.results, 3);
  await readable(f, upgraded);
});

test("two projects publish, start and prune while the other holds its history lock", async t => {
  const f = await fixture(t);
  f.add(Q, 1, 4 * KiB);
  const inside = await withHistoryReservation({ projectId: P, records: [] }, async () => ({
    sync: await f.sync(Q), start: await f.start(Q, "concurrent", 4 * KiB), prune: await pruneProjectHistory(Q, f.storage) }), f.storage);
  assert.equal(inside.sync.complete, true); assert.equal(inside.sync.publication_conflict, undefined);
  assert.equal(inside.start.observed, true); assert.equal(inside.prune.project_id, Q);
  await readable(f, inside.sync);
});
