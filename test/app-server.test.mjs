import test from "node:test";
import { VERSION, PACKAGE_NAME } from "../src/version.mjs";
import { RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";
const steerState = { codex_steer_version: VERSION, codex_steer_package: PACKAGE_NAME, codex_steer_protocol: RUNTIME_PROTOCOL };
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
    { method: "thread/read", params: { threadId: ID, includeTurns: false }, options: undefined },
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
    assert.deepEqual(calls, ["thread/read", "thread/read"]);
  });
}

test("wrong task, ambiguous turn and non-input tasks fail before sending", async () => {
  for (const value of [{ ...thread(), id: TURN }, { ...thread(), turns: [] }, { ...thread(), canAcceptDirectInput: false }]) {
    let calls = 0;
    await assert.rejects(sendOnClient({ async request() { calls++; return { thread: value }; } }, ID, "test"));
    assert.equal(calls, value.id !== ID || value.canAcceptDirectInput === false ? 1 : 2);
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
    let subscribed = false;
    let messageId;
    const client = { async request(method, params) {
      calls.push(method);
      if (method === "thread/read") return { thread: thread(subscribed ? "idle" : state) };
      messageId = params.clientUserMessageId;
      assert.match(messageId, UUID);
      assert.deepEqual(params, { threadId: ID, input: [{ type: "text", text: "test" }], clientUserMessageId: messageId });
      return { turn: { id: TURN } };
    } };
    const result = await sendOnClient(client, ID, "test", { newTurn: true, subscribe: async id => { assert.equal(id, ID); subscribed = true; calls.push("desktop.subscribe"); } });
    assert.deepEqual(result, { turn_id: TURN, client_message_id: messageId });
    assert.deepEqual(calls, ["thread/read", "thread/read", "desktop.subscribe", "thread/read", "thread/read", "turn/start"]);
  });
}

test("new-turn checks both initial state and a race during Desktop subscription", async () => {
  for (const initiallyActive of [true, false]) {
    let subscriptions = 0;
    await assert.rejects(sendOnClient({ async request(method) {
      assert.equal(method, "thread/read");
      return { thread: thread(initiallyActive || subscriptions ? "active" : "idle") };
    } }, ID, "test", { newTurn: true, subscribe: async () => subscriptions++ }), /idle|became active/);
    assert.equal(subscriptions, initiallyActive ? 0 : 1);
  }
});

test("subscription failure prevents a new-turn message", async () => {
  let reads = 0;
  await assert.rejects(sendOnClient({ async request(method) { assert.equal(method, "thread/read"); reads++; return { thread: thread("idle") }; } }, ID, "test", {
    newTurn: true, subscribe: async () => { throw new Error("no Desktop"); },
  }), /no Desktop/);
  assert.equal(reads, 2);
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
      discover: async () => ({ state: steerState, paths: { lease: root, socket: "unused" } }),
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
    discover: async () => ({ state: steerState, paths: { lease: root, socket: "unused" } }),
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
      discover: async () => ({ state: steerState, paths: { lease: root, socket: "unused" } }),
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

test("unknown mutation contracts and incompatible protocols never connect or send", async () => {
  for (const state of [undefined, {}, { ...steerState, codex_steer_protocol: 999 }]) {
    await assert.rejects(sendAppServerMessage(ID, "test", {
      discover: async () => ({ paths: {}, state }), connect: async () => assert.fail("must fail before connecting"),
    }), error => error.delivery_status === "not_sent" && /^RUNTIME_PROTOCOL_/.test(error.code));
  }
});

test("different and unknown product versions send using the compatible v1 contract", async t => {
  const root = await mkdtemp("/private/tmp/cs-mixed-send-"); t.after(() => rm(root, { recursive: true, force: true }));
  for (const codex_steer_version of [undefined, "0.1.0", "999.0.0"]) {
    let writes = 0;
    const receipt = await sendAppServerMessage(ID, "test", {
      discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, codex_steer_version } }),
      inspectControl: () => assert.fail("steer must not inspect the new-turn endpoint"),
      connect: async () => ({ close() {}, async request(method) {
        if (method === "thread/read") return { thread: thread() };
        assert.equal(method, "turn/steer"); writes++; return { turnId: TURN };
      } }),
    });
    assert.equal(receipt.delivery_status, "accepted"); assert.equal(writes, 1);
  }
});

test("unsupported new-turn contracts never subscribe, and do not block normal steering", async t => {
  const root = await mkdtemp("/private/tmp/cs-feature-send-"); t.after(() => rm(root, { recursive: true, force: true }));
  for (const feature of ["turn_start", "desktop_subscribe"]) {
    let writes = 0;
    const options = {
      discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, [feature]: [2] } } }),
      inspectControl: () => assert.fail("incompatible new-turn must stop before inspecting control"),
      subscribe: () => assert.fail("must not subscribe"),
      connect: async () => ({ close() {}, async request(method) {
        if (method === "thread/read") return { thread: thread() };
        assert.equal(method, "turn/steer"); writes++; return { turnId: TURN };
      } }),
    };
    await assert.rejects(sendAppServerMessage(ID, "test", { ...options, newTurn: true }), { code: "CAPABILITY_UNSUPPORTED", capability: feature, sent: false });
    assert.equal((await sendAppServerMessage(ID, "test", options)).sent, true);
    assert.equal(writes, 1);
  }
});

test("compatible new-turn rechecks its endpoint before subscription and sending", async t => {
  const root = await mkdtemp("/private/tmp/cs-newturn-compat-"); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const options = {
    newTurn: true,
    discover: async () => ({ paths: { lease: root, socket: "unused", control: "control" }, state: { ...steerState, codex_steer_version: "0.0.1" } }),
    inspectControl: async paths => { assert.equal(paths.control, "control"); calls.push("inspect"); },
    subscribe: async () => { calls.push("subscribe"); },
    connect: async () => ({ close() {}, async request(method) {
      calls.push(method); return method === "thread/read" ? { thread: thread("idle") } : { turn: { id: TURN } };
    } }),
  };
  assert.equal((await sendAppServerMessage(ID, "test", options)).sent, true);
  assert.deepEqual(calls, ["inspect", "thread/read", "thread/read", "inspect", "inspect", "subscribe", "thread/read", "thread/read", "inspect", "turn/start"]);
  await assert.rejects(sendAppServerMessage(ID, "test", { ...options,
    inspectControl: async () => { throw Object.assign(new Error("unsafe endpoint"), { code: "RUNTIME_UNSAFE" }); },
    connect: () => assert.fail("unsafe endpoint must not connect"),
  }), { code: "RUNTIME_UNSAFE", sent: false });
});

test("an unsupported optional freshness API prevents both sending and Desktop resume", async t => {
  const root = await mkdtemp("/private/tmp/cs-optional-check-"); t.after(() => rm(root, { recursive: true, force: true }));
  for (const newTurn of [false, true]) {
    const calls = [];
    await assert.rejects(sendAppServerMessage(ID, "test", {
      newTurn,
      discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, history_pagination: [2] } } }),
      inspectControl: async () => {},
      beforeSend: async (_thread, client) => { await client.request("thread/items/list", { threadId: ID }); },
      subscribe: () => assert.fail("must not resume before verifying required freshness APIs"),
      connect: async () => ({ close() {}, async request(method) {
        calls.push(method); assert.equal(method, "thread/read"); return { thread: thread(newTurn ? "idle" : "active") };
      } }),
    }), { code: "CAPABILITY_UNSUPPORTED", capability: "history_pagination", sent: false });
    assert.deepEqual(calls, ["thread/read", "thread/read"]);
  }
});

test("capabilities changing during the send are rechecked before mutation", async t => {
  const root = await mkdtemp("/private/tmp/cs-cap-race-"); t.after(() => rm(root, { recursive: true, force: true }));
  let discoveries = 0;
  await assert.rejects(sendAppServerMessage(ID, "test", {
    discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, instance: "same", codex_steer_capabilities: {
      ...RUNTIME_CAPABILITIES, turn_steer: ++discoveries === 1 ? [1] : [2],
    } } }),
    connect: async () => ({ close() {}, async request(method) { assert.equal(method, "thread/read"); return { thread: thread() }; } }),
  }), { code: "CAPABILITY_UNSUPPORTED", sent: false });
});

test("a runtime replaced after observation cannot receive the send", async t => {
  const root = await mkdtemp("/private/tmp/cs-send-replaced-"); t.after(() => rm(root, { recursive: true, force: true }));
  let discoveries = 0, writes = 0;
  await assert.rejects(sendAppServerMessage(ID, "test", {
    discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, instance: String(++discoveries) } }),
    connect: async () => ({ close() {}, async request(method) { if (method === "thread/read") return { thread: thread() }; writes++; } }),
  }), error => error.code === "RUNTIME_CHANGED" && error.delivery_status === "not_sent");
  assert.equal(writes, 0);
});

function pagedServer({ status = "active", turns = [{ id: TURN, status: "inProgress" }], beforeRequest = () => {} } = {}) {
  const metadata = { ...thread(status), historyMode: "paginated", turns: [] }, calls = [];
  const client = { close() {}, async request(method, params) {
    calls.push({ method, ...params });
    await beforeRequest(method, params, metadata);
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false, "paged send must not download item bodies");
      return { thread: structuredClone(metadata) };
    }
    if (method === "thread/turns/list") {
      assert.equal(params.itemsView, "notLoaded");
      assert.equal(params.sortDirection, "asc");
      const start = Number(params.cursor ?? 0), end = start + params.limit;
      return { data: structuredClone(turns.slice(start, end)), nextCursor: end < turns.length ? String(end) : null };
    }
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    if (method === "turn/start") return { turn: { id: TURN } };
    assert.fail(`Unexpected RPC: ${method}`);
  } };
  return { client, calls, metadata };
}

test("paged steering finds the active turn across pages without reading item bodies", async () => {
  const turns = Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, status: "completed" }));
  turns.push({ id: TURN, status: "inProgress" });
  const { client, calls } = pagedServer({ turns });
  let checks = 0;
  const receipt = await sendOnClient(client, ID, "bounded steering", { beforeSend: async state => {
    checks++;
    assert.equal(state.turns.length, 201);
    assert.ok(state.turns.every(turn => turn.itemsView === "notLoaded"));
  } });
  assert.equal(checks, 1);
  assert.equal(receipt.turn_id, TURN);
  assert.equal(calls.filter(call => call.method === "thread/turns/list").length, 3);
  assert.deepEqual(calls.filter(call => call.method.startsWith("turn/")), [{
    method: "turn/steer", threadId: ID, expectedTurnId: TURN,
    input: [{ type: "text", text: "bounded steering" }], clientUserMessageId: receipt.client_message_id,
  }]);
});

test("missing or only historical active turns across pages never send", async () => {
  for (const latestStatus of ["completed", "failed", "interrupted"]) {
    const turns = Array.from({ length: 101 }, (_, i) => ({ id: `turn-${i}`, status: i < 2 ? "inProgress" : "completed" }));
    turns.at(-1).status = latestStatus;
    const { client, calls } = pagedServer({ turns });
    await assert.rejects(sendOnClient(client, ID, "must not send"), /active turn/);
    assert.equal(calls.filter(call => call.method.startsWith("turn/")).length, 0);
  }
  for (const turns of [[], [{ id: "old", status: "inProgress" }, { id: "latest", status: "completed" }]]) {
    const { client, calls } = pagedServer({ turns });
    await assert.rejects(sendOnClient(client, ID, "must not send"), /active turn/);
    assert.equal(calls.filter(call => call.method.startsWith("turn/")).length, 0);
  }
});

test("historical orphan turns do not block a guarded steer to the latest paginated turn", async () => {
  const turns = Array.from({ length: 201 }, (_, i) => ({ id: `turn-${i}`, status: i === 0 || i === 100 || i === 200 ? "inProgress" : "completed" }));
  const { client, calls } = pagedServer({ turns });
  const receipt = await sendOnClient(client, ID, "continue", { beforeSend: async thread => {
    assert.deepEqual(thread.turns.filter(t => t.status === "inProgress").map(t => t.id), ["turn-0", "turn-100", "turn-200"], "raw historical states remain available to freshness checks");
  } });
  assert.equal(receipt.turn_id, "turn-200");
  assert.deepEqual(calls.filter(c => c.method.startsWith("turn/")).map(c => [c.method, c.expectedTurnId]), [["turn/steer", "turn-200"]]);
  assert.equal(calls.filter(c => c.method === "thread/turns/list").length, 3);
});

test("legacy ambiguity still fails before mutation", async () => {
  const ambiguous = { ...thread(), turns: [{ id: "old", status: "inProgress" }, { id: TURN, status: "inProgress" }] };
  await assert.rejects(sendOnClient({ async request(method) {
    assert.equal(method, "thread/read"); return { thread: ambiguous };
  } }, ID, "must not send"), /active turn/);
});

test("orphan workaround never retries, falls back, or starts after rejection or unknown acknowledgement", async t => {
  const root = await mkdtemp("/private/tmp/cs-orphan-send-"); t.after(() => rm(root, { recursive: true, force: true }));
  for (const outcome of ["mismatch", "lost", "wrong-receipt"]) {
    const turns = [{ id: "old", status: "inProgress" }, { id: TURN, status: "inProgress" }];
    const server = pagedServer({ turns }); let writes = 0;
    await assert.rejects(sendAppServerMessage(ID, "continue", {
      discover: async () => ({ state: steerState, paths: { lease: root, socket: "unused" } }),
      connect: async () => ({ close() {}, async request(method, params) {
        if (!method.startsWith("turn/")) return server.client.request(method, params);
        writes++; assert.equal(method, "turn/steer"); assert.equal(params.expectedTurnId, TURN);
        if (outcome === "mismatch") throw new RpcFailure("runtime moved to a different turn", { code: "RPC_REJECTED", rpcCode: -32600 });
        if (outcome === "lost") throw new RpcFailure("lost acknowledgement", { uncertain: true });
        return { turnId: "other" };
      } }),
    }), error => outcome === "mismatch"
      ? error.code === "RPC_REJECTED" && error.sent === false && error.delivery_status === "not_sent"
      : error.sent === null && error.delivery_status === "unknown");
    assert.equal(writes, 1);
  }
});

test("pagination failure never falls back to full history, resumes, or sends", async () => {
  for (const newTurn of [false, true]) {
    for (const badPage of [{ data: null }, { data: [{ id: 1, status: "inProgress" }] }, { data: [{ id: TURN, status: "inProgress" }, { id: TURN, status: "inProgress" }] }, { data: [{ id: TURN, status: "inProgress" }], nextCursor: 123 }]) {
      const server = pagedServer({ status: newTurn ? "idle" : "active" });
      const client = { async request(method, params) {
        return method === "thread/turns/list" ? badPage : server.client.request(method, params);
      } };
      await assert.rejects(sendOnClient(client, ID, "must not send", { newTurn, subscribe: () => assert.fail("must not resume") }), { code: "STALE_CURSOR" });
      assert.equal(server.calls.filter(call => call.method.startsWith("turn/")).length, 0);
    }
  }
  let pages = 0;
  const server = pagedServer();
  await assert.rejects(sendOnClient({ async request(method, params) {
    if (method === "thread/turns/list") return { data: [{ id: `page-${++pages}`, status: "completed" }], nextCursor: "repeat" };
    return server.client.request(method, params);
  } }, ID, "must not send"), { code: "STALE_CURSOR" });
  assert.equal(pages, 2);
});

test("paged metadata is rechecked for task, input permission, and state changes", async () => {
  for (const change of [{ id: TURN }, { canAcceptDirectInput: false }, { status: { type: "idle" } }, { historyMode: "inline" }]) {
    let reads = 0;
    const { client, calls } = pagedServer({ beforeRequest(method, _params, metadata) {
      if (method === "thread/read" && ++reads === 2) Object.assign(metadata, change);
    } });
    await assert.rejects(sendOnClient(client, ID, "must not send"));
    assert.equal(calls.filter(call => call.method.startsWith("turn/")).length, 0);
  }
});

test("paged new-turn validates both sides of Desktop subscription without full history", async () => {
  for (const status of ["idle", "notLoaded"]) {
    const { client, metadata, calls } = pagedServer({ status, turns: [{ id: "previous", status: "completed" }] });
    let checks = 0, subscriptions = 0;
    const receipt = await sendOnClient(client, ID, "start explicitly", { newTurn: true,
      beforeSend: async state => { checks++; assert.equal(state.turns[0].itemsView, "notLoaded"); },
      subscribe: async () => { assert.equal(checks, 1); subscriptions++; metadata.status.type = "idle"; },
    });
    assert.equal(checks, 2); assert.equal(subscriptions, 1); assert.equal(receipt.turn_id, TURN);
    assert.deepEqual(calls.filter(call => call.method.startsWith("turn/")).map(call => call.method), ["turn/start"]);
  }
  const { client, metadata, calls } = pagedServer({ status: "idle", turns: [] });
  await assert.rejects(sendOnClient(client, ID, "must not start", { newTurn: true, subscribe: async () => { metadata.status.type = "active"; } }), /became active/);
  assert.equal(calls.filter(call => call.method.startsWith("turn/")).length, 0);
  const inconsistent = pagedServer({ status: "idle" });
  await assert.rejects(sendOnClient(inconsistent.client, ID, "must not resume", { newTurn: true, subscribe: () => assert.fail("active turn must prevent resume") }), /idle/);
});

test("paged sends require pagination capability and stop on rejected page reads", async t => {
  const root = await mkdtemp("/private/tmp/cs-paged-compat-"); t.after(() => rm(root, { recursive: true, force: true }));
  for (const newTurn of [false, true]) {
    for (const failure of ["CAPABILITY_UNSUPPORTED", "RPC_REJECTED"]) {
      const { client, calls } = pagedServer({ status: newTurn ? "idle" : "active", beforeRequest(method) {
        if (method === "thread/turns/list") throw new RpcFailure("page rejected", { code: "RPC_REJECTED", rpcCode: -32601 });
      } });
      await assert.rejects(sendAppServerMessage(ID, "must not send", {
        newTurn,
        discover: async () => ({ paths: { lease: root, socket: "unused" }, state: { ...steerState, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, history_pagination: failure === "CAPABILITY_UNSUPPORTED" ? [2] : [1] } } }),
        inspectControl: async () => {}, connect: async () => client,
        subscribe: () => assert.fail("must not resume"),
      }), { code: failure, sent: false, delivery_status: "not_sent" });
      assert.equal(calls.filter(call => call.method.startsWith("turn/")).length, 0);
    }
  }
});
