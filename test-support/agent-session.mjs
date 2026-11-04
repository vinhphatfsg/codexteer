import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exec = promisify(execFile);

// A local stand-in for the interactive CLI. Commands are real child processes;
// no account, model or user profile is involved.
export async function agentSessionMain() {
  const waits = new Map(), bin = process.env.CT_SESSION_BIN;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async line => {
    const { id, action, args, pid } = JSON.parse(line);
    let result;
    try {
      if (action === "run") {
        try { result = { ...await exec(process.execPath, [bin, ...args], { timeout: 10000 }), code: 0 }; }
        catch (error) { result = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
      } else if (action === "hook") {
        const settings = JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]);
        const command = settings.hooks.Stop.at(-1).hooks[0].command;
        result = await exec("/bin/sh", ["-c", command], { timeout: 10000 });
      } else if (action === "wait") {
        const child = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        const closed = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
        waits.set(child.pid, { child, closed }); result = child.pid;
      } else if (action === "result") result = await waits.get(pid).closed;
      else if (action === "kill") { waits.get(pid).child.kill("SIGKILL"); result = await waits.get(pid).closed; }
      else throw new Error("Unknown fixture action");
      process.stdout.write(JSON.stringify({ id, result }) + "\n");
    } catch (error) { process.stdout.write(JSON.stringify({ id, error: error.message }) + "\n"); }
  });
  lines.on("close", async () => {
    for (const { child } of waits.values()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all([...waits.values()].map(wait => wait.closed));
    process.exit(0);
  });
}

export async function startAgentSession({ home, env, bin, direct = false }) {
  const directory = path.join(home, "agent-bin"); await mkdir(directory, { recursive: true });
  const agent = path.join(directory, "claude");
  await symlink(bin, path.join(directory, "codexteer")).catch(error => { if (error.code !== "EEXIST") throw error; });
  await writeFile(agent, `#!${process.execPath}\nimport(${JSON.stringify(fileURLToPath(import.meta.url))}).then(m => m.agentSessionMain());\n`, { mode: 0o700 });
  const child = spawn(process.execPath, direct
    ? [bin, "orchestrate", "--project", "P", "goal", "--use-path-cli"] : [agent], {
    env: { ...env, CT_SESSION_BIN: bin, PATH: directory + path.delimiter + (env.PATH ?? "") }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close"), pending = new Map(); let next = 0, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result);
  });
  child.on("close", code => { for (const p of pending.values()) p.reject(new Error(`Fixture exited ${code}: ${stderr}`)); pending.clear(); });
  const request = (action, data = {}) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, action, ...data }) + "\n");
  });
  return { request, close: async () => { child.stdin.end(); await closed; } };
}
