import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { mkdtemp, rm, chmod, symlink } from "node:fs/promises";
import { inspectNativeEndpoint, discoverNativeEndpoint, nativeRequest, nativeRpc, nativeToolJson } from "../src/native-rpc.mjs";
import { BUNDLED_NODE } from "../src/wrapper.mjs";

const CONTEXT = { threadId: "01a04373-3770-71e0-a2e3-a3c196f5f5b1", turnId: "stored-turn" };
const args = { prompt: "日本語 `$(never-execute)`", target: { type: "project", projectId: "project", environment: { type: "local" } } };
function frame(value) { const bytes = Buffer.from(JSON.stringify(value)), out = Buffer.alloc(bytes.length + 4); os.endianness() === "LE" ? out.writeUInt32LE(bytes.length) : out.writeUInt32BE(bytes.length); bytes.copy(out, 4); return out; }
async function fixture(t, handler) {
  const root = await mkdtemp("/private/tmp/ct-native-"); const socketPath = `${root}/rpc`;
  const sockets = new Set(), server = net.createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let bytes = Buffer.alloc(0); socket.on("data", part => { bytes = Buffer.concat([bytes, part]); if (bytes.length < 4) return; const n = os.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE(); if (bytes.length >= 4 + n) handler(socket, JSON.parse(bytes.subarray(4, n + 4))); }); });
  await new Promise(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, endpoint: await inspectNativeEndpoint(socketPath) };
}

test("native length-framed reads handle byte fragments and Unicode", async t => {
  const f = await fixture(t, (socket, request) => { const out = frame({ id: request.id, jsonrpc: "2.0", result: { text: "競馬😀" } }); socket.write(out.subarray(0, 2)); setImmediate(() => { socket.write(out.subarray(2, out.length - 2)); setImmediate(() => socket.end(out.subarray(out.length - 2))); }); });
  assert.deepEqual(await nativeRpc(f.endpoint, nativeRequest("catalog")), { text: "競馬😀" });
});

test("native disconnect and identity mismatch after creation dispatch stay uncertain", async t => {
  for (const mode of ["drop", "wrong-id", "oversize", "reject"]) {
    const f = await fixture(t, (socket, request) => {
      if (mode === "drop") return socket.destroy();
      if (mode === "oversize") { const b = Buffer.alloc(4); os.endianness() === "LE" ? b.writeUInt32LE(9 * 1024 * 1024) : b.writeUInt32BE(9 * 1024 * 1024); return socket.end(b); }
      socket.end(frame(mode === "reject" ? { id: request.id, jsonrpc: "2.0", error: { code: -32603 } } : { id: "wrong", jsonrpc: "2.0", result: {} }));
    });
    await assert.rejects(nativeRpc(f.endpoint, nativeRequest("create_thread", args, CONTEXT)), error => error.uncertain === true);
  }
});

test("changed endpoints, public sockets, symlinks and arbitrary tool requests fail before dispatch", async t => {
  let calls = 0; const f = await fixture(t, () => calls++);
  await assert.rejects(nativeRpc({ ...f.endpoint, fingerprint: [0] }, nativeRequest("catalog")), { code: "NATIVE_ENDPOINT_CHANGED" });
  const link = `${f.root}/link`; await symlink(f.endpoint.socketPath, link); await assert.rejects(inspectNativeEndpoint(link), { code: "NATIVE_ENDPOINT_UNSAFE" });
  await chmod(f.endpoint.socketPath, 0o666); await assert.rejects(inspectNativeEndpoint(f.endpoint.socketPath), { code: "NATIVE_ENDPOINT_UNSAFE" });
  assert.throws(() => nativeRequest("move_thread_to_project", {}, CONTEXT));
  assert.throws(() => nativeRequest("create_thread", { ...args, target: { ...args.target, environment: { type: "worktree" } } }, CONTEXT));
  assert.equal(calls, 0);
});

test("legacy discovery reads only a verified selected wrapper and extracts one endpoint", async t => {
  const f = await fixture(t, () => {}), calls = [];
  const endpoint = await discoverNativeEndpoint({ node_path: BUNDLED_NODE, pid: 42 }, { run(command, argv) { calls.push(argv); return argv.includes("uid=") ? { status: 0, stdout: `${process.getuid()} ${BUNDLED_NODE}\n` } : { status: 0, stdout: `node SECRET=never-print CODEX_APP_TOOLS_PIPE_PATH=${f.endpoint.socketPath} OTHER=private` }; } });
  assert.equal(endpoint.socketPath, f.endpoint.socketPath); assert.equal(JSON.stringify(endpoint).includes("SECRET"), false); assert.equal(calls.length, 2);
  await assert.rejects(discoverNativeEndpoint({ node_path: BUNDLED_NODE, pid: 42 }, { run: () => ({ status: 0, stdout: "0 /untrusted/node" }) }), { code: "NATIVE_UNAVAILABLE" });
});

test("native tool failures and malformed receipts never become success", () => {
  assert.throws(() => nativeToolJson({ success: false, contentItems: [] }), error => error.uncertain);
  assert.throws(() => nativeToolJson({ success: true, contentItems: [{ type: "inputText", text: "bad" }] }), error => error.uncertain);
});

test("native self-assignment requires an actual task context matching the moved task", () => {
  const request = nativeRequest("move_thread_to_project", { threadId: CONTEXT.threadId, projectId: "local" }, CONTEXT);
  assert.equal(request.params.tool, "move_thread_to_project");
  assert.throws(() => nativeRequest("move_thread_to_project", { threadId: "01a04373-3770-71e0-a2e3-a3c196f5f5b2", projectId: "local" }, CONTEXT));
  assert.throws(() => nativeRequest("move_thread_to_project", { threadId: CONTEXT.threadId, projectId: null }, CONTEXT));
  assert.throws(() => nativeRequest("move_thread_to_project", { threadId: CONTEXT.threadId, projectId: "local", source: "chatgpt" }, CONTEXT));
});
