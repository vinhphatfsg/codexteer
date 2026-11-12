import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { readRecord, writeRecord, recordStats, removeRecord, withStoreLock, storeLockHeld, listBuckets, storePath } from "./store.mjs";
import { listManagedThreads } from "./project-index.mjs";
import { hostFields } from "./target.mjs";

export const HISTORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const HISTORY_BATCH_BYTES = 16 * 1024 * 1024;
// How long one publication waits for its project's locks. Their other holders
// are one prune or one work start save: local file work over at most the
// quota, a few seconds for a quota of small records.
export const HISTORY_LOCK_WAIT_MS = 10_000;
const buckets = ["project-sync-events", "project-sync-results", "work-starts"];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
// The file writeRecord stores: host fields and the final newline included.
const stored = record => bytes({ ...record, ...hostFields() }) + 1;
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const key = project => createHash("sha256").update(project).digest("hex").slice(0, 40);
// Each project keeps its history in its own bucket of each history bucket, with
// its own quota and lock. The flat buckets hold what earlier versions wrote:
// read and pruned, never written anew and counted against no quota.
export const historyBucket = (bucket, projectId) => `${bucket}-${key(projectId)}`;
const lock = async (projectId, fn, storage) => {
  if (typeof projectId !== "string" || !projectId) throw failure("PROJECT_HISTORY_INVALID", "History belongs to a project.");
  return withStoreLock(`project-history-${key(projectId)}`, fn, storage);
};
// One project's unreadable or vanished earlier record never fails another project.
const legacyRows = (bucket, storage) => recordStats(bucket, { ...storage, skipUnreadable: true });
const readLegacy = (bucket, id, storage) => readRecord(bucket, id, storage).catch(() => null);

// The project's bucket, then the flat one. Without a project, every project's
// bucket: one that cannot be read is passed over unless it holds this record.
export async function readHistoryRecord(bucket, id, projectId, storage = {}) {
  if (projectId) return await readRecord(historyBucket(bucket, projectId), id, storage) ?? readRecord(bucket, id, storage);
  for (const name of await listBuckets(new RegExp(`^${bucket}-[0-9a-f]{40}$`), storage)) {
    try { const record = await readRecord(name, id, storage); if (record) return record; }
    catch (error) { if (await lstat(storePath(name, id, storage.home)).then(() => true, () => false)) throw error; }
  }
  return readRecord(bucket, id, storage);
}
// A record that also has an earlier copy in the flat bucket is read from the project's bucket.
export async function listHistoryRecords(bucket, projectId, storage = {}) {
  const own = await recordStats(historyBucket(bucket, projectId), storage), ids = new Set(own.map(row => row.id));
  const legacy = await Promise.all((await legacyRows(bucket, storage)).filter(row => !ids.has(row.id)).map(row => readLegacy(bucket, row.id, storage)));
  return [...await Promise.all(own.map(row => readRecord(historyBucket(bucket, projectId), row.id, storage))), ...legacy.filter(record => record?.project_id === projectId)];
}

export function assertHistoryBatch(...values) {
  const required = values.reduce((sum, value) => sum + bytes(value), 0);
  if (required > HISTORY_BATCH_BYTES) throw failure("PROJECT_HISTORY_BATCH_LIMIT", "The full observation exceeds the 16 MiB batch limit. No cursor was advanced.", { required_bytes: required, limit_bytes: HISTORY_BATCH_BYTES });
}
async function usage(projectId, storage) {
  const stats = await Promise.all(buckets.map(bucket => recordStats(historyBucket(bucket, projectId), storage)));
  return { stats, bytes: stats.flat().reduce((sum, row) => sum + row.bytes, 0) };
}
const limit = storage => storage.historyLimitBytes ?? HISTORY_LIMIT_BYTES;
function capacity(used, additional, storage, pruned, publishing = false) {
  if (used + additional > limit(storage)) throw failure("PROJECT_HISTORY_LIMIT", publishing
    ? "This project's history storage is full, and its old history is not pruned while the project is publishing. Retry after it finishes."
    : pruned ? "This project's history storage is full after pruning its old history. Protected evidence is never removed."
    : "This project's history storage is full. Run project prune --project ID; protected evidence is never truncated.",
    { storage_bytes: used, required_bytes: additional, limit_bytes: limit(storage), ...(pruned ? { history_pruned: pruned } : {}), ...(publishing ? { publication_in_progress: true } : {}) });
}
// Under the history lock. `records` lists every [bucket, id, record] about to be
// written. When they do not fit, the project's unprotected history is pruned
// once, here and never between the writes: a publication's own records are
// unprotected until its pending head names them. `earlier` is a prune the same
// command already made. `publishing` says the caller holds the project's
// publication lock.
async function room(records, projectId, storage, earlier = null, publishing = false) {
  const measure = used => {
    const sizes = new Map(used.stats.flatMap((rows, i) => rows.map(row => [`${buckets[i]}:${row.id}`, row.bytes])));
    return { total: used.bytes, sizes, need: records.reduce((sum, [bucket, id, record]) => sum + stored(record) - (sizes.get(`${bucket}:${id}`) ?? 0), 0) };
  };
  const before = await usage(projectId, storage);
  let state = measure(before), pruned = earlier, busy = false;
  if (state.total + state.need > limit(storage)) {
    const result = await prune(projectId, storage, before, publishing);
    if (result) {
      const { deleted, after, reclaimed } = result, sum = earlier ?? { deleted: { events: 0, results: 0, initial_payloads: 0 }, reclaimed_bytes: 0 };
      pruned = { deleted: Object.fromEntries(Object.entries(deleted).map(([kind, count]) => [kind, count + sum.deleted[kind]])), reclaimed_bytes: sum.reclaimed_bytes + reclaimed };
      state = measure(after);
    } else busy = true;
  }
  capacity(state.total, state.need, storage, pruned, busy);
  return { ...state, pruned };
}
// Lock order: work-start OR project-publication -> that project's history ->
// membership. A prune outside the publication's main path also takes, from
// under the history lock, that project's publication lock (against this order)
// and then the previous version's shared history lock. Store locks never wait:
// a held one fails as RECORD_BUSY, and attempt() turns that into pruning
// nothing or keeping the flat records, so no path waits on another while it
// holds a lock. A publication does wait for its own project's publication and
// history locks, in untilFree(): it holds neither between its tries, so a
// prune or a work start save that holds the history lock always ends. It
// never waits for another project's lock or the shared one. A wait that
// publishes keeps its project-wait lock meanwhile, which no holder of these
// two locks takes. The previous version takes work-start OR
// project-publication -> shared history -> membership. No network/supervisor
// operations under history.
export const lockDeadline = storage => performance.now() + (storage.historyLockWaitMs ?? HISTORY_LOCK_WAIT_MS);
// Runs `take` again while a lock it needs is busy, until `deadline`: at least
// once, and never again after `take` called `entered`, which it does once it
// holds its locks. A lock whose owner died is recovered by the try itself.
// While the history lock is held and the publication lock is free, a prune is
// about to try the publication lock: a try then would hold that lock for a
// moment, fail on the history lock and make the prune remove nothing.
export async function untilFree(projectId, deadline, take, storage = {}) {
  const pruneStarting = async () => await storeLockHeld(`project-history-${key(projectId)}`, storage) && !await storeLockHeld(`project-sync-${key(projectId)}`, storage);
  for (let pause = 2; ; pause = Math.min(pause * 2, 10)) {
    const last = performance.now() >= deadline;
    if (last || !await pruneStarting()) {
      let entered = false;
      try { return await take(() => { entered = true; }); }
      catch (error) { if (last || entered || error.code !== "RECORD_BUSY") throw error; }
    }
    await delay(Math.min(pause * (0.5 + Math.random()), Math.max(0, deadline - performance.now())));
  }
}
// Each of `records` is at least as large as what the action writes for it: once
// the first write succeeds, the rest fit. The action also receives what was pruned.
export function withHistoryReservation({ projectId, records = [], pruned, publishing = false }, action, storage = {}) {
  return lock(projectId, async () => {
    const reserved = await room(records, projectId, storage, pruned, publishing), { sizes } = reserved;
    let { total } = reserved;
    const write = async (bucket, id, record, options = storage) => {
      if (!buckets.includes(bucket)) throw failure("PROJECT_HISTORY_INVALID", "Unbudgeted history bucket.");
      const identifier = `${bucket}:${id}`, old = sizes.get(identifier) ?? 0, size = stored(record);
      capacity(total - old, size, storage);
      await writeRecord(historyBucket(bucket, projectId), id, record, options); total += size - old; sizes.set(identifier, size);
    };
    return action(write, reserved.pruned);
  }, storage);
}
// Resolves to what was pruned to make room, counting `pruned` from earlier writes.
export function writeHistoryRecord(bucket, id, record, storage = {}, pruned) {
  return lock(record.project_id, async () => {
    if (!buckets.includes(bucket)) throw failure("PROJECT_HISTORY_INVALID", "Unbudgeted history bucket.");
    const reserved = await room([[bucket, id, record]], record.project_id, storage, pruned);
    await writeRecord(historyBucket(bucket, record.project_id), id, record, storage);
    return reserved.pruned;
  }, storage);
}
function references(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  for (const [name, child] of Object.entries(value)) {
    if (["token", "detail_token"].includes(name) && typeof child === "string") result.add(child);
    else if (typeof child === "object") references(child, result);
  }
  return result;
}

export async function pruneProjectHistory(projectId, storage = {}) {
  if (typeof projectId !== "string" || !projectId) throw failure("PROJECT_HISTORY_INVALID", "project prune requires --project.");
  return lock(projectId, async () => {
    const before = await usage(projectId, storage), result = await prune(projectId, storage, before, false);
    if (!result) return { project_id: projectId, deleted: { events: 0, results: 0, initial_payloads: 0 }, storage_bytes: before.bytes, reclaimed_bytes: 0, limit_bytes: limit(storage),
      protected_sync_token: (await readRecord("project-sync-heads", key(projectId), storage))?.sync_token ?? null, retention: "explicit-prune", publication_in_progress: true };
    const { deleted, head, after, reclaimed } = result;
    return { project_id: projectId, deleted, storage_bytes: after.bytes, reclaimed_bytes: reclaimed, limit_bytes: limit(storage),
      protected_sync_token: head?.sync_token ?? null, retention: "explicit-prune" };
  }, storage);
}

// Takes a lock without waiting: null while another holds it.
async function attempt(name, fn, storage) {
  let entered = false;
  try { return { value: await withStoreLock(name, () => { entered = true; return fn(); }, storage) }; }
  catch (error) { if (entered || error.code !== "RECORD_BUSY") throw error; return null; }
}
// The head is final only while no publication of the project is between its
// pending and final head, which holding the project's publication lock proves;
// without it nothing is pruned (null). The previous version publishes flat
// records under one history lock shared by every project: they are removed or
// rewritten only while holding it, and otherwise left to a later prune.
async function prune(projectId, storage, before, publishing) {
  const rows = async () => (await attempt("project-history", () => pruneRows(projectId, storage, before, true), storage))?.value ?? pruneRows(projectId, storage, before, false);
  return publishing ? rows() : (await attempt(`project-sync-${key(projectId)}`, rows, storage))?.value ?? null;
}
// Under the project's history lock: what project prune and a publication at the
// quota remove, from the project's buckets and from the flat ones. Flat records
// always count toward protection. `reclaimed` counts both; only the first is the
// project's usage.
async function pruneRows(projectId, storage, before, flatWritable) {
  const head = await readRecord("project-sync-heads", key(projectId), storage);
  const protectedTokens = references(head), members = await listManagedThreads(projectId, storage);
  const memberIds = new Set(members.map(member => member.thread_id));
  const rows = await Promise.all(buckets.map(async (bucket, i) => [...before.stats[i].map(row => ({ ...row, bucket: historyBucket(bucket, projectId) })),
    ...(await legacyRows(bucket, storage)).map(row => ({ ...row, bucket, legacy: true }))]));
  const writable = row => !row.legacy || flatWritable;
  const read = row => row.legacy ? readLegacy(row.bucket, row.id, storage) : readRecord(row.bucket, row.id, storage);
  let legacyReclaimed = 0;
  const remove = async row => {
    try { await removeRecord(row.bucket, row.id, storage); } catch (error) { if (!row.legacy || error.code !== "ENOENT") throw error; return; }
    if (row.legacy) legacyReclaimed += row.bytes;
  };
  const result = token => readHistoryRecord("project-sync-results", token, projectId, storage);
  const latest = head?.sync_token ? await result(head.sync_token) : null;
  references(latest, protectedTokens);
  // Keep the latest wait notification recoverable after a stdout/process loss.
  if (head?.wait_sync_token) references(await result(head.wait_sync_token), protectedTokens);
  // Publication may have been interrupted before a result was saved. Pin all
  // records in its generation too, including durable pre-CAS evidence.
  const events = [];
  for (const row of rows[0]) {
    const record = await read(row);
    if (!record) continue;
    events.push({ ...row, project_id: record.project_id, sync_token: record.sync_token, thread_id: record.thread_id });
    if (record.sync_token === head?.sync_token || record.sync_token === head?.wait_sync_token) protectedTokens.add(row.id);
  }
  let changed = true;
  while (changed) {
    const size = protectedTokens.size;
    for (const row of events) if (protectedTokens.has(row.id)) references(await read(row), protectedTokens);
    changed = size !== protectedTokens.size;
  }
  const removedResults = new Set(), deleted = { events: 0, results: 0, initial_payloads: 0 };
  for (const row of rows[1]) {
    const result = await read(row);
    if (writable(row) && result?.project_id === projectId && row.id !== head?.sync_token && row.id !== head?.wait_sync_token) {
      // Remove continuation first: a crash cannot leave it pointing to deleted events.
      await remove(row); removedResults.add(row.id); deleted.results++;
    }
  }
  for (const row of events) if (writable(row) && !protectedTokens.has(row.id)
    && (row.project_id === projectId || removedResults.has(row.sync_token) || (!row.project_id && memberIds.has(row.thread_id)))) {
    await remove(row); deleted.events++;
  }
  for (const row of rows[2]) {
    const start = await read(row), member = members.find(m => m.thread_id === start?.thread_id);
    if (writable(row) && start?.project_id === projectId && Array.isArray(start.initial_events) && member?.sync_cursor
      && head?.complete_work_ids?.includes(start.thread_id) && latest?.works?.some(work => work.thread_id === start.thread_id && work.complete && work.sync_revision === member.sync_revision)) {
      const { initial_events, ...receipt } = start;
      await writeRecord(row.bucket, row.id, receipt, storage); deleted.initial_payloads++;
      if (row.legacy) legacyReclaimed += row.bytes - stored(receipt);
    }
  }
  const after = await usage(projectId, storage);
  return { deleted, head, after, reclaimed: before.bytes - after.bytes + legacyReclaimed };
}
