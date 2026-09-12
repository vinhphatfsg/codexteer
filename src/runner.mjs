import { spawn } from "node:child_process";

export function runCommand(argv, { cwd, timeoutMs = 0, onStart = async () => {}, signal: abortSignal } = {}) {
  if (!argv.length || !argv[0] || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86400000) throw new Error("A command and timeout-ms between 0 and 86400000 are required.");
  return new Promise((resolve, reject) => {
    const started = new Date().toISOString();
    let output = "", truncated = false, timedOut = false, failure, killer, timer, startUpdate = Promise.resolve(), closed = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const terminate = signal => {
      if (!child.pid || closed) return;
      try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") failure ??= e; }
    };
    const stop = () => { terminate("SIGTERM"); killer ??= setTimeout(() => terminate("SIGKILL"), 1000); };
    const interrupt = () => { failure ??= new Error("Command interrupted."); stop(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    abortSignal?.addEventListener("abort", interrupt, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", data => { output += data; if (output.length > 32768) { truncated = true; output = output.slice(-32768); } });
    }
    child.once("spawn", () => { if (abortSignal?.aborted) interrupt(); startUpdate = Promise.resolve(onStart(child.pid)).catch(e => { failure = e; stop(); }); });
    child.once("error", e => { failure = e; });
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once("close", async (code, signal) => {
      closed = true;
      clearTimeout(timer); clearTimeout(killer); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      abortSignal?.removeEventListener("abort", interrupt);
      await startUpdate;
      const result = { pid: child.pid ?? null, exit_code: code, signal, timed_out: timedOut, started_at: started, completed_at: new Date().toISOString(), output_tail: output, output_truncated: truncated, error: failure?.message ?? null };
      resolve(result);
    });
  });
}
