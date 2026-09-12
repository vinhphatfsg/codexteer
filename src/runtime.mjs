import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function codexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export async function runtimePaths(home = codexHome()) {
  const canonicalHome = await canonicalPath(path.resolve(home));
  const key = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 20);
  // macOS sockaddr_un allows only 104 bytes, including the trailing NUL.
  const root = `/private/tmp/codex-steer-${process.getuid()}`;
  const directory = path.join(root, key);
  const lease = path.join(directory, "lease");
  return { home: canonicalHome, root, directory, lease, state: path.join(lease, "state.json"), socket: path.join(lease, "rpc.sock"), control: path.join(lease, "ui.sock") };
}

async function canonicalPath(input) {
  try { return await realpath(input); } catch (error) {
    if (error.code !== "ENOENT" || path.dirname(input) === input) throw error;
    return path.join(await canonicalPath(path.dirname(input)), path.basename(input));
  }
}

async function checkOwned(file, type) {
  const info = await lstat(file);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.isSymbolicLink()
    || (type === "directory" ? !info.isDirectory() : type === "socket" ? !info.isSocket() : !info.isFile())) {
    throw new Error("Shared App Server runtime has unsafe ownership, permissions, or file type.");
  }
  return info;
}

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    // An inspection denial is not evidence of a dead process.
    throw new Error("Cannot verify the shared App Server process. Run this command from your terminal.");
  }
}

export async function readRuntime(paths) {
  for (const dir of [paths.root, paths.directory, paths.lease]) await checkOwned(dir, "directory");
  await checkOwned(paths.state, "file");
  const state = JSON.parse(await readFile(paths.state, "utf8"));
  if (state.schema !== 1 || state.codex_home !== paths.home || typeof state.instance !== "string" || !/^[0-9a-f-]{36}$/.test(state.instance)
    || !Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error("Invalid shared App Server runtime record.");
  return state;
}

export async function discoverRuntime(home) {
  const paths = await runtimePaths(home);
  let state;
  try { state = await readRuntime(paths); } catch (error) {
    if (error.code === "ENOENT") throw new Error("Shared App Server is unavailable. Finish current tasks, quit Desktop, then run: codex-steer desktop start");
    throw error;
  }
  if (!isAlive(state.pid) || !isAlive(state.server_pid) || !state.desktop_connected) {
    throw new Error("Shared App Server is not ready. Finish current tasks, quit Desktop, then run: codex-steer desktop start");
  }
  await checkOwned(paths.socket, "socket");
  await checkOwned(paths.control, "socket");
  return { paths, state };
}

export async function claimRuntime(home, details = {}) {
  const paths = await runtimePaths(home);
  for (const dir of [paths.root, paths.directory]) {
    await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await checkOwned(dir, "directory");
  }
  try { await mkdir(paths.lease, { mode: 0o700 }); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = await readRuntime(paths);
    if (isAlive(old.pid) || isAlive(old.server_pid)) throw new Error("A shared App Server already owns this CODEX_HOME.");
    const recovery = path.join(paths.directory, `recover-${old.instance}`);
    await mkdir(recovery, { mode: 0o700 });
    try {
      const current = await readRuntime(paths);
      if (current.instance !== old.instance || isAlive(current.pid) || isAlive(current.server_pid)) {
        throw new Error("Shared App Server ownership changed during startup. Retry once startup finishes.");
      }
      const stale = path.join(recovery, "stale");
      await rename(paths.lease, stale);
      await mkdir(paths.lease, { mode: 0o700 });
    } finally { await rm(recovery, { recursive: true, force: true }); }
  }
  let state = { schema: 1, instance: randomUUID(), codex_home: paths.home, pid: process.pid, server_pid: null, desktop_connected: false, ...details };
  let writes = Promise.resolve();
  const update = patch => {
    state = { ...state, ...patch };
    const snapshot = JSON.stringify(state);
    writes = writes.then(async () => {
      const temp = `${paths.state}.${state.instance}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, paths.state);
    });
    return writes;
  };
  await update({});
  return {
    paths, update,
    async release() {
      await writes.catch(() => {});
      const current = await readRuntime(paths).catch(() => null);
      if (current?.instance === state.instance) await rm(paths.lease, { recursive: true, force: true });
    },
  };
}
