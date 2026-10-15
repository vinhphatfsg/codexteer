import test from "node:test";
import assert from "node:assert/strict";
import { readFile, lstat, access } from "node:fs/promises";
import { nativeOnAppServer, validateNativeCommandSchema, validateStandaloneCreationSchemas, inspectNativeCommandProtocol } from "../src/native-command.mjs";
import { BUNDLED_NODE } from "../src/wrapper.mjs";
import { RpcFailure } from "../src/rpc.mjs";

const CONTEXT = { threadId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", turnId: "stored-turn" };
const args = { prompt: "サンプル😀\n$(literal) `no shell`", target: { type: "project", projectId: "local-project", environment: { type: "local" } } };
const endpoint = { socketPath: "/private/native", fingerprint: [1, 2, 3] };

test("fixed read-only helper executes without a thread/turn, private input stays off argv, and files are cleaned", async () => {
  let requestFile, calls = 0;
  const result = await nativeOnAppServer({ async request(method, params, options) {
    calls++;
    assert.equal(method, "command/exec"); assert.equal(options.mutation, true);
    assert.equal(params.command[0], BUNDLED_NODE); assert.match(params.command[1], /\/native-worker\.mjs$/);
    assert.equal(params.command.length, 3); assert.equal(params.command.join(" ").includes(args.prompt), false);
    assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: true });
    requestFile = params.command[2]; assert.equal((await lstat(requestFile)).mode & 0o777, 0o600);
    const input = JSON.parse(await readFile(requestFile, "utf8"));
    assert.deepEqual(input.args, args); assert.deepEqual(input.context, CONTEXT); assert.equal(input.callId, "unique-call"); assert.deepEqual(input.endpoint, endpoint);
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { success: true, text: "サンプル😀" } }), stderr: "" };
  } }, endpoint, "create_thread", args, CONTEXT, { callId: "unique-call" });
  assert.deepEqual(result, { success: true, text: "サンプル😀" }); assert.equal(calls, 1);
  await assert.rejects(access(requestFile), { code: "ENOENT" });
});

test("helper failures preserve uncertainty, reject unsupported execution definitively, and never retry", async () => {
  for (const mode of ["lost", "malformed", "worker-rejected", "unsupported"]) {
    let calls = 0, file;
    await assert.rejects(nativeOnAppServer({ async request(method, params) {
      calls++; file = params.command[2];
      if (mode === "lost") throw new Error("connection lost");
      if (mode === "unsupported") throw Object.assign(new Error("method missing"), { rpcCode: -32601 });
      if (mode === "worker-rejected") return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { message: "invalid before socket", code: "NATIVE_PROTOCOL_ERROR", uncertain: false } }) };
      return { exitCode: 0, stdout: "truncated-json" };
    } }, endpoint, "create_thread", args, CONTEXT), error => error.uncertain === ["lost", "malformed"].includes(mode));
    assert.equal(calls, 1); await assert.rejects(access(file), { code: "ENOENT" });
  }
});

test("matching command and read-only sandbox schemas are required before invoking a helper", async () => {
  assert.throws(() => validateNativeCommandSchema({}, {}), { code: "NATIVE_COMMAND_UNVERIFIED" });
  await assert.rejects(inspectNativeCommandProtocol({ cli_version: "running" }, { run: () => ({ status: 0, stdout: "codex-cli different" }) }), { code: "NATIVE_COMMAND_UNVERIFIED" });
  assert.throws(() => validateStandaloneCreationSchemas({}), { code: "NATIVE_COMMAND_UNVERIFIED" });
});

test("lost self-assignment acknowledgement is a mutation with unknown outcome and no retry", async () => {
  let calls = 0;
  await assert.rejects(nativeOnAppServer({ async request(method, params, options) {
    calls++; assert.equal(method, "command/exec"); assert.equal(options.mutation, true);
    throw new Error("lost");
  } }, endpoint, "move_thread_to_project", { threadId: CONTEXT.threadId, projectId: "local" }, CONTEXT), error => error.uncertain === true);
  assert.equal(calls, 1);
});

test("internal command RPC errors keep native mutation outcomes unknown", async () => {
  for (const rpcCode of [-32603, -32602, -32601]) {
    let calls = 0;
    await assert.rejects(nativeOnAppServer({ async request() {
      calls++;
      throw new RpcFailure("command failed after dispatch", { code: "RPC_REJECTED", rpcCode });
    } }, endpoint, "create_thread", args, CONTEXT), error => error.uncertain === (rpcCode === -32603));
    assert.equal(calls, 1);
  }
});
