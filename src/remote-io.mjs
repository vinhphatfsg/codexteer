import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withRemoteClient, requirePairedManagement } from "./remote-management.mjs";
import { remoteControlConnection } from "./remote-control.mjs";
import { hostFields } from "./target.mjs";
import { fetchThread } from "./observe.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeThreadId } from "./thread-id.mjs";
import { withSupervisedMutation } from "./supervision.mjs";

const fail = (message, code = "REMOTE_FILESYSTEM_ERROR") => Object.assign(new Error(message), { code });
export const remotePathApi = value => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix;
export const resolveRemotePath = (cwd, value) => remotePathApi(cwd).resolve(cwd, value);
const within = (file, root) => { const relative = remotePathApi(root).relative(root, file); return relative === "" || (!relative.startsWith("..") && !remotePathApi(root).isAbsolute(relative)); };
const excluded = (file, excludes) => file.split(/[\\/]/).includes(".git") || excludes.some(root => within(file, root));
const hash = value => createHash("sha256").update(value).digest("hex");

async function metadata(client, file) {
  const value = await client.request("fs/getMetadata", { path: file });
  if (typeof value?.isFile !== "boolean" || typeof value.isDirectory !== "boolean" || typeof value.isSymlink !== "boolean" || !Number.isFinite(value.modifiedAtMs)) throw fail("Invalid remote file metadata.");
  if (value.isSymlink) throw fail("Remote symlinks cannot be fingerprinted without a canonical target API.", "REMOTE_SYMLINK_UNSUPPORTED");
  return value;
}

export async function remoteFingerprintFile(file, client) {
  requirePairedManagement();
  if (!remotePathApi(file).isAbsolute(file)) throw fail("Remote evidence requires an absolute path.");
  if (!client) return withRemoteClient(c => remoteFingerprintFile(file, c));
  const before = await metadata(client, file);
  if (!before.isFile) throw fail("Remote evidence must be a regular file.");
  const response = await client.request("fs/readFile", { path: file });
  if (typeof response?.dataBase64 !== "string" || response.dataBase64.length > 48 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.dataBase64)) throw fail("Remote evidence is invalid or exceeds its size limit.");
  const bytes = Buffer.from(response.dataBase64, "base64"), after = await metadata(client, file);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw fail("Remote evidence changed while reading.", "STALE_EVIDENCE");
  return { type: "file", ref: file, path: file, size: bytes.length, sha256: hash(bytes), mtime_ms: after.modifiedAtMs, ctime_ms: after.createdAtMs, ...hostFields() };
}

export async function remoteCaptureInputs(roots, excludes = [], { allowMissing = false, client } = {}) {
  if (!client) return withRemoteClient(c => remoteCaptureInputs(roots, excludes, { allowMissing, client: c }));
  const records = new Map();
  const visit = async file => {
    if (excluded(file, excludes) || records.has(file)) return;
    if (records.size >= 10000) throw fail("Remote checkpoint exceeds 10000 entries.");
    let info;
    try { info = await metadata(client, file); } catch (error) {
      // Generic RPC rejection is not proof of ENOENT. Preserve uncertainty.
      if (allowMissing && error.code === "ENOENT") return; throw error;
    }
    if (info.isDirectory) {
      records.set(file, { type: "directory", ref: file });
      const result = await client.request("fs/readDirectory", { path: file });
      if (!Array.isArray(result?.entries) || result.entries.some(e => typeof e.fileName !== "string" || !e.fileName || /^[.]{1,2}$/.test(e.fileName) || /[\\/\0]/.test(e.fileName))) throw fail("Invalid remote directory entries.");
      for (const entry of result.entries.sort((a, b) => a.fileName.localeCompare(b.fileName))) await visit(remotePathApi(file).join(file, entry.fileName));
    } else if (info.isFile) records.set(file, await remoteFingerprintFile(file, client));
    else throw fail("Remote snapshots require regular files or directories.");
  };
  for (const root of roots) await visit(root);
  const files = [...records.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  return { roots, excludes, files, digest: hash(JSON.stringify(files)) };
}

export async function remoteCheckpointScope(threadId, paths, excludes = []) {
  return withRemoteClient(async client => {
    const thread = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
    if (thread?.id !== threadId || typeof thread.cwd !== "string" || !remotePathApi(thread.cwd).isAbsolute(thread.cwd)) throw fail("Remote checkpoint task scope is unavailable.");
    return { cwd: thread.cwd, roots: [...new Set(paths.map(p => resolveRemotePath(thread.cwd, p)))], excludes: excludes.map(p => resolveRemotePath(thread.cwd, p)) };
  });
}

export async function remoteWatchInputs(snapshot, { route: makeRoute = remoteControlConnection } = {}) {
  requirePairedManagement(); const route = makeRoute(), runtime = await route.discover(), client = await route.connect(runtime.paths.socket);
  const touched = new Set(), ids = new Set(); let error = null;
  const notification = event => {
    if (event.method !== "fs/changed" || !ids.has(event.params?.watchId)) return;
    if (!Array.isArray(event.params.changedPaths)) { error = "Invalid remote watch event."; return; }
    for (const file of event.params.changedPaths) if (typeof file !== "string") error = "Invalid remote watch path.";
    else if (!excluded(file, snapshot.excludes) && snapshot.roots.some(root => within(file, root)) && touched.size < 100) touched.add(file);
  };
  client.on("notification", notification);
  try {
    for (const root of snapshot.roots) { const watchId = randomUUID(); ids.add(watchId); const result = await client.request("fs/watch", { path: root, watchId }); if (typeof result?.path !== "string") throw fail("Remote filesystem watch was not acknowledged."); }
    return { touched, get error() { return error ?? (client.isOpen() ? null : "Remote filesystem watch disconnected."); }, async close() {
      try { for (const watchId of ids) await client.request("fs/unwatch", { watchId }).catch(() => {}); } finally { client.off("notification", notification); client.close(); }
    } };
  } catch (error) { client.close(); throw error; }
}

export async function runRemoteCommand(argv, { cwd, timeoutMs = 0, signal, onStart = async () => {} } = {}, dependencies = {}) {
  requirePairedManagement(); const processId = randomUUID(), started = new Date().toISOString(), timeout = timeoutMs || 86400000;
  return withRemoteClient(async client => {
    if (signal?.aborted) throw fail("Remote command cancelled before dispatch.", "CANCELLED");
    // processId is connection scoped and only this invocation can terminate it.
    let cancelError = null;
    const cancel = () => { client.request("command/exec/terminate", { processId }, { mutation: true }).catch(error => { cancelError = error; }); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await onStart(null, { remote_process_id: processId, execution_backend: "app-server" });
      const result = await client.request("command/exec", { command: argv, ...(cwd ? { cwd } : {}), timeoutMs: timeout, outputBytesCap: 32768, processId }, { mutation: true });
      if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw Object.assign(fail("Remote command acknowledgement was invalid.", "REMOTE_COMMAND_UNKNOWN"), { uncertain: true });
      return { pid: null, remote_process_id: processId, ...hostFields(), exit_code: result.exitCode, signal: null, timed_out: false, started_at: started,
        completed_at: new Date().toISOString(), output_tail: (result.stdout + result.stderr).slice(-32768), output_truncated: result.stdout.length + result.stderr.length >= 32768,
        error: cancelError ? "Remote cancellation was not acknowledged." : signal?.aborted ? "Remote command interrupted." : null };
    } catch (error) { error.remote_process_id = processId; throw error; }
    finally { signal?.removeEventListener("abort", cancel); }
  }, { ...dependencies, timeoutMs: timeout + 10000 });
}

export function remoteShellScript(argv, { cwd, shell, marker }) {
  if (!["powershell", "posix"].includes(shell) || !/^[a-f0-9-]{36}$/.test(marker) || argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw fail("An explicit powershell or posix --shell and valid argv are required.", "REMOTE_SHELL_REQUIRED");
  const tag = `CODEXTEER_EXEC_${marker}`;
  if (shell === "powershell") {
    const q = value => `'${value.replaceAll("'", "''")}'`;
    return `$ErrorActionPreference='Stop'; $codexteerStatus=1; try { ${cwd ? `Set-Location -LiteralPath ${q(cwd)}; ` : ""}& ${argv.map(q).join(" ")}; $codexteerStatus=if ($null -eq $LASTEXITCODE) {0} else {$LASTEXITCODE} } catch { Write-Output $_.Exception.Message }; Write-Output ("\u0060n${tag}:" + $codexteerStatus); exit $codexteerStatus`;
  }
  const q = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `{ ${cwd ? `cd -- ${q(cwd)} && ` : ""}${argv.map(q).join(" ")}; }; codexteer_status=$?; printf '\\n${tag}:%s\\n' "$codexteer_status"; exit "$codexteer_status"`;
}

// This is an explicitly selected, task-scoped host shell (the official API is
// unsandboxed). Never use it as fallback for a refused command/exec request.
export async function runRemoteShellCommand(argv, { cwd, threadId, shell, timeoutMs = 0, signal, onStart = async () => {}, supervisor, connection } = {}, dependencies = {}) {
  requirePairedManagement();
  if (!threadId) throw fail("thread-shell requires --thread (checkpoint uses its own task).", "REMOTE_SHELL_REQUIRED");
  threadId = normalizeThreadId(threadId);
  const marker = randomUUID(), command = remoteShellScript(argv, { cwd, shell, marker }), tag = `CODEXTEER_EXEC_${marker}`, started = new Date().toISOString(), timeout = timeoutMs || 3600000;
  return withRemoteClient(async (client, runtime) => {
    const thread = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
    if (thread?.id !== threadId || !["idle", "notLoaded"].includes(thread.status?.type)) throw fail("Explicit thread-shell execution requires the selected task to be idle.", "REMOTE_SHELL_TASK_BUSY");
    if (signal?.aborted) throw fail("Remote shell cancelled before dispatch.", "CANCELLED");
    let accepted = false;
    try {
      await onStart(null, { remote_process_id: marker, execution_backend: "thread-shell", remote_shell: shell });
      // Recheck after every preparation await. Pause/stop shares this lock,
      // so it cannot acknowledge between this check and dispatch acceptance.
      // Release after the RPC receipt; an accepted command is not cancellable
      // through supervisor control and can still be observed while paused.
      const acknowledgement = await withSupervisedMutation(threadId, supervisor, () => {
        if (signal?.aborted) throw fail("Remote shell cancelled before dispatch.", "CANCELLED");
        return client.request("thread/shellCommand", { threadId, command, timeoutMs: timeout }, { mutation: true });
      }, { connection, home: runtime.paths.home }); accepted = true;
      if (!acknowledgement || typeof acknowledgement !== "object" || Array.isArray(acknowledgement)) throw fail("Remote shell acknowledgement was invalid. Inspect the same command before retrying.", "REMOTE_COMMAND_UNKNOWN");
      const deadline = Date.now() + timeout + 10000;
      do {
        if (signal?.aborted) throw fail("Remote shell observation interrupted; the host command may still run until its timeout.", "REMOTE_COMMAND_UNKNOWN");
        const history = await fetchThread(client, threadId);
        const matches = history.turns.flatMap(turn => turn.items ?? []).filter(item => item.type === "commandExecution" && item.command?.includes(tag));
        if (matches.length > 1) throw fail("Remote command identity was not unique.", "REMOTE_COMMAND_UNKNOWN");
        const item = matches[0];
        if (item && ["completed", "failed"].includes(item.status) && Number.isInteger(item.exitCode)) {
          const output = item.aggregatedOutput ?? "", markerLine = new RegExp(`^${tag}:(-?\\d+)\\r?$`, "gm"), markers = [...output.matchAll(markerLine)];
          if (markers.length !== 1 || Number(markers[0][1]) !== item.exitCode) throw fail("Remote shell exit status could not be correlated with its completion marker.", "REMOTE_COMMAND_UNKNOWN");
          // App Server aggregates stdout and stderr; stderr may follow the
          // stdout marker even though the command has already completed.
          const clean = output.replace(new RegExp(`^${tag}:-?\\d+\\r?\\n?`, "m"), "");
          return { pid: null, remote_process_id: marker, thread_id: threadId, execution_backend: "thread-shell", execution_permissions: "host-full-access", ...hostFields(),
            exit_code: item.exitCode, signal: null, timed_out: false, started_at: started, completed_at: new Date().toISOString(), output_tail: clean.slice(-32768), output_truncated: clean.length > 32768, error: null };
        }
        if (Date.now() >= deadline) break; await delay(250);
      } while (true);
      throw fail("Remote shell completion was not observed. Do not replay the command.", "REMOTE_COMMAND_UNKNOWN");
    } catch (error) { error.remote_process_id = marker; if (accepted) error.uncertain = true; throw error; }
  }, dependencies);
}
