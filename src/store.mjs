import { lstat, mkdir, readFile, writeFile, rename, rm, readdir, link } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { codexHome, isAlive } from "./runtime.mjs";
import { hostNamespace, hostFields } from "./target.mjs";

const valid = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(value);
// The persisted namespace predates the codexteer rename; keep existing records.
const root = home => { const namespace = hostNamespace(); return path.join(home, "codex-steer", ...(namespace ? ["hosts", namespace] : [])); };
export function storePath(bucket, id, home = codexHome()) {
  if (!valid(bucket) || (id != null && !valid(id))) throw Object.assign(new Error("Invalid local record identifier."), { code: "OPTIONS_INVALID" });
  return path.join(root(home), bucket, ...(id == null ? [] : [`${id}.json`]));
}

// Names only; each bucket's ownership is checked when one of its records is read.
export async function listBuckets(pattern, options = {}) {
  let entries;
  try { entries = await readdir(root(options.home ?? codexHome()), { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return entries.filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name).sort();
}

async function owned(file, directory = false) {
  const s = await lstat(file);
  if (s.uid !== process.getuid() || s.isSymbolicLink() || (s.mode & 0o077) || (directory ? !s.isDirectory() : !s.isFile())) throw Object.assign(new Error("Unsafe local state ownership, permissions, or file type."), { code: "STORE_UNSAFE" });
}

async function directory(bucket, home, create = false) {
  const root = path.join(home, "codex-steer"), target = storePath(bucket, null, home);
  const namespace = hostNamespace();
  for (const p of [root, ...(namespace ? [path.join(root, "hosts"), path.join(root, "hosts", namespace)] : []), target]) {
    if (create) await mkdir(p, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    await owned(p, true);
  }
  return target;
}

export async function readRecord(bucket, id, { home = codexHome() } = {}) {
  try {
    await directory(bucket, home);
    const file = storePath(bucket, id, home); await owned(file);
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeRecord(bucket, id, data, { home = codexHome() } = {}) {
  await directory(bucket, home, true);
  const target = storePath(bucket, id, home), temp = `${target}.${randomUUID()}.tmp`;
  await owned(target).catch(e => { if (e.code !== "ENOENT") throw e; });
  try { await writeFile(temp, JSON.stringify({ ...data, ...hostFields() }) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}

export async function listRecords(bucket, options = {}) {
  const home = options.home ?? codexHome(); let dir;
  try { dir = await directory(bucket, home); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const files = (await readdir(dir)).filter(x => x.endsWith(".json"));
  return Promise.all(files.map(x => readRecord(bucket, x.slice(0, -5), { home })));
}

export async function withStoreLock(key, fn, { home = codexHome() } = {}) {
  return withRecordLock("locks", key, fn, { home });
}

async function withRecordLock(bucket, key, fn, { home }) {
  await directory(bucket, home, true);
  const file = storePath(bucket, key, home), token = randomUUID(), temp = `${file}.${token}.tmp`;
  await writeFile(temp, JSON.stringify({ token, pid: process.pid }), { mode: 0o600, flag: "wx" });
  let acquired = false;
  let outcome;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(temp, file); acquired = true; break; } catch (e) { if (e.code !== "EEXIST") throw e; }
      const old = await readRecord(bucket, key, { home });
      if (old && !isAlive(old.pid)) {
        // Serialize deletion of this generation, including recovery of a crashed
        // recoverer. Each nested lock has an atomically published PID + token.
        // A finite chain of dead owners ends at an absent recovery lock.
        // Legacy .recover directories have no owner and are unsupported/inert.
        // Stop all old-version operations (including saved supervisor CLIs)
        // sharing this CODEX_HOME before using this recovery protocol.
        const recoveryKey = createHash("sha256").update(String(old.token)).digest("hex");
        await withRecordLock("lock-recovery", recoveryKey, async () => {
          const current = await readRecord(bucket, key, { home });
          if (current?.token === old.token && !isAlive(current.pid)) await rm(file);
        }, { home });
      } else break;
    }
    if (!acquired) throw Object.assign(new Error("Another operation owns this local record. Retry after it finishes."), { code: "RECORD_BUSY" });
    outcome = await fn();
    return outcome;
  } finally {
    try {
      if (acquired && (await readRecord(bucket, key, { home }))?.token === token) await rm(file);
      await rm(temp, { force: true });
    } catch { if (outcome && typeof outcome === "object") outcome.state_cleanup_required = true; }
  }
}

// Metadata-only enumeration for quota accounting; never hydrate historical payloads.
// `skipUnreadable` leaves out what cannot be listed safely instead of failing.
export async function recordStats(bucket, options = {}) {
  let dir;
  try { dir = await directory(bucket, options.home ?? codexHome()); } catch (e) { if (e.code === "ENOENT" || options.skipUnreadable) return []; throw e; }
  const result = [];
  for (const file of (await readdir(dir)).filter(x => x.endsWith(".json"))) {
    const id = file.slice(0, -5); const target = storePath(bucket, id, options.home);
    try { await owned(target); result.push({ id, bytes: (await lstat(target)).size }); } catch (e) { if (!options.skipUnreadable) throw e; }
  }
  return result;
}

export async function removeRecord(bucket, id, options = {}) {
  await directory(bucket, options.home ?? codexHome());
  const file = storePath(bucket, id, options.home); await owned(file); await rm(file);
}
