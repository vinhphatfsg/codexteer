import { randomUUID } from "node:crypto";
import { digest } from "./observe.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { runCommand } from "./runner.mjs";

function resourceKey(name) {
  if (!name?.trim() || name.length > 200 || /[\r\n\x00-\x1f]/.test(name)) throw new Error("Resource name must be a non-empty single line (up to 200 characters).");
  return digest(name).slice(0, 40);
}
function validTtl(ttlMs) { if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw new Error("--ttl-ms must be between 1000 and 86400000."); }
function leaseState(entry, now = Date.now()) { return !entry ? "available" : entry.released_at ? "released" : Date.parse(entry.expires_at) <= now ? "expired" : "held"; }

export async function resourceStatus(name, { now = Date.now, ...storage } = {}) {
  const entry = await readRecord("resources", resourceKey(name), storage);
  return { name, state: leaseState(entry, now()), lease: entry };
}

export async function acquireResource(name, { owner, ttlMs = 600000, reason = "", condition = "", threadId, now = Date.now, ...storage }) {
  const key = resourceKey(name); validTtl(ttlMs);
  if (!owner?.trim()) throw new Error("--owner is required (for example claude-code or codex).");
  if (threadId) threadId = normalizeThreadId(threadId);
  return withStoreLock(`resource-${key}`, async () => {
    const current = await readRecord("resources", key, storage);
    if (leaseState(current, now()) === "held") throw Object.assign(new Error(`Resource is held by ${current.owner} until ${current.expires_at}.`), { code: "RESOURCE_BUSY" });
    const entry = { schema: 1, name, token: randomUUID(), owner, thread_id: threadId ?? null, reason, condition, claimed_at: new Date(now()).toISOString(), expires_at: new Date(now() + ttlMs).toISOString(), released_at: null };
    await writeRecord("resources", key, entry, storage);
    return entry;
  }, storage);
}

export async function renewResource(name, token, { ttlMs = 600000, now = Date.now, ...storage } = {}) {
  const key = resourceKey(name); validTtl(ttlMs);
  return withStoreLock(`resource-${key}`, async () => {
    const entry = await readRecord("resources", key, storage);
    if (!token || entry?.token !== token || leaseState(entry, now()) !== "held") throw new Error("Lease is no longer owned by this token. Acquire it again after checking status.");
    entry.expires_at = new Date(now() + ttlMs).toISOString();
    await writeRecord("resources", key, entry, storage); return entry;
  }, storage);
}

export async function releaseResource(name, token, { now = Date.now, ...storage } = {}) {
  const key = resourceKey(name);
  return withStoreLock(`resource-${key}`, async () => {
    const entry = await readRecord("resources", key, storage);
    if (!token || entry?.token !== token) throw new Error("Lease token does not match. Another owner's lease was not released.");
    entry.released_at ??= new Date(now()).toISOString();
    await writeRecord("resources", key, entry, storage); return entry;
  }, storage);
}

export async function listResources({ now = Date.now, ...storage } = {}) {
  return (await listRecords("resources", storage)).map(lease => ({ name: lease.name, state: leaseState(lease, now()), lease })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function runWithResource(name, argv, { timeoutMs = 0, cwd = process.cwd(), ttlMs = 600000, ...options }) {
  if (!argv.length || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86400000) throw new Error("A command and valid --timeout-ms are required.");
  const lease = await acquireResource(name, { ...options, ttlMs }), controller = new AbortController();
  let timer, renewal = Promise.resolve(), stopped = false, leaseError = null, released = false, result;
  const schedule = () => { timer = setTimeout(() => {
    renewal = renewResource(name, lease.token, { ...options, ttlMs }).then(() => { if (!stopped) schedule(); }).catch(e => { leaseError = e.message; controller.abort(); });
  }, Math.floor(ttlMs / 3)); };
  schedule();
  try { result = await runCommand(argv, { cwd, timeoutMs, signal: controller.signal }); }
  finally {
    stopped = true; clearTimeout(timer); await renewal;
    try { await releaseResource(name, lease.token, options); released = true; } catch (e) { leaseError ??= e.message; }
  }
  return { resource: name, owner: lease.owner, ...result, lease_error: leaseError, released, valid: !leaseError && result.exit_code === 0 && !result.error && !result.timed_out };
}
