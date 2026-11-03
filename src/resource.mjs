import { randomUUID } from "node:crypto";
import { digest } from "./observe.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { normalizeTaskId } from "./task-id.mjs";
import { runCommand } from "./runner.mjs";
import { targetHost } from "./target.mjs";
import { withSupervisedMutation, withSupervisedCleanup } from "./supervision.mjs";

function resourceKey(name) {
  if (!name?.trim() || name.length > 200 || /[\r\n\x00-\x1f]/.test(name)) throw Object.assign(new Error("Resource name must be a non-empty single line (up to 200 characters)."), { code: "OPTIONS_INVALID" });
  return digest(name).slice(0, 40);
}
function validTtl(ttlMs) { if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw Object.assign(new Error("--ttl-ms must be between 1000 and 86400000."), { code: "OPTIONS_INVALID" }); }
function leaseState(entry, now = Date.now()) { return !entry ? "available" : entry.released_at ? "released" : Date.parse(entry.expires_at) <= now ? "expired" : "held"; }

export async function resourceStatus(name, { now = Date.now, ...storage } = {}) {
  const entry = await readRecord("resources", resourceKey(name), storage);
  return { name, state: leaseState(entry, now()), lease: entry };
}

export async function acquireResource(name, { owner, ttlMs = 600000, reason = "", condition = "", threadId, supervisor, connection, now = Date.now, ...storage }) {
  const key = resourceKey(name); validTtl(ttlMs);
  if (!owner?.trim()) throw Object.assign(new Error("--owner is required (for example claude-code or codex)."), { code: "OPTIONS_INVALID" });
  if (threadId) threadId = normalizeTaskId(threadId);
  const acquire = () => withStoreLock(`resource-${key}`, async () => {
    const current = await readRecord("resources", key, storage);
    if (leaseState(current, now()) === "held") throw Object.assign(new Error(`Resource is held by ${current.owner} until ${current.expires_at}.`), { code: "RESOURCE_BUSY" });
    const entry = { schema: 1, name, token: randomUUID(), owner, thread_id: threadId ?? null, reason, condition, claimed_at: new Date(now()).toISOString(), expires_at: new Date(now() + ttlMs).toISOString(), released_at: null };
    await writeRecord("resources", key, entry, storage); return entry;
  }, storage);
  return threadId ? withSupervisedMutation(threadId, supervisor, acquire, { connection, ...storage }) : acquire();
}

const notOwned = () => Object.assign(new Error("Lease is no longer owned by this token. Acquire it again after checking status."), { code: "RESOURCE_NOT_OWNED" });
async function renewLease(key, token, expectedThread, ttlMs, now, storage) {
  return withStoreLock(`resource-${key}`, async () => {
    const entry = await readRecord("resources", key, storage);
    if (!token || entry?.token !== token || entry.thread_id !== expectedThread || leaseState(entry, now()) !== "held") throw notOwned();
    entry.expires_at = new Date(now() + ttlMs).toISOString(); await writeRecord("resources", key, entry, storage); return entry;
  }, storage);
}

export async function renewResource(name, token, { ttlMs = 600000, threadId: claimedThread, supervisor, connection, now = Date.now, ...storage } = {}) {
  const key = resourceKey(name); validTtl(ttlMs);
  // Canonical binding comes from a non-locking lease read, never caller input.
  const before = await readRecord("resources", key, storage), threadId = before?.thread_id ?? null;
  if (!token || before?.token !== token || leaseState(before, now()) !== "held") throw notOwned();
  if (claimedThread !== undefined && normalizeTaskId(claimedThread) !== threadId) throw notOwned();
  const renew = () => renewLease(key, token, threadId, ttlMs, now, storage);
  return threadId ? withSupervisedMutation(threadId, supervisor, renew, { connection, ...storage }) : renew();
}

export async function releaseResource(name, token, { threadId: claimedThread, connection, now = Date.now, ...storage } = {}) {
  const key = resourceKey(name), before = await readRecord("resources", key, storage), threadId = before?.thread_id ?? null;
  if (!token || before?.token !== token) throw notOwned();
  if (claimedThread !== undefined && normalizeTaskId(claimedThread) !== threadId) throw notOwned();
  // Release is cleanup: it is allowed while paused/stopped, but the resource
  // lock rechecks both token and canonical thread before changing only released_at.
  const release = () => withStoreLock(`resource-${key}`, async () => {
    const entry = await readRecord("resources", key, storage);
    if (entry?.token !== token || entry.thread_id !== threadId) throw notOwned();
    entry.released_at ??= new Date(now()).toISOString(); await writeRecord("resources", key, entry, storage); return entry;
  }, storage);
  return threadId ? withSupervisedCleanup(threadId, release, { connection, ...storage }) : release();
}

// Only an already accepted run can reach this closure. It is deliberately not
// exported and performs no dispatch; pause/stop must not cancel lease upkeep.
const renewAcceptedLease = (name, token, threadId, ttlMs, now, connection, storage) => { const renew = () => renewLease(resourceKey(name), token, threadId, ttlMs, now, storage); return threadId ? withSupervisedCleanup(threadId, renew, { connection, ...storage }) : renew(); };

export async function listResources({ now = Date.now, ...storage } = {}) {
  return (await listRecords("resources", storage)).map(lease => ({ name: lease.name, state: leaseState(lease, now()), lease })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function runWithResource(name, argv, { timeoutMs = 0, cwd = targetHost() === "local" ? process.cwd() : undefined, ttlMs = 600000, execBackend, remoteShell, supervisor, connection, ...options }, { execute = runCommand } = {}) {
  if (!argv.length || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86400000) throw Object.assign(new Error("A command and valid --timeout-ms are required."), { code: "OPTIONS_INVALID" });
  const lease = await acquireResource(name, { ...options, ttlMs, supervisor, connection }), controller = new AbortController();
  let timer, renewal = Promise.resolve(), stopped = false, leaseError = null, released = false, result, uncertain = false;
  const schedule = () => { timer = setTimeout(() => {
    renewal = renewAcceptedLease(name, lease.token, lease.thread_id, ttlMs, Date.now, connection, options).then(() => { if (!stopped) schedule(); }).catch(e => { leaseError = e.message; controller.abort(); });
  }, Math.floor(ttlMs / 3)); };
  schedule();
  try { result = await execute(argv, { cwd, timeoutMs, signal: controller.signal, execBackend, remoteShell, threadId: options.threadId, supervisor, connection, ...options }); }
  catch (error) { uncertain = !!error.uncertain; if (uncertain) { error.resource = name; error.lease_retained = true; error.remote_execution_status = "unknown"; } throw error; }
  finally {
    stopped = true; clearTimeout(timer); await renewal;
    if (!uncertain) try { await releaseResource(name, lease.token, options); released = true; } catch (e) { leaseError ??= e.message; }
  }
  return { resource: name, owner: lease.owner, ...result, lease_error: leaseError, released, valid: !leaseError && result.exit_code === 0 && !result.error && !result.timed_out };
}
