import test from "node:test";
import assert from "node:assert/strict";
import { assertRuntimeOperation, compatibleClient, runtimeCompatibility, RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";
import { observeThread } from "../src/observe.mjs";

const modern = { codex_steer_protocol: 1, codex_steer_capabilities: RUNTIME_CAPABILITIES };
const ID = "11111111-1111-4111-8111-111111111111";

test("package releases do not define protocol compatibility", () => {
  for (const version of [undefined, "0.13.0", "0.14.0", "99.1.0", "untrusted\ntext"]) {
    const result = assertRuntimeOperation({ ...modern, codex_steer_version: version }, "send");
    assert.equal(result.operations.send.status, "supported");
    assert.equal(JSON.stringify(result).includes("untrusted"), false);
  }
});

test("additive capability versions and unknown features do not block supported v1", () => {
  const state = { ...modern, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, turn_steer: [2, 1], future: "opaque" } };
  assert.equal(assertRuntimeOperation(state, "send").operations.send.status, "supported");
  assert.equal(runtimeCompatibility(state).features.future, undefined);
});

test("unsupported feature versions affect only dependent operations", () => {
  const state = { ...modern, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, desktop_subscribe: [2], turn_steer: [3] } };
  for (const op of ["read", "watch", "monitor", "history_check"]) assertRuntimeOperation(state, op);
  assert.throws(() => assertRuntimeOperation(state, "send"), { code: "CAPABILITY_UNSUPPORTED", capability: "turn_steer" });
  assert.throws(() => assertRuntimeOperation(state, "send_new_turn"), { code: "CAPABILITY_UNSUPPORTED", capability: "desktop_subscribe" });
});

test("missing and malformed explicit capabilities never fall back to a legacy profile", () => {
  for (const value of [null, [], {}, { turn_steer: "1" }, { turn_steer: Array(17).fill(1) }]) {
    assert.throws(() => assertRuntimeOperation({ ...modern, codex_steer_capabilities: value }, "send"), error => /^CAPABILITY_/.test(error.code));
  }
  for (const value of [null, "1", [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    const state = { ...modern, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, desktop_subscribe: value } };
    assertRuntimeOperation(state, "send");
    assert.throws(() => assertRuntimeOperation(state, "send_new_turn"), { code: "CAPABILITY_UNVERIFIED" });
  }
});

test("known legacy aggregate and pre-version wrappers keep their verified v1 wire contract", () => {
  const legacy = { schema: 1, cli_version: "0.153.4", node_path: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" };
  assert.equal(assertRuntimeOperation({ codex_steer_protocol: 1 }, "send").features.turn_steer.source, "legacy-v1");
  assert.equal(assertRuntimeOperation(legacy, "send_new_turn").features.desktop_subscribe.source, "legacy-0.153.4");
  for (const altered of [{ cli_version: "0.153.3" }, { node_path: "/usr/bin/node" }, { schema: 2 }, { codex_steer_version: "unrecognized" }]) {
    assertRuntimeOperation({ ...legacy, ...altered }, "read");
    assert.throws(() => assertRuntimeOperation({ ...legacy, ...altered }, "send"), { code: "RUNTIME_PROTOCOL_UNVERIFIED" });
  }
});

test("unknown legacy metadata permits read-only validation, but not write probing", async () => {
  const calls = [];
  const client = compatibleClient({ close() {}, request(method) { calls.push(method); return {}; } }, {});
  for (const method of ["thread/read", "thread/turns/list", "thread/items/list"]) await client.request(method);
  assert.throws(() => client.request("turn/steer"), { code: "RUNTIME_PROTOCOL_UNVERIFIED" });
  assert.deepEqual(calls, ["thread/read", "thread/turns/list", "thread/items/list"]);
});

test("explicit malformed or unsupported common protocol does not permit a read probe", () => {
  for (const version of [null, "1", -1, 0, 2, 999]) {
    assert.throws(() => assertRuntimeOperation({ ...modern, codex_steer_protocol: version }, "read"), error => /^RUNTIME_PROTOCOL_/.test(error.code));
  }
});

test("probe evidence never overrides explicit declarations or known legacy contracts", () => {
  for (const state of [modern, { codex_steer_protocol: 1 }, { ...modern, codex_steer_protocol: null },
    { ...modern, codex_steer_capabilities: null }, { ...modern, codex_steer_capabilities: {} }]) {
    assert.deepEqual(runtimeCompatibility(state, {
      verifiedMethods: ["initialize", "thread/read", "thread/turns/list"], unsupportedMethods: ["thread/items/list"],
    }), runtimeCompatibility(state));
  }
});

test("pagination incompatibility does not block full-history read or short watch on an unpaged task", async () => {
  const state = { ...modern, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, history_pagination: [2] } };
  let paginated = false, reads = 0;
  const dependencies = {
    discover: async () => ({ state, paths: { socket: "unused" } }),
    connect: async () => ({ close() {}, async request(method) {
      assert.equal(method, "thread/read"); reads++;
      return { thread: { id: ID, status: { type: "idle" }, turns: [], ...(paginated ? { historyMode: "paginated" } : {}) } };
    } }),
  };
  assert.equal((await observeThread(ID, {}, dependencies)).thread_id, ID);
  assert.equal((await observeThread(ID, { watch: true, until: "idle" }, dependencies)).timed_out, false);
  assert.equal(reads, 4);
  paginated = true;
  await assert.rejects(observeThread(ID, {}, dependencies), { code: "CAPABILITY_UNSUPPORTED", capability: "history_pagination" });
  assert.equal(reads, 5);
});

test("unsupported baseline read contract is rejected before connecting", async () => {
  await assert.rejects(observeThread(ID, {}, {
    discover: async () => ({ paths: {}, state: { ...modern, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, thread_read: [2] } } }),
    connect: () => assert.fail("must not connect"),
  }), { code: "CAPABILITY_UNSUPPORTED", capability: "thread_read" });
});
