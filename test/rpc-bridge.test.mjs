import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { RpcClient, connectSocket } from "../src/rpc.mjs";
import { relay } from "../src/bridge.mjs";
import { DesktopSubscriptions, serveSubscriptions, ensureDesktopSubscription } from "../src/subscription.mjs";
import { sendAppServerMessage } from "../src/app-server.mjs";

async function fixture(t, connection) {
  const root = await mkdtemp("/private/tmp/cs-ws-test-");
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", connection);
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(`${root}/s.sock`, resolve); });
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("RPC handshake, independent request IDs and server-request direction are preserved", async t => {
  const wire = [];
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const message = JSON.parse(bytes);
    wire.push(message);
    if (!message.id) return;
    if (message.method === "slow") {
      socket.send(JSON.stringify({ id: message.id, method: "item/commandExecution/requestApproval", params: { threadId: "test" } }));
      setTimeout(() => socket.send(JSON.stringify({ id: message.id, result: { accepted: true } })), 10);
    } else socket.send(JSON.stringify({ id: message.id, result: {} }));
  }));
  const client = await RpcClient.connect(`${root}/s.sock`);
  t.after(() => client.close());
  let approval = false;
  client.on("serverRequest", () => { approval = true; });
  const result = await client.request("slow");
  assert.equal(result.accepted, true);
  assert.equal(approval, true);
  assert.deepEqual(wire.map(m => m.method), ["initialize", "initialized", "slow"]);
  assert.equal(wire.some(m => "jsonrpc" in m), false);
  assert.notEqual(wire[0].id, wire[2].id);
});

test("RPC disconnect after a write is uncertain; no retry or approval response is synthesized", async t => {
  let mutations = 0;
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
    else if (request.method === "turn/steer") { mutations++; socket.terminate(); }
  }));
  const client = await RpcClient.connect(`${root}/s.sock`);
  t.after(() => client.close());
  await assert.rejects(client.request("turn/steer", {}, { mutation: true }), error => error.uncertain === true);
  assert.equal(mutations, 1);
});

test("server errors never echo sensitive server-provided data into CLI errors", async t => {
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    if (request.id) socket.send(JSON.stringify(request.method === "initialize" ? { id: request.id, result: {} } : { id: request.id, error: { code: -1, message: "synthetic-private-prompt" } }));
  }));
  const client = await RpcClient.connect(`${root}/s.sock`);
  t.after(() => client.close());
  await assert.rejects(client.request("turn/steer", {}, { mutation: true }), error => !error.uncertain && error.rpcCode === -1 && !error.message.includes("synthetic-private"));
});

test("malformed protocol input stays terminal and preserves uncertain writes", async t => {
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
    else if (request.id) socket.send("{invalid-private-data");
  }));
  const client = await RpcClient.connect(`${root}/s.sock`);
  t.after(() => client.close());
  await assert.rejects(client.request("turn/steer", {}, { mutation: true }), error => error.code === "PROTOCOL_ERROR" && error.uncertain && !error.message.includes("private"));
  await assert.rejects(client.request("thread/read"), error => error.code === "PROTOCOL_ERROR" && !error.uncertain);
});

test("the 64 MiB receive limit reports oversized frames without making sent writes retryable", async t => {
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
  oversized.write('{"private":"synthetic-private-prompt"}');
  const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  for (const phase of ["initialize", "thread/read", "turn/steer"]) {
    let writes = 0;
    const root = await fixture(t, socket => {
      socket.on("error", () => {});
      socket.on("message", bytes => {
        const request = JSON.parse(bytes);
        if (!request.id) return;
        if (request.method === "turn/steer") writes++;
        if (request.method === phase) { socket.send(oversized, { binary: false }, () => {}); return; }
        socket.send(JSON.stringify({ id: request.id, result: request.method === "initialize" ? {} : { thread: { id: threadId, status: { type: "active" }, turns: [{ id: "active", status: "inProgress" }] } } }));
      });
    });
    await assert.rejects(sendAppServerMessage(threadId, "do not retry automatically", {
      discover: async () => ({ paths: { lease: root, socket: `${root}/s.sock` }, state: { codex_steer_protocol: 1 } }),
    }), error => {
      assert.equal(error.code, "PAYLOAD_TOO_LARGE");
      assert.equal(error.delivery_status, phase === "turn/steer" ? "unknown" : "not_sent");
      assert.equal(error.sent, phase === "turn/steer" ? null : false);
      assert.equal(error.message.includes("synthetic-private"), false);
      if (phase !== "turn/steer") assert.match(error.message, /64 MiB/);
      return true;
    });
    assert.equal(writes, phase === "turn/steer" ? 1 : 0);
  }
});

test("steering succeeds over a real socket when the full history exceeds the receive limit", async t => {
  const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", turnId = "active";
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
  const calls = [];
  const root = await fixture(t, socket => {
    socket.on("error", () => {});
    socket.on("message", bytes => {
      const request = JSON.parse(bytes);
      if (!request.id) return;
      calls.push(request);
      let result;
      if (request.method === "initialize") result = {};
      else if (request.method === "thread/read") {
        if (request.params.includeTurns) { socket.send(oversized, { binary: false }, () => {}); return; }
        result = { thread: { id: threadId, status: { type: "active" }, historyMode: "paginated", turns: [], canAcceptDirectInput: true } };
      } else if (request.method === "thread/turns/list") {
        assert.equal(request.params.itemsView, "notLoaded");
        result = { data: [{ id: turnId, status: "inProgress", itemsView: "notLoaded", items: [] }], nextCursor: null };
      } else if (request.method === "turn/steer") {
        assert.equal(request.params.threadId, threadId); assert.equal(request.params.expectedTurnId, turnId);
        result = { turnId };
      } else assert.fail(`Unexpected RPC: ${request.method}`);
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const original = await RpcClient.connect(`${root}/s.sock`);
  try { await assert.rejects(original.request("thread/read", { threadId, includeTurns: true }), { code: "PAYLOAD_TOO_LARGE", uncertain: false }); }
  finally { original.close(); }
  calls.length = 0;
  const receipt = await sendAppServerMessage(threadId, "synthetic steering only", {
    discover: async () => ({ paths: { lease: root, socket: `${root}/s.sock` }, state: { codex_steer_package: "codexteer", codex_steer_version: "0.15.0", codex_steer_protocol: 1 } }),
  });
  assert.equal(receipt.delivery_status, "accepted");
  assert.equal(calls.filter(call => call.method === "turn/steer").length, 1);
  assert.ok(calls.filter(call => call.method === "thread/read").every(call => call.params.includeTurns === false));
});

test("initialization is cancellable and read timeouts are not uncertain deliveries", async t => {
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  const client = await RpcClient.connect(`${root}/s.sock`, { timeoutMs: 20 });
  t.after(() => client.close());
  await assert.rejects(client.request("thread/read"), error => error.code === "TIMEOUT" && !error.uncertain);
  const stalled = await fixture(t, socket => socket.on("message", () => {}));
  const stop = new AbortController();
  const pending = RpcClient.connect(`${stalled}/s.sock`, { signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(pending, { code: "CANCELLED" });
});

test("malformed error codes cannot leak server data or masquerade as supported RPC errors", async t => {
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
    else if (request.id) socket.send(JSON.stringify({ id: request.id, error: { code: { text: "private-data" } } }));
  }));
  const client = await RpcClient.connect(`${root}/s.sock`);
  t.after(() => client.close());
  await assert.rejects(client.request("turn/steer", {}, { mutation: true }), error => error.code === "PROTOCOL_ERROR" && error.uncertain && error.rpcCode === undefined && !error.message.includes("private"));
});

test("relay handles split UTF-8, multiline/large text, response IDs, and backpressure", async t => {
  const messages = [];
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const message = JSON.parse(bytes);
    messages.push(message);
    socket.send(JSON.stringify({ id: message.id, result: message.params }, null, 2));
  }));
  const socket = await connectSocket(`${root}/s.sock`);
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 8 });
  let received = "";
  let done;
  const receivedAll = new Promise(resolve => { done = resolve; });
  output.on("data", chunk => {
    received += chunk;
    if (received.split("\n").length === 3) done();
  });
  const copy = relay(input, output, socket);
  const text = "日本語\n🌱".repeat(30000);
  const records = [{ id: 7, method: "probe", params: { text } }, { id: "approval-1", result: { decision: "decline" } }];
  const data = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  // Chunk length deliberately splits multibyte characters and escaped newlines.
  for (let i = 0; i < data.length; i += 997) input.write(data.subarray(i, i + 997));
  await Promise.race([receivedAll, delay(3000).then(() => { throw new Error("Relay stalled"); })]);
  input.end();
  await copy;
  assert.deepEqual(messages, records);
  const replies = received.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies[0].result.text, text);
  assert.equal(replies[1].id, "approval-1");
});

test("relay exits on peer failure even when Desktop stdin is still open", async t => {
  let peer;
  const root = await fixture(t, socket => { peer = socket; });
  const socket = await connectSocket(`${root}/s.sock`);
  const input = new PassThrough();
  const copy = relay(input, new PassThrough(), socket);
  peer.terminate();
  await assert.rejects(copy, /closed|failed/);
  assert.equal(input.destroyed, true);
});

test("relay preserves integer literals beyond JavaScript's safe number range", async t => {
  const raw = '{\n"id":9007199254740993,\n"result":{"counter":18446744073709551615,"text":"line\\nnext"}\n}';
  const root = await fixture(t, socket => socket.on("message", () => socket.send(raw)));
  const socket = await connectSocket(`${root}/s.sock`);
  const input = new PassThrough();
  const output = new PassThrough();
  const received = new Promise(resolve => output.once("data", resolve));
  const copy = relay(input, output, socket);
  input.write('{"id":1,"method":"probe"}\n');
  const data = await received;
  input.end();
  await copy;
  assert.equal(data.toString(), raw.replace(/\n/g, "") + "\n");
});

test("subscription helper uses Desktop connection and consumes only its own responses", async t => {
  const requests = [];
  const root = await fixture(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes);
    requests.push(request);
    socket.send(JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId } } }));
  }));
  const socket = await connectSocket(`${root}/s.sock`);
  const subscriptions = new DesktopSubscriptions(socket);
  subscriptions.ready = true;
  socket.on("message", bytes => subscriptions.consume(JSON.parse(bytes)));
  const stop = await serveSubscriptions(`${root}/ui.sock`, subscriptions);
  t.after(async () => { await stop(); socket.terminate(); });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  await ensureDesktopSubscription(`${root}/ui.sock`, id);
  assert.deepEqual(requests.map(r => ({ method: r.method, params: r.params })), [{ method: "thread/resume", params: { threadId: id, excludeTurns: true } }]);
  assert.equal(subscriptions.consume({ id: "desktop-id", result: {} }), true);
  assert.equal(subscriptions.consume({ id: requests[0].id, result: {} }), false);
  assert.equal(subscriptions.consume({ id: requests[0].id, method: "item/permissions/requestApproval" }), true);
});

test("subscription timeout stays a no-send failure and consumes a late response", async t => {
  const root = await fixture(t, () => {});
  const socket = await connectSocket(`${root}/s.sock`);
  t.after(() => socket.terminate());
  const subscriptions = new DesktopSubscriptions(socket, { timeoutMs: 20 });
  subscriptions.ready = true;
  const request = subscriptions.ensure("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
  const id = [...subscriptions.pending.keys()][0];
  await assert.rejects(request, /timed out/);
  assert.equal(subscriptions.consume({ id, result: {} }), false);
  subscriptions.close();
});
