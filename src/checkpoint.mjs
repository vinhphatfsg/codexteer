import { lstat, readdir, realpath, readlink } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprintFile, collectEvidence, verifyEvidence } from "./evidence.mjs";
import { digest } from "./observe.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { runCommand } from "./runner.mjs";

const within = (file, root) => file === root || file.startsWith(root + path.sep);
function excluded(file, excludes) { return file.split(path.sep).includes(".git") || excludes.some(x => within(file, x)); }

export async function captureInputs(roots, excludes = [], { allowMissing = false } = {}) {
  const records = new Map();
  async function visit(file) {
    if (excluded(file, excludes) || records.has(file)) return;
    let info;
    try { info = await lstat(file); } catch (e) { if (e.code === "ENOENT" && allowMissing) return; throw e; }
    if (info.isSymbolicLink()) {
      const target = await realpath(file), targetInfo = await lstat(target);
      if (targetInfo.isDirectory()) throw new Error("Directory symlinks are not snapshot inputs. Specify the real directory explicitly.");
      records.set(file, { ...await fingerprintFile(file), link: await readlink(file), mtime_ms: targetInfo.mtimeMs, ctime_ms: targetInfo.ctimeMs });
    } else if (info.isDirectory()) {
      records.set(file, { type: "directory", ref: file, mode: info.mode & 0o777 });
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    } else if (info.isFile()) records.set(file, { ...await fingerprintFile(file), mtime_ms: info.mtimeMs, ctime_ms: info.ctimeMs });
    else throw new Error("Snapshot inputs must be files or directories.");
  }
  for (const root of roots) await visit(root);
  const files = [...records.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  return { roots, excludes, files, digest: digest(files) };
}

function differences(before, after) {
  const a = new Map(before.files.map(f => [f.ref, digest(f)])), b = new Map(after.files.map(f => [f.ref, digest(f)]));
  return { added: [...b.keys()].filter(k => !a.has(k)), removed: [...a.keys()].filter(k => !b.has(k)), changed: [...a.keys()].filter(k => b.has(k) && a.get(k) !== b.get(k)) };
}

export async function getCheckpoint(threadInput, id, storage = {}) {
  const threadId = normalizeThreadId(threadInput), entry = await readRecord("checkpoints", id, storage);
  if (!entry || entry.thread_id !== threadId || entry.id !== id) throw new Error("Checkpoint not found for this task.");
  return entry;
}

export async function createCheckpoint(threadInput, name, { paths, excludes = [], cwd = process.cwd(), ...storage }) {
  const threadId = normalizeThreadId(threadInput);
  if (!name?.trim() || !paths?.length) throw new Error("capture requires a name and at least one --path.");
  const roots = [...new Set(paths.map(p => path.resolve(cwd, p)))], omit = excludes.map(p => path.resolve(cwd, p));
  const snapshot = await captureInputs(roots, omit);
  if (!snapshot.files.some(f => f.type === "file")) throw new Error("No input files were selected.");
  const entry = { schema: 1, id: randomUUID(), thread_id: threadId, name, cwd: path.resolve(cwd), created_at: new Date().toISOString(), snapshot, runs: [], artifacts: [] };
  await writeRecord("checkpoints", entry.id, entry, storage);
  return checkpointSummary(entry);
}

const withoutOutput = ({ output_tail, ...rest }) => rest;
export function checkpointSummary(entry, includeOutput = false) {
  return { ...entry, runs: includeOutput ? entry.runs : entry.runs.map(withoutOutput), snapshot: { ...entry.snapshot, files: undefined, file_count: entry.snapshot.files.filter(f => f.type === "file").length, directory_count: entry.snapshot.files.filter(f => f.type === "directory").length } };
}

export async function verifyCheckpoint(threadInput, id, storage = {}) {
  const entry = await getCheckpoint(threadInput, id, storage);
  const current = await captureInputs(entry.snapshot.roots, entry.snapshot.excludes, { allowMissing: true });
  const inputsCurrent = current.digest === entry.snapshot.digest;
  const latest = entry.runs.at(-1) ?? null;
  const artifacts = await Promise.all(entry.artifacts.map(async a => {
    try { await verifyEvidence([a]); return { ...a, current: true }; } catch { return { ...a, current: false }; }
  }));
  return { ...checkpointSummary(entry), inputs_current: inputsCurrent, differences: differences(entry.snapshot, current), artifacts,
    latest_run: latest ? withoutOutput(latest) : null, valid: inputsCurrent && latest?.status === "completed" && latest.exit_code === 0 && !latest.error && !latest.timed_out && latest.inputs_unchanged === true && artifacts.filter(a => a.run_id === latest.id).every(a => a.current) };
}

function watchInputs(snapshot) {
  const touched = new Set(), watchers = []; let error = null;
  const files = new Map(snapshot.files.map(f => [f.ref, f]));
  const dirs = [...new Set(snapshot.roots.map(r => files.get(r)?.type === "directory" ? r : path.dirname(r)))];
  try {
    for (const dir of dirs) {
      const watcher = watch(dir, { recursive: true }, (_, filename) => {
        const file = filename ? path.resolve(dir, filename.toString()) : dir;
        if (!excluded(file, snapshot.excludes) && (!filename || snapshot.roots.some(r => within(file, r)))) { if (touched.size < 100) touched.add(file); }
      });
      watcher.on("error", e => { error = e.message; }); watchers.push(watcher);
    }
  } catch (e) { for (const w of watchers) w.close(); throw e; }
  return { touched, get error() { return error; }, close() { for (const w of watchers) w.close(); } };
}

export async function runCheckpoint(threadInput, id, argv, { timeoutMs = 0, ...storage } = {}) {
  if (!argv.length || !argv[0] || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86400000) throw new Error("A command and timeout-ms between 0 and 86400000 are required.");
  const threadId = normalizeThreadId(threadInput);
  return withStoreLock(`checkpoint-${id}`, async () => {
    const entry = await getCheckpoint(threadId, id, storage), watcher = watchInputs(entry.snapshot);
    try {
      const before = await captureInputs(entry.snapshot.roots, entry.snapshot.excludes, { allowMissing: true });
      if (before.digest !== entry.snapshot.digest) throw new Error("Inputs changed since capture. Capture a new checkpoint before running.");
      const run = { id: randomUUID(), argv, status: "running", started_at: new Date().toISOString() };
      entry.runs.push(run); await writeRecord("checkpoints", id, entry, storage);
      const result = await runCommand(argv, { cwd: entry.cwd, timeoutMs, onStart: async pid => { run.pid = pid; await writeRecord("checkpoints", id, entry, storage); } });
      let after, snapshotError;
      try { after = await captureInputs(entry.snapshot.roots, entry.snapshot.excludes, { allowMissing: true }); } catch (e) { snapshotError = e.message; }
      Object.assign(run, result, { status: "completed", inputs_unchanged: after?.digest === entry.snapshot.digest && !watcher.touched.size && !watcher.error,
        touched_paths: [...watcher.touched], observation_error: watcher.error ?? snapshotError ?? null, differences: after ? differences(entry.snapshot, after) : null });
      await writeRecord("checkpoints", id, entry, storage);
      return { checkpoint_id: id, ...run, valid: run.exit_code === 0 && !run.error && !run.timed_out && run.inputs_unchanged };
    } finally { watcher.close(); }
  }, storage);
}

export async function attachArtifacts(threadInput, id, refs, storage = {}) {
  if (!refs.length) throw new Error("At least one --artifact file is required.");
  return withStoreLock(`checkpoint-${id}`, async () => {
    const verified = await verifyCheckpoint(threadInput, id, storage);
    if (!verified.valid) throw new Error("A successful run against unchanged inputs is required before attaching artifacts.");
    const artifacts = await collectEvidence(refs);
    if (artifacts.some(a => a.type !== "file")) throw new Error("Artifacts must be local files.");
    const entry = await getCheckpoint(threadInput, id, storage);
    entry.artifacts.push(...artifacts.map(a => ({ ...a, run_id: entry.runs.at(-1).id, attached_at: new Date().toISOString() })));
    await writeRecord("checkpoints", id, entry, storage);
    return checkpointSummary(entry);
  }, storage);
}

export async function listCheckpoints(threadInput, storage = {}) {
  const threadId = normalizeThreadId(threadInput);
  return (await listRecords("checkpoints", storage)).filter(c => c?.thread_id === threadId).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(entry => checkpointSummary(entry));
}
