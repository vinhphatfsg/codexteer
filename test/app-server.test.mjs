import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { sendOnClient, sendAppServerMessage } from "../src/app-server.mjs";
import { RpcFailure } from "../src/rpc.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const TURN = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const thread = (status = "active") => ({ id: ID, status: { type: status }, turns: status === "active" ? [{ id: TURN, status: "inProgress" }] : [], canAcceptDirectInput: status === "notLoaded" ? null : true });

test("steer binds exact task and active turn without resuming or overriding settings", async () => {
  const calls = [];
  const client = { async request(method, params, options) {
    calls.push({ method, params, options });
    return method === "thread/read" ? { thread: thread() } : { turnId: TURN };
  } };
  const result = await sendOnClient(client, ID, "日本語\nline 2");
  assert.equal(result.turn_id, TURN);
  assert.match(result.client_message_id, UUID);
  assert.deepEqual(calls, [
    { method: "thread/read", params: { threadId: ID, includeTurns: true }, options: undefined },
    { method: "turn/steer", params: { threadId: ID, expectedTurnId: TURN, input: [{ type: "text", text: "日本語\nline 2" }], clientUserMessageId: result.client_message_id }, options: { mutation: true } },
  ]);
});

test("separate sends of identical text have distinct user message identities", async () => {
  const ids = [];
  const client = { async request(method, params) {
    if (method === "thread/read") return { thread: thread() };
    ids.push(params.clientUserMessageId);
    return { turnId: TURN };
  } };
  const first = await sendOnClient(client, ID, "same text");
  const second = await sendOnClient(client, ID, "same text");
  assert.deepEqual(ids, [first.client_message_id, second.client_message_id]);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, UUID);
});

for (const status of ["idle", "notLoaded", "systemError"]) {
  test(`steer rejects ${status} without mutating`, async () => {
    const calls = [];
    const client = { async request(method) { calls.push(method); return { thread: thread(status) }; } };
    await assert.rejects(sendOnClient(client, ID, "test"), /active turn/);
    assert.deepEqual(calls, ["thread/read"]);
  });
}

test("wrong task, ambiguous turn and non-input tasks fail before sending", async () => {
  for (const value of [{ ...thread(), id: TURN }, { ...thread(), turns: [] }, { ...thread(), canAcceptDirectInput: false }]) {
    let calls = 0;
    await assert.rejects(sendOnClient({ async request() { calls++; return { thread: value }; } }, ID, "test"));
    assert.equal(calls, 1);
  }
});

test("stale-turn rejection is never retried or converted to a new turn", async () => {
  let writes = 0;
  const client = { async request(method) {
    if (method === "thread/read") return { thread: thread() };
    writes++;
    throw new RpcFailure("rejected", { code: "RPC_REJECTED" });
  } };
  await assert.rejects(sendOnClient(client, ID, "test"), { code: "RPC_REJECTED" });
  assert.equal(writes, 1);
});

for (const state of ["idle", "notLoaded"]) {
  test(`new turn from ${state} subscribes Desktop before sending, without CLI-only resume`, async () => {
    const calls = [];
    let reads = 0;
    let messageId;
    const client = { async request(method, params) {
      calls.push(method);
      if (method === "thread/read") return { thread: thread(reads++ === 0 ? state : "idle") };
      messageId = params.clientUserMessageId;
      assert.match(messageId, UUID);
      assert.deepEqual(params, { threadId: ID, input: [{ type: "text", text: "test" }], clientUserMessageId: messageId });
      return { turn: { id: TURN } };
    } };
    const result = await sendOnClient(client, ID, "test", { newTurn: true, subscribe: async id => { assert.equal(id, ID); calls.push("desktop.subscribe"); } });
    assert.deepEqual(result, { turn_id: TURN, client_message_id: messageId });
    assert.deepEqual(calls, ["thread/read", "desktop.subscribe", "thread/read", "turn/start"]);
  });
}

test("new-turn checks both initial state and a race during Desktop subscription", async () => {
  for (const initiallyActive of [true, false]) {
    let calls = 0;
    let subscriptions = 0;
    await assert.rejects(sendOnClient({ async request(method) {
      assert.equal(method, "thread/read");
      return { thread: thread(initiallyActive || calls++ ? "active" : "idle") };
    } }, ID, "test", { newTurn: true, subscribe: async () => subscriptions++ }), /idle|became active/);
    assert.equal(subscriptions, initiallyActive ? 0 : 1);
  }
});

test("subscription failure prevents a new-turn message", async () => {
  let reads = 0;
  await assert.rejects(sendOnClient({ async request(method) { assert.equal(method, "thread/read"); reads++; return { thread: thread("idle") }; } }, ID, "test", {
    newTurn: true, subscribe: async () => { throw new Error("no Desktop"); },
  }), /no Desktop/);
  assert.equal(reads, 1);
});

test("dry run requires no connection and reveals no message", async () => {
  const result = await sendAppServerMessage(ID, "secret test text", { dryRun: true, discover: () => assert.fail("discovery is not a dry-run operation") });
  assert.equal(result.sent, false);
  assert.equal(result.backend, "app-server");
  assert.equal(JSON.stringify(result).includes("secret test text"), false);
});

test("lost acknowledgement is unknown, never automatically retried", async () => {
  const root = await mkdtemp("/private/tmp/cs-send-test-");
  let sends = 0;
  let closed = false;
  try {
    await assert.rejects(sendAppServerMessage(ID, "private synthetic text", {
      discover: async () => ({ paths: { lease: root, socket: "unused" } }),
      connect: async () => ({ close() { closed = true; }, async request(method) {
        if (method === "thread/read") return { thread: thread() };
        sends++;
        throw new RpcFailure("synthetic details", { uncertain: true });
      } }),
    }), error => error.sent === null && error.delivery_status === "unknown" && !error.message.includes("private synthetic text"));
    assert.equal(sends, 1);
    assert.equal(closed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent sends for one task cannot bypass its lock", async () => {
  const root = await mkdtemp("/private/tmp/cs-lock-test-");
  let unlock;
  const blocked = new Promise(resolve => { unlock = resolve; });
  let connected;
  const started = new Promise(resolve => { connected = resolve; });
  const options = {
    discover: async () => ({ paths: { lease: root, socket: "unused" } }),
    connect: async () => ({ close() {}, async request(method) {
      if (method === "thread/read") return { thread: thread() };
      connected(); await blocked;
      return { turnId: TURN };
    } }),
  };
  const first = sendAppServerMessage(ID, "one", options);
  try {
    await started;
    await assert.rejects(sendAppServerMessage(ID, "two", options), /Another send/);
    unlock();
    assert.equal((await first).delivery_status, "accepted");
    assert.equal((await sendAppServerMessage(ID, "three", options)).sent, true);
  } finally { unlock(); await first; await rm(root, { recursive: true, force: true }); }
});

test("cleanup errors cannot replace an accepted receipt with a send error", async () => {
  const root = await mkdtemp("/private/tmp/cs-cleanup-test-");
  try {
    const result = await sendAppServerMessage(ID, "test", {
      discover: async () => ({ paths: { lease: root, socket: "unused" } }),
      connect: async () => ({
        async request(method) { return method === "thread/read" ? { thread: thread() } : { turnId: TURN }; },
        close() { throw new Error("synthetic cleanup failure"); },
      }),
    });
    assert.equal(result.sent, true);
    assert.equal(result.delivery_status, "accepted");
    assert.equal(result.runtime_cleanup_required, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
