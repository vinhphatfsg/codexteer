import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { RpcClient, RpcFailure } from "../src/rpc.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { sendAppServerMessage } from "../src/app-server.mjs";
import { fail } from "../src/cli.mjs";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000051", ID = `durable_${uuid}`, LOCAL = "11111111-1111-4111-8111-000000000051";
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// A socket that answers every request with the given JSON-RPC error.
function rejecting(error) {
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: 1, terminate() {}, close() {},
    send(data, done) { done?.(); queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: JSON.parse(data).id, error })), false)); } });
  return new RpcClient(socket);
}
const rejection = (error, method = "thread/read", options) => rejecting(error).request(method, {}, options).then(() => assert.fail("not rejected"), caught => caught);

test("a rejected read keeps the JSON-RPC code, message and reason beside RPC_REJECTED", async () => {
  const overloaded = await rejection({ code: -32001, message: "Server overloaded; retry later.", data: { reason: "serverOverloaded" } });
  assert.equal(overloaded.code, "RPC_REJECTED"); assert.equal(overloaded.rpcCode, -32001);
  assert.equal(overloaded.rpcMessage, "Server overloaded; retry later."); assert.equal(overloaded.rpcReason, "serverOverloaded");
  assert.equal(overloaded.message, "thread/read was rejected by App Server.", "the error's own message is unchanged");
  const closing = await rejection({ code: -32600, message: "Invalid request", data: { reason: "serverShuttingDown" } }, "thread/turns/list");
  assert.equal(closing.rpcCode, -32600); assert.equal(closing.rpcReason, "serverShuttingDown"); assert.equal(closing.rpcMessage, "Invalid request");
  const bare = await rejection({ code: -32601 });
  assert.equal(bare.rpcCode, -32601); assert.equal(bare.rpcMessage, undefined); assert.equal(bare.rpcReason, undefined);
});

test("the kept message is bounded and single-line, and never carries a credential-like run or an unstructured reason", async () => {
  const secret = "eyJ" + "a".repeat(120), long = await rejection({ code: -32001, message: `overloaded\nline two ${secret} ${"詳細".repeat(2000)}`, data: { reason: "not an identifier, but prose" } });
  assert.ok(bytes(long.rpcMessage) <= 300, "bounded after JSON escaping"); assert.doesNotMatch(long.rpcMessage, /[\u0000-\u001f]/);
  assert.equal(long.rpcMessage.includes(secret), false); assert.match(long.rpcMessage, /^overloaded line two \[redacted\]/);
  assert.equal(long.rpcReason, undefined);
  for (const reason of [{ nested: "object" }, "x".repeat(65), 7, ""]) assert.equal((await rejection({ code: -32001, message: "m", data: { reason } })).rpcReason, undefined);
});

test("a rejected request that carries an instruction keeps the code and reason, never the server's message", async () => {
  for (const method of ["turn/steer", "turn/start", "thread/start", "thread/name/set"]) {
    const error = await rejection({ code: -32001, message: "echo of the private instruction", data: { reason: "serverOverloaded" } }, method, { mutation: true });
    assert.equal(error.rpcCode, -32001); assert.equal(error.rpcReason, "serverOverloaded"); assert.equal(error.rpcMessage, undefined, method);
  }
});

test("the CLI prints the JSON-RPC code, reason and message in JSON and in text", t => {
  const error = new RpcFailure("thread/read was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32001, rpcMessage: "Server overloaded; retry later.", rpcReason: "serverOverloaded" });
  const out = [], err = [], priorExit = process.exitCode;
  const log = t.mock.method(console, "log", line => out.push(line)), errors = t.mock.method(console, "error", line => err.push(line));
  try { fail(error, true); fail(error, false); fail(new RpcFailure("x was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32601 }), false); }
  finally { log.mock.restore(); errors.mock.restore(); process.exitCode = priorExit; }
  const printed = JSON.parse(out[0]).error;
  assert.equal(printed.code, "RPC_REJECTED"); assert.equal(printed.rpc_code, -32001);
  assert.equal(printed.rpc_message, "Server overloaded; retry later."); assert.equal(printed.rpc_reason, "serverOverloaded");
  assert.ok(err.includes("rpc: -32001 serverOverloaded: Server overloaded; retry later."), err.join("\n"));
  assert.ok(err.includes("rpc: -32601"));
});

test("a Desktop Cloud read rejected by the service shows the detail on the member's row, and a compact row keeps the code and reason", async t => {
  const home = await mkdtemp(tempPrefix("ct-rpc-detail-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, message = "Server overloaded. ".repeat(40);
  let reject = true;
  const rpc = { close() {}, async request(method) {
    if (method === "thread/read") return { thread: { id: uuid, name: "w".repeat(6000), status: { type: "idle", activeFlags: [] } } };
    if (reject) return rejecting({ code: -32001, message, data: { reason: "serverOverloaded" } }).request(method);
    return { data: [{ id: "turn-0", status: "completed", itemsView: "full", items: [{ id: "report", type: "agentMessage", text: "Done." }] }], nextCursor: null };
  } };
  const read = (id, options) => observeThread(id, options, { connect: async () => new DesktopCloudClient(rpc) });
  await registerManagedThread(ID, { projectId: "P", connection: "desktop-cloud" }, storage);
  const failed = await syncProject("P", {}, { storage, read }), row = failed.works[0];
  assert.equal(failed.complete, false); assert.equal(row.error, "RPC_REJECTED");
  assert.equal(row.error_detail.rpc_code, -32001); assert.equal(row.error_detail.rpc_reason, "serverOverloaded");
  assert.ok(row.error_detail.rpc_message.startsWith("Server overloaded. ")); assert.ok(bytes(row.error_detail.rpc_message) <= 300);
  reject = false;
  // The first page is read, then the head verification is rejected: the row is too large for the budget.
  let reads = 0;
  const flaky = async (id, options) => { if (++reads === 2) reject = true; return read(id, options); };
  const compact = await syncProject("P", { byteBudget: 4096 }, { storage, read: flaky }), small = compact.works[0];
  assert.equal(small.details_omitted, true); assert.equal(small.error, "RPC_REJECTED");
  assert.deepEqual(small.error_detail, { rpc_code: -32001, rpc_reason: "serverOverloaded" });
  reject = false;
  const recovered = await syncProject("P", {}, { storage, read });
  assert.equal(recovered.complete, true); assert.equal(recovered.works[0].error_detail, undefined);
});

test("a send rejected by App Server reports the code and reason on the delivery failure", async t => {
  const home = await mkdtemp(tempPrefix("ct-rpc-send-")); t.after(() => rm(home, { recursive: true, force: true }));
  const rejected = new RpcFailure("thread/read was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32600, rpcMessage: "Invalid request", rpcReason: "serverShuttingDown" });
  await assert.rejects(sendAppServerMessage(LOCAL, "Continue.", {
    discover: async () => ({ paths: { lease: home, socket: "unused", control: "unused" }, state: { codex_steer_protocol: 1, codex_steer_capabilities: { turn_steer: [1], thread_read: [1], history_pagination: [1], turn_start: [1], desktop_subscribe: [1] } } }),
    connect: async () => ({ close() {}, request: async () => { throw rejected; } }),
  }), error => error.code === "RPC_REJECTED" && error.rpc_code === -32600 && error.rpc_reason === "serverShuttingDown" && error.rpc_message === "Invalid request");
});
