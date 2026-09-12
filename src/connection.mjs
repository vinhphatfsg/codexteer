import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { codexHome } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";

const failure = (message, code) => Object.assign(new Error(message), { code });
const reads = new Set(["thread/loaded/list", "thread/read", "thread/turns/list", "thread/items/list"]);
export function connectionMode(value = "shared") {
  if (!["shared", "desktop"].includes(value)) throw new Error("--connection must be shared or desktop.");
  return value;
}
export function desktopReadOnly() {
  return failure("The desktop connection supports observation only. Use the existing shared connection for sends; connections are never switched automatically.", "DESKTOP_READ_ONLY");
}

async function identity(home) {
  const directory = path.join(home, "app-server-control"), socket = path.join(directory, "app-server-control.sock");
  const fingerprint = [];
  for (const [file, type] of [[home, "home"], [directory, "directory"], [socket, "socket"]]) {
    const info = await lstat(file);
    if (info.uid !== process.getuid() || info.isSymbolicLink() || (info.mode & (type === "home" ? 0o022 : 0o077)) !== 0
      || (type === "socket" ? !info.isSocket() : !info.isDirectory())) {
      throw failure("Desktop control endpoint has unsafe ownership, permissions, or file type.", "DESKTOP_CONNECTION_UNSAFE");
    }
    // Home directory timestamps change for unrelated profile activity.
    fingerprint.push([info.dev, info.ino, type === "socket" ? info.ctimeMs : null]);
  }
  return { home, directory, socket, fingerprint: JSON.stringify(fingerprint) };
}

export async function discoverDesktopRuntime(home = codexHome()) {
  try {
    const paths = await identity(await realpath(home));
    return { paths, state: { codex_home: paths.home, native_observation_only: true } };
  } catch (error) {
    if (error.code === "ENOENT") throw failure("No existing Desktop control socket was found in this CODEX_HOME. Direct observation requires Desktop to be using its shared local daemon. This command does not start or restart it.", "DESKTOP_CONNECTION_UNAVAILABLE");
    if (["EPERM", "EACCES"].includes(error.code)) throw failure("Cannot inspect the Desktop control endpoint.", "PERMISSION_DENIED");
    throw error;
  }
}

async function stillCurrent(paths) {
  let current;
  try { current = await identity(paths.home); }
  catch (error) {
    if (error.code === "ENOENT") throw failure("The Desktop endpoint disappeared. Recheck the selected connection before observing again.", "DESKTOP_CONNECTION_CHANGED");
    throw error;
  }
  if (current.fingerprint !== paths.fingerprint) throw failure("The Desktop endpoint changed. Recheck the selected connection before observing again.", "DESKTOP_CONNECTION_CHANGED");
}

async function requireLoaded(client, threadId) {
  const seen = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await client.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || !result.data.every(id => typeof id === "string")
      || (result.nextCursor != null && (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)))) {
      throw failure("Invalid loaded-task list from Desktop.", "PROTOCOL_ERROR");
    }
    if (result.data.includes(threadId)) return;
    cursor = result.nextCursor;
    if (!cursor) throw failure("The target is not loaded in this Desktop endpoint. Select the matching profile and loaded task; codexteer will not resume it implicitly.", "DESKTOP_THREAD_NOT_LOADED");
    seen.add(cursor);
  }
  throw failure("The loaded-task list exceeded the observation limit.", "PROTOCOL_ERROR");
}

export async function connectDesktop(paths, options, connect = RpcClient.connect) {
  await stillCurrent(paths);
  const client = await connect(paths.socket, options);
  try { await stillCurrent(paths); } catch (error) { client.close(); throw error; }
  return {
    close: () => client.close(),
    async request(method, params = {}, requestOptions = {}) {
      if (!reads.has(method) || requestOptions.mutation) throw desktopReadOnly();
      await stillCurrent(paths);
      if (method !== "thread/loaded/list") {
        if (typeof params.threadId !== "string" || !params.threadId) throw failure("A target task is required for Desktop observation.", "PROTOCOL_ERROR");
        await requireLoaded(client, params.threadId);
        await stillCurrent(paths);
      }
      const result = await client.request(method, params, requestOptions);
      await stillCurrent(paths);
      return result;
    },
  };
}

// Each operation owns its discovery result. No implicit fallback to another
// profile, daemon, or wrapper, including after connection failures.
export function observationConnection(mode) {
  if (connectionMode(mode) === "shared") return {};
  let selected;
  return {
    async discover(home) {
      const discovered = await discoverDesktopRuntime(home);
      if (selected && (selected.paths.home !== discovered.paths.home || selected.paths.fingerprint !== discovered.paths.fingerprint)) {
        throw failure("The Desktop endpoint changed during observation. Check it before explicitly starting another watch.", "DESKTOP_CONNECTION_CHANGED");
      }
      selected = discovered; return selected;
    },
    async connect(socket, options) {
      if (!selected || selected.paths.socket !== socket) throw failure("Desktop discovery is required before connection.", "DESKTOP_CONNECTION_UNAVAILABLE");
      return connectDesktop(selected.paths, options);
    },
  };
}
