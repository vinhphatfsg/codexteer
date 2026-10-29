import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { codexHome } from "./runtime.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { withStoreLock } from "./store.mjs";
import { BUNDLED_CLI } from "./wrapper.mjs";

// This is an offline rollout-format repair, not an App Server interrupt API.
// Only enable a version after the isolated replay test has verified its parser.
export const REPAIR_CLI_VERSIONS = Object.freeze(["0.162.0-alpha.17.2", "0.164.0-alpha.11.1"]);
const failure = (message, code) => Object.assign(new Error(message), { code });
const invalid = message => failure(message, "REPAIR_HISTORY_UNSUPPORTED");
const stamp = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
const identity = s => [s.dev, s.ino, s.size, s.uid, s.gid, s.mode, s.nlink].join(":");
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

async function owned(file, directory = false) {
  const s = await lstat(file);
  if (s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022)
    || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) {
    throw failure("Unsafe history path, ownership, permissions, or hard link.", "REPAIR_UNSAFE_PATH");
  }
  return s;
}

export async function findRepairRollout(home, threadId) {
  const found = [];
  async function walk(dir) {
    await owned(dir, true);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name.endsWith(`-${threadId}.jsonl`)) { await owned(file); found.push(file); }
      else if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) throw failure("A history directory contains a symbolic link; inspect it before repair.", "REPAIR_UNSAFE_PATH");
    }
  }
  for (const root of ["sessions", "archived_sessions"]) {
    try { await walk(path.join(home, root)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  if (found.length !== 1) throw failure(`Expected one rollout for this thread; found ${found.length}.`, "REPAIR_ROLLOUT_AMBIGUOUS");
  return found[0];
}

// Stream JSONL, parsing each record transiently. Return turn metadata and hashes,
// without including conversation item contents in the inspection report.
export async function scanRepairRollout(file, threadId) {
  const before = await owned(file), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256"), turns = new Map();
  let carry = Buffer.alloc(0), ordinal = 0, metadata, lastRoot;
  const parse = line => {
    let r;
    try { r = JSON.parse(line.toString("utf8")); } catch { throw invalid("History contains invalid JSON; nothing can be repaired automatically."); }
    if (r.ordinal !== ordinal++) throw invalid("History ordinals are missing or discontinuous.");
    if (ordinal === 1) {
      if (r.type !== "session_meta" || r.payload?.id !== threadId || r.payload?.history_mode !== "paginated") throw invalid("Repair requires this thread's paginated rollout metadata.");
      metadata = r.payload;
    } else if (r.type === "session_meta") throw invalid("Multiple session metadata records are not supported.");
    if (r.type !== "event_msg") return;
    const p = r.payload;
    if (p?.type === "task_started") {
      if (!uuid(p.turn_id) || turns.has(p.turn_id)) throw invalid("Repeated or unidentified turn starts cannot be repaired automatically.");
      const independent = (p.root_turn_id == null || p.root_turn_id === p.turn_id)
        && (!p.turn_attribution || (p.turn_attribution.turn_id === p.turn_id && (p.turn_attribution.root_turn_id == null || p.turn_attribution.root_turn_id === p.turn_id) && p.turn_attribution.parent_turn_id == null));
      const turn = { turn_id: p.turn_id, start_ordinal: r.ordinal, started_at: p.started_at ?? null, successor_id: null, terminal: null, independent };
      if (independent) { if (lastRoot) lastRoot.successor_id = p.turn_id; lastRoot = turn; }
      turns.set(p.turn_id, turn);
    } else if (["task_complete", "turn_aborted"].includes(p?.type)) {
      const t = turns.get(p.turn_id);
      if (!t || t.terminal) throw invalid("Unmatched or repeated terminal records need manual inspection.");
      t.terminal = p.type;
    }
  };
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw failure("History changed before inspection.", "REPAIR_HISTORY_CHANGED");
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      hash.update(chunk);
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let from = 0, end;
      while ((end = buffer.indexOf(10, from)) !== -1) {
        if (end - from > 64 * 1024 * 1024) throw invalid("A history record exceeds the repair size limit.");
        parse(buffer.subarray(from, end)); from = end + 1;
      }
      carry = Buffer.from(buffer.subarray(from));
      if (carry.length > 64 * 1024 * 1024) throw invalid("A history record exceeds the repair size limit.");
    }
    if (carry.length || !metadata) throw invalid("History is empty or ends with an incomplete record. Nothing was changed.");
    if (stamp(await handle.stat()) !== stamp(before) || stamp(await owned(file)) !== stamp(before)) throw failure("History changed during inspection. Retry after work has stopped.", "REPAIR_HISTORY_CHANGED");
    const unclosed = [...turns.values()].filter(t => !t.terminal);
    return { file, thread_id: threadId, source: before, sha256: hash.copy().digest("hex"), hash,
      next_ordinal: ordinal, candidates: unclosed.filter(t => t.independent && t.successor_id), unresolved_latest: unclosed.filter(t => !t.successor_id) };
  } finally { await handle.close(); }
}

export function repairProcessBlockers(stdout) {
  if (!stdout.trim()) throw failure("Empty process inventory; repair is blocked.", "REPAIR_OFFLINE_UNVERIFIED");
  return stdout.split("\n").filter(Boolean).flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) throw failure("Cannot parse process inventory; repair is blocked.", "REPAIR_OFFLINE_UNVERIFIED");
    const name = path.basename(match[2].trim());
    return /^(?:codex(?:[-_].*)?|chatgpt|codex desktop)$/i.test(name) ? [{ pid: Number(match[1]), executable: name }] : [];
  });
}

export function requireRepairOffline() {
  if (process.platform !== "darwin") throw failure("Offline repair is currently verified on macOS only.", "REPAIR_OFFLINE_UNVERIFIED");
  let output;
  try { output = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw failure("Cannot inspect processes. Run repair from an external terminal after quitting Codex.", "REPAIR_OFFLINE_UNVERIFIED"); }
  const blockers = repairProcessBlockers(output);
  if (blockers.length) throw failure(`Quit Codex/ChatGPT and all Codex CLI/app-server processes first (${blockers.map(p => `${p.executable} PID ${p.pid}`).join(", ")}). Run --apply from an external terminal; this command does not stop them.`, "REPAIR_REQUIRES_OFFLINE");
}

export function repairRuntimeVersion() {
  let version;
  try { version = execFileSync(BUNDLED_CLI, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().replace(/^codex-cli /, ""); }
  catch { throw failure("Cannot verify the bundled Codex parser version.", "REPAIR_RUNTIME_UNVERIFIED"); }
  if (!REPAIR_CLI_VERSIONS.includes(version)) throw failure(`Offline repair has not been verified with Codex ${version}. No history was changed.`, "REPAIR_RUNTIME_UNVERIFIED");
  return version;
}

function report(scan, apply) {
  return { thread_id: scan.thread_id, rollout_path: scan.file, mode: apply ? "apply" : "dry-run", status: scan.candidates.length ? "residual_candidates" : "no_residual_candidates",
    candidates: scan.candidates, unresolved_latest: scan.unresolved_latest, source_sha256: scan.sha256,
    history_changed: false, verification: "persisted-rollout-only", requires_offline: true,
    note: "Candidates have a later top-level turn start and no terminal record. The latest unfinished turn is never repaired. Live API idle/interrupted alone does not prove persisted repair." };
}

async function privateDirectory(dir) {
  await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
  const s = await owned(dir, true);
  if (s.mode & 0o077) throw failure("Repair backup directories must be private (0700).", "REPAIR_UNSAFE_PATH");
}

async function saveManifest(file, data) {
  const temp = `${file}.tmp`;
  const h = await open(temp, "wx", 0o600);
  try { await h.writeFile(JSON.stringify(data, null, 2) + "\n"); await h.sync(); } finally { await h.close(); }
  await rename(temp, file);
}

// Opening a writable descriptor can coincide with metadata-only changes (for
// example filesystem/provenance bookkeeping). A timestamp mismatch alone does
// not establish a content change. Hash the exact descriptor we will append to,
// while requiring stable identity, permissions and metadata throughout the read.
export async function verifyRepairAppendHandle(handle, file, scan) {
  const before = await handle.stat(), pathBefore = await owned(file);
  const details = { expected: stamp(scan.source), descriptor: stamp(before), path: stamp(pathBefore) };
  const changed = message => Object.assign(failure(message, "REPAIR_HISTORY_CHANGED"), { repair_stat: details });
  if (identity(before) !== identity(scan.source) || identity(pathBefore) !== identity(scan.source) || stamp(before) !== stamp(pathBefore)) {
    throw changed("History identity, size or permissions changed before append.");
  }
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 1024 * 1024 })) hash.update(chunk);
  if (hash.digest("hex") !== scan.sha256) throw changed("History contents changed before append.");
  const after = await handle.stat(), pathAfter = await owned(file);
  if (stamp(after) !== stamp(before) || stamp(pathAfter) !== stamp(before) || identity(after) !== identity(before) || identity(pathAfter) !== identity(before)) {
    throw changed("History changed while verifying the append descriptor.");
  }
  return { source: after, metadata_revalidated: stamp(before) !== stamp(scan.source) };
}

const openAppendHandle = file => open(file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);

export async function repairTurns(threadInput, { apply = false, home = codexHome() } = {},
  { offline = requireRepairOffline, runtimeVersion = repairRuntimeVersion, now = () => new Date(), openForAppend = openAppendHandle } = {}) {
  const threadId = normalizeThreadId(threadInput);
  home = await realpath(home); await owned(home, true);
  if (apply) { await offline(); await runtimeVersion(); }
  const work = async () => {
    const file = await findRepairRollout(home, threadId), scan = await scanRepairRollout(file, threadId), data = report(scan, apply);
    if (!apply || !scan.candidates.length) return data;
    // The trailing live/unfinished turn needs its own proper shutdown first.
    if (scan.unresolved_latest.length) throw failure("The latest turn also lacks a terminal record. Stop it normally before repairing older turns.", "REPAIR_LATEST_UNFINISHED");
    await offline();
    const version = await runtimeVersion(), repairedAt = now().toISOString();
    const append = Buffer.from(scan.candidates.map((t, i) => JSON.stringify({ timestamp: repairedAt, ordinal: scan.next_ordinal + i, type: "event_msg",
      payload: { type: "turn_aborted", turn_id: t.turn_id, root_turn_id: t.turn_id, reason: "interrupted", ...(t.started_at == null ? {} : { started_at: t.started_at }) },
    })).join("\n") + "\n");
    // Do not invent completed_at/duration_ms: the historical stop time is unknown.
    const expectedHash = scan.hash.copy().update(append).digest("hex");
    const root = path.join(home, "codex-steer"), backups = path.join(root, "turn-repairs");
    await privateDirectory(root); await privateDirectory(backups);
    const directory = path.join(backups, randomUUID()); await privateDirectory(directory);
    const backup = path.join(directory, "rollout.jsonl"), manifestFile = path.join(directory, "repair.json");
    await copyFile(file, backup, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const backupHandle = await open(backup, "r+");
    try { await backupHandle.chmod(0o600); await backupHandle.sync(); } finally { await backupHandle.close(); }
    const saved = await scanRepairRollout(backup, threadId);
    if (saved.sha256 !== scan.sha256) throw failure("Backup does not match inspected history. Original history was not changed.", "REPAIR_HISTORY_CHANGED");
    const manifest = { schema: 1, thread_id: threadId, rollout_path: file, backup_path: backup, repaired_at: repairedAt, cli_version: version,
      original_sha256: scan.sha256, expected_sha256: expectedHash, original_bytes: scan.source.size, append_utf8: append.toString("utf8"),
      repaired_turn_ids: scan.candidates.map(t => t.turn_id), status: "prepared" };
    await saveManifest(manifestFile, manifest);
    const dirHandle = await open(directory, "r"); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    let changed = false;
    try {
      await offline();
      if (await runtimeVersion() !== version || stamp(await owned(file)) !== stamp(scan.source)) throw failure("Runtime or history changed before repair.", "REPAIR_HISTORY_CHANGED");
      const h = await openForAppend(file);
      try {
        const verified = await verifyRepairAppendHandle(h, file, scan);
        // Hashing a large rollout takes time. Recheck process liveness and the
        // exact file immediately before the write, not just before the hash.
        await offline();
        if (stamp(await h.stat()) !== stamp(verified.source) || stamp(await owned(file)) !== stamp(verified.source)) throw failure("History changed after append verification.", "REPAIR_HISTORY_CHANGED");
        manifest.append_descriptor_sha256_verified = true;
        manifest.metadata_revalidated = verified.metadata_revalidated;
        changed = true; // A partial write is also a mutation and must be reported.
        await h.writeFile(append); await h.sync();
      } finally { await h.close(); }
      await offline();
      const after = await scanRepairRollout(file, threadId);
      if (after.sha256 !== expectedHash || after.candidates.length || after.unresolved_latest.length) throw failure("Post-repair history differs from the expected append. Inspect the backup and history before restarting Codex.", "REPAIR_VERIFICATION_FAILED");
      manifest.status = "verified"; await saveManifest(manifestFile, manifest);
      return { ...data, status: "repaired", history_changed: true, repaired_turn_ids: manifest.repaired_turn_ids,
        backup_path: backup, receipt_path: manifestFile, repaired_sha256: expectedHash, verification: "append-and-sha256-verified",
        note: "Missing terminal records were appended; prior bytes and ordinals are unchanged. Codex will project them on reload. Desktop rendering and the next live turn still need verification. Read/watch cursors should be refreshed." };
    } catch (e) {
      e.history_changed = changed; e.backup_path = backup; e.receipt_path = manifestFile;
      e.message += ` Backup: ${backup}. Do not retry or overwrite history blindly.`;
      throw e;
    }
  };
  return apply ? withStoreLock(`turn-repair-${threadId}`, work, { home }) : work();
}
