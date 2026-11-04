import { createHash } from "node:crypto";
import { readRecord, writeRecord, recordStats, removeRecord, withStoreLock } from "./store.mjs";
import { listManagedThreads } from "./project-index.mjs";
import { hostFields } from "./target.mjs";

export const HISTORY_LIMIT_BYTES = 256 * 1024 * 1024;
export const HISTORY_BATCH_BYTES = 16 * 1024 * 1024;
const buckets = ["project-sync-events", "project-sync-results", "work-starts"];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const key = project => createHash("sha256").update(project).digest("hex").slice(0, 40);

export function assertHistoryBatch(...values) {
  if (values.reduce((sum, value) => sum + bytes(value), 0) > HISTORY_BATCH_BYTES) throw failure("PROJECT_HISTORY_BATCH_LIMIT", "The full observation exceeds the 16 MiB batch limit. No cursor was advanced.");
}
async function usage(storage) {
  const stats = await Promise.all(buckets.map(bucket => recordStats(bucket, storage)));
  return { stats, bytes: stats.flat().reduce((sum, row) => sum + row.bytes, 0) };
}
function capacity(used, additional) {
  if (used + additional > HISTORY_LIMIT_BYTES) throw failure("PROJECT_HISTORY_LIMIT", "History storage is full. Run project prune --project ID; protected evidence is never truncated.", { storage_bytes: used, required_bytes: additional, limit_bytes: HISTORY_LIMIT_BYTES });
}
// Lock order: work-start OR project-publication -> history -> membership.
// prune acquires history only. No network/supervisor operations under history.
// Reservations include the pending head, result, detail copies and CAS-failure
// evidence; eight copies plus 1 MiB conservatively bound publication overhead.
export function withHistoryReservation(payload, action, storage = {}) {
  return withStoreLock("project-history", async () => {
    const used = await usage(storage);
    capacity(used.bytes, bytes(payload) * 8 + 1024 * 1024);
    let total = used.bytes;
    const sizes = new Map(used.stats.flatMap((rows, i) => rows.map(row => [`${buckets[i]}:${row.id}`, row.bytes])));
    const write = async (bucket, id, record, options = storage) => {
      const identifier = `${bucket}:${id}`, old = sizes.get(identifier) ?? 0;
      const size = bytes({ ...record, ...hostFields() }) + 1;
      capacity(total - old, size);
      await writeRecord(bucket, id, record, options); total += size - old; sizes.set(identifier, size);
    };
    return action(write);
  }, storage);
}
export function writeHistoryRecord(bucket, id, record, storage = {}) {
  return withStoreLock("project-history", async () => {
    const used = await usage(storage), index = buckets.indexOf(bucket);
    if (index < 0) throw failure("PROJECT_HISTORY_INVALID", "Unbudgeted history bucket.");
    const old = used.stats[index].find(row => row.id === id)?.bytes ?? 0;
    capacity(used.bytes - old, bytes({ ...record, ...hostFields() }) + 1);
    return writeRecord(bucket, id, record, storage);
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
  return withStoreLock("project-history", async () => {
    const before = await usage(storage), head = await readRecord("project-sync-heads", key(projectId), storage);
    const protectedTokens = references(head), members = await listManagedThreads(projectId, storage);
    const memberIds = new Set(members.map(member => member.thread_id));
    const latest = head?.sync_token ? await readRecord("project-sync-results", head.sync_token, storage) : null;
    references(latest, protectedTokens);
    // Keep the latest wait notification recoverable after a stdout/process loss.
    if (head?.wait_sync_token) references(await readRecord("project-sync-results", head.wait_sync_token, storage), protectedTokens);
    // Publication may have been interrupted before a result was saved. Pin all
    // records in its generation too, including durable pre-CAS evidence.
    const events = [];
    for (const row of before.stats[0]) {
      const record = await readRecord("project-sync-events", row.id, storage);
      events.push({ ...row, project_id: record.project_id, sync_token: record.sync_token, thread_id: record.thread_id });
      if (record.sync_token === head?.sync_token || record.sync_token === head?.wait_sync_token) protectedTokens.add(row.id);
    }
    let changed = true;
    while (changed) {
      const size = protectedTokens.size;
      for (const row of events) if (protectedTokens.has(row.id)) references(await readRecord("project-sync-events", row.id, storage), protectedTokens);
      changed = size !== protectedTokens.size;
    }
    const removedResults = new Set(), deleted = { events: 0, results: 0, initial_payloads: 0 };
    for (const row of before.stats[1]) {
      const result = await readRecord("project-sync-results", row.id, storage);
      if (result.project_id === projectId && row.id !== head?.sync_token && row.id !== head?.wait_sync_token) {
        // Remove continuation first: a crash cannot leave it pointing to deleted events.
        await removeRecord("project-sync-results", row.id, storage); removedResults.add(row.id); deleted.results++;
      }
    }
    for (const row of events) if (!protectedTokens.has(row.id)
      && (row.project_id === projectId || removedResults.has(row.sync_token) || (!row.project_id && memberIds.has(row.thread_id)))) {
      await removeRecord("project-sync-events", row.id, storage); deleted.events++;
    }
    for (const row of before.stats[2]) {
      const start = await readRecord("work-starts", row.id, storage), member = members.find(m => m.thread_id === start.thread_id);
      if (start.project_id === projectId && Array.isArray(start.initial_events) && member?.sync_cursor
        && head?.complete_work_ids?.includes(start.thread_id) && latest?.works?.some(work => work.thread_id === start.thread_id && work.complete && work.sync_revision === member.sync_revision)) {
        const { initial_events, ...receipt } = start;
        await writeRecord("work-starts", row.id, receipt, storage); deleted.initial_payloads++;
      }
    }
    const after = await usage(storage);
    return { project_id: projectId, deleted, storage_bytes: after.bytes, reclaimed_bytes: before.bytes - after.bytes, limit_bytes: HISTORY_LIMIT_BYTES,
      protected_sync_token: head?.sync_token ?? null, retention: "explicit-prune" };
  }, storage);
}
