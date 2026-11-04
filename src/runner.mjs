import { spawn } from "node:child_process";
import { targetHost } from "./target.mjs";
import { runRemoteCommand, runRemoteShellCommand } from "./remote-io.mjs";
import { dispatchExternalEffect } from "./supervision.mjs";

function startLocal(argv, { cwd, timeoutMs, onStart, signal: abortSignal }) {
  let accept, rejectAccept;
  const accepted = new Promise((resolve, reject) => { accept = resolve; rejectAccept = reject; });
  const completion = new Promise(resolve => {
    const started = new Date().toISOString();
    let output = "", truncated = false, timedOut = false, failure, startFailure, killer, timer, startUpdate = Promise.resolve(), closed = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const terminate = signal => { if (!child.pid || closed) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") failure ??= e; } };
    const stop = () => { terminate("SIGTERM"); killer ??= setTimeout(() => terminate("SIGKILL"), 1000); };
    const interrupt = () => { failure ??= Object.assign(new Error("Command interrupted."), { code: "CANCELLED" }); stop(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); abortSignal?.addEventListener("abort", interrupt, { once: true });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", data => { output += data; if (output.length > 32768) { truncated = true; output = output.slice(-32768); } }); }
    child.once("spawn", async () => {
      if (abortSignal?.aborted) interrupt();
      try { await onStart(child.pid); accept(); } catch (error) { failure = startFailure = error; stop(); }
    });
    child.once("error", error => { failure = error; accept(); });
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once("close", async (code, signal) => {
      closed = true; clearTimeout(timer); clearTimeout(killer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); abortSignal?.removeEventListener("abort", interrupt);
      await startUpdate;
      // A failed start is reported only after the child has exited, so callers
      // cannot release a resource lease while the child still runs.
      if (startFailure) rejectAccept(startFailure); else accept();
      resolve({ pid: child.pid ?? null, exit_code: code, signal, timed_out: timedOut, started_at: started, completed_at: new Date().toISOString(), output_tail: output, output_truncated: truncated, error: failure?.message ?? null, error_code: failure ? failure.code ?? null : null });
    });
  });
  return { accepted, completion };
}

// External-effect mutations (spawn/RPC dispatch) require an active supervisor.
// The lock ends at dispatch acceptance. Completion observation and result
// persistence are cleanup/reconciliation and remain allowed after pause/stop.
export async function runCommand(argv, { cwd, timeoutMs = 0, onStart = async () => {}, signal: abortSignal, execBackend = "app-server", threadId, remoteShell, supervisor, connection, ...storage } = {}) {
  if (!argv.length || !argv[0] || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86400000) throw Object.assign(new Error("A command and timeout-ms between 0 and 86400000 are required."), { code: "OPTIONS_INVALID" });
  if (!["app-server", "thread-shell"].includes(execBackend)) throw Object.assign(new Error("--exec-backend must be app-server or thread-shell."), { code: "OPTIONS_INVALID" });
  if (targetHost() !== "local") return (execBackend === "thread-shell" ? runRemoteShellCommand : runRemoteCommand)(argv, { cwd, timeoutMs, onStart, signal: abortSignal, threadId, shell: remoteShell, supervisor, connection });
  if (execBackend !== "app-server") throw Object.assign(new Error("thread-shell is an explicit remote execution backend."), { code: "OPTIONS_INVALID" });
  const dispatch = async () => { const ticket = startLocal(argv, { cwd, timeoutMs, onStart, signal: abortSignal }); await ticket.accepted; return ticket; };
  const ticket = threadId ? await dispatchExternalEffect(threadId, supervisor, "local-spawn", dispatch, { connection, ...storage }) : await dispatch();
  return ticket.completion;
}
