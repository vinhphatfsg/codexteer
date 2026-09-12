import { lstat, mkdir, readFile, writeFile, rename, rm, readdir, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { codexHome, isAlive } from "./runtime.mjs";

const valid = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(value);
export function storePath(bucket, id, home = codexHome()) {
  if (!valid(bucket) || (id != null && !valid(id))) throw new Error("Invalid local record identifier.");
  return path.join(home, "codex-steer", bucket, ...(id == null ? [] : [`${id}.json`]));
}

async function owned(file, directory = false) {
  const s = await lstat(file);
  if (s.uid !== process.getuid() || s.isSymbolicLink() || (s.mode & 0o077) || (directory ? !s.isDirectory() : !s.isFile())) throw new Error("Unsafe local state ownership, permissions, or file type.");
}

async function directory(bucket, home, create = false) {
  const root = path.join(home, "codex-steer"), target = storePath(bucket, null, home);
  for (const p of [root, target]) {
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
  try { await writeFile(temp, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" }); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}

export async function listRecords(bucket, options = {}) {
  const home = options.home ?? codexHome(); let dir;
  try { dir = await directory(bucket, home); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const files = (await readdir(dir)).filter(x => x.endsWith(".json"));
  return Promise.all(files.map(x => readRecord(bucket, x.slice(0, -5), { home })));
}

export async function withStoreLock(key, fn, { home = codexHome() } = {}) {
  await directory("locks", home, true);
  const file = storePath("locks", key, home), token = randomUUID(), temp = `${file}.${token}.tmp`;
  await writeFile(temp, JSON.stringify({ token, pid: process.pid }), { mode: 0o600, flag: "wx" });
  let acquired = false;
  let outcome;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(temp, file); acquired = true; break; } catch (e) { if (e.code !== "EEXIST") throw e; }
      const old = await readRecord("locks", key, { home });
      if (old && !isAlive(old.pid)) {
        const recovery = `${file}.recover`;
        try { await mkdir(recovery, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; break; }
        try {
          const current = await readRecord("locks", key, { home });
          if (current?.token === old.token && !isAlive(current.pid)) await rm(file);
        } finally { await rm(recovery, { recursive: true }); }
      } else break;
    }
    if (!acquired) throw Object.assign(new Error("Another operation owns this local record. Retry after it finishes."), { code: "RECORD_BUSY" });
    outcome = await fn();
    return outcome;
  } finally {
    try {
      if (acquired && (await readRecord("locks", key, { home }))?.token === token) await rm(file);
      await rm(temp, { force: true });
    } catch { if (outcome && typeof outcome === "object") outcome.state_cleanup_required = true; }
  }
}
