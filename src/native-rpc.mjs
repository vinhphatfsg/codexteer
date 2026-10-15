import net from "node:net";
import os from "node:os";
import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BUNDLED_NODE } from "./wrapper.mjs";
import { normalizeThreadId } from "./thread-id.mjs";

const LIMIT = 8 * 1024 * 1024;
const failure = (message, code = "NATIVE_PROTOCOL_ERROR", uncertain = false) => Object.assign(new Error(message), { code, uncertain });
const fingerprint = info => [info.dev, info.ino, info.ctimeMs];

export async function inspectNativeEndpoint(socketPath, expected) {
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath) || socketPath.includes("\0")) throw failure("Desktop native endpoint is unavailable.", "NATIVE_UNAVAILABLE");
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw failure("Unsafe Desktop native endpoint.", "NATIVE_ENDPOINT_UNSAFE");
  const identity = fingerprint(info);
  if (expected && JSON.stringify(expected) !== JSON.stringify(identity)) throw failure("Desktop native endpoint changed. Inspect the creation receipt before retrying.", "NATIVE_ENDPOINT_CHANGED");
  return { socketPath, fingerprint: identity };
}

export async function discoverNativeEndpoint(state, { run = spawnSync } = {}) {
  if (state.node_path !== BUNDLED_NODE) throw failure("Native tools require Desktop's bundled wrapper Node.", "NATIVE_UNAVAILABLE");
  let endpoint = state.native_tools_pipe;
  if (!endpoint) {
    // Compatibility with an already-running wrapper. Read only the selected
    // owner-validated PID, extract one inherited endpoint, and never emit/store
    // its complete environment. New wrappers advertise the endpoint directly.
    const owner = run("/bin/ps", ["-p", String(state.pid), "-o", "uid=", "-o", "comm="], { encoding: "utf8", timeout: 3000 });
    const match = owner.stdout?.trim().match(/^(\d+)\s+(.+)$/);
    if (owner.status !== 0 || !match || Number(match[1]) !== process.getuid() || match[2] !== BUNDLED_NODE) throw failure("Cannot verify the selected Desktop wrapper.", "NATIVE_UNAVAILABLE");
    const environment = run("/bin/ps", ["eww", "-p", String(state.pid), "-o", "command="], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
    if (environment.status === 0) endpoint = environment.stdout?.match(/(?:^| )CODEX_APP_TOOLS_PIPE_PATH=([^ \n]*)/)?.[1];
    if (!endpoint) throw failure("The selected wrapper did not inherit Desktop native tools. Finish tasks before restarting with codexteer desktop start.", "NATIVE_UNAVAILABLE");
  }
  return inspectNativeEndpoint(endpoint);
}

export function nativeRequest(action, args, context, callId = randomUUID()) {
  if (action === "catalog") return { jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: { threadStartKind: "all" } };
  if (!["list_projects", "create_thread", "move_thread_to_project"].includes(action)) throw failure("Unsupported native operation.");
  const threadId = normalizeThreadId(context?.threadId);
  if (typeof context.turnId !== "string" || !context.turnId.trim() || context.turnId.length > 150) throw failure("A stored caller turn is required.");
  if (typeof callId !== "string" || !/^[a-zA-Z0-9-]{1,150}$/.test(callId)) throw failure("Invalid native call ID.");
  if (action === "list_projects") args = {};
  else if (action === "move_thread_to_project") {
    // Standalone creation registers only the new task itself. Never use this
    // transport to move another task or grant additional workspace access.
    if (args?.threadId !== threadId || typeof args.projectId !== "string" || !args.projectId.trim()
      || Object.keys(args).some(key => !["threadId", "projectId"].includes(key))) throw failure("Invalid native self-assignment arguments.");
  }
  else if (typeof args?.prompt !== "string" || !args.prompt.trim() || args.target?.type !== "project" || args.target.environment?.type !== "local"
    || typeof args.target.projectId !== "string" || !args.target.projectId.trim()
    || Object.keys(args).some(key => !["prompt", "title", "model", "thinking", "target"].includes(key))
    || Object.keys(args.target).some(key => !["type", "projectId", "environment"].includes(key))
    || Object.keys(args.target.environment).some(key => key !== "type")) throw failure("Invalid local native creation arguments.");
  return { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { arguments: args, callerSource: "codex", callId, hostId: "local", namespace: "codex_app", threadId, turnId: context.turnId, tool: action } };
}

export async function nativeRpc(endpoint, request, { timeoutMs = 30000 } = {}) {
  const mutation = ["create_thread", "move_thread_to_project"].includes(request.params?.tool);
  await inspectNativeEndpoint(endpoint.socketPath, endpoint.fingerprint);
  const body = Buffer.from(JSON.stringify(request));
  if (body.length > LIMIT) throw failure("Native request exceeds the frame limit.");
  const frame = Buffer.alloc(4 + body.length), little = os.endianness() === "LE";
  little ? frame.writeUInt32LE(body.length) : frame.writeUInt32BE(body.length); body.copy(frame, 4);
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), settled = false, dispatched = false;
    const socket = net.createConnection(endpoint.socketPath);
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) { error.uncertain ||= mutation && dispatched && ![-32601, -32602].includes(error.rpcCode); reject(error); } else resolve(result); };
    const timer = setTimeout(() => finish(failure("Native request timed out. Do not retry creation automatically.", "NATIVE_TIMEOUT")), timeoutMs);
    socket.on("connect", () => { dispatched = true; socket.write(frame); });
    socket.on("error", () => finish(failure("Desktop native connection failed.", "NATIVE_CONNECTION_FAILED")));
    socket.on("close", () => finish(failure("Desktop native connection closed before acknowledgement.", "NATIVE_CONNECTION_CLOSED")));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > LIMIT + 4) return finish(failure("Native response exceeds the frame limit."));
      if (bytes.length < 4) return;
      const length = little ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
      if (!length || length > LIMIT) return finish(failure("Invalid native frame length."));
      if (bytes.length < length + 4) return;
      try {
        const response = JSON.parse(bytes.subarray(4, length + 4));
        if (response.id !== request.id || response.jsonrpc !== "2.0" || bytes.length !== length + 4) throw failure("Invalid native response identity/frame.");
        if (response.error) {
          const error = failure("Desktop rejected the native request. Inspect the receipt before retrying.", "NATIVE_REJECTED");
          if (Number.isSafeInteger(response.error.code)) error.rpcCode = response.error.code;
          return finish(error);
        }
        if (!Object.hasOwn(response, "result")) throw failure("Native response has no result.");
        finish(null, response.result);
      } catch (error) { finish(error.code ? error : failure("Invalid native response JSON.")); }
    });
  });
}

export function nativeToolJson(result) {
  if (result?.success !== true || !Array.isArray(result.contentItems)) throw failure("Desktop native tool did not confirm success. Inspect the receipt before retrying.", "NATIVE_TOOL_FAILED", true);
  const texts = result.contentItems.filter(item => item.type === "inputText");
  if (texts.length !== 1 || typeof texts[0].text !== "string") throw failure("Invalid native tool receipt.", "NATIVE_PROTOCOL_ERROR", true);
  try { return JSON.parse(texts[0].text); } catch { throw failure("Invalid native tool receipt JSON.", "NATIVE_PROTOCOL_ERROR", true); }
}
