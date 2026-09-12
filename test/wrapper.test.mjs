import test from "node:test";
import { VERSION, PACKAGE_NAME } from "../src/version.mjs";
import { RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";
const steerState = { codex_steer_version: VERSION, codex_steer_package: PACKAGE_NAME, codex_steer_protocol: RUNTIME_PROTOCOL };
import assert from "node:assert/strict";
import { BUNDLED_NODE, isDesktopProcess, serverArguments } from "../src/wrapper.mjs";
import { appServerDoctor, desktopLaunchArgs, startDesktop } from "../src/launcher.mjs";
import { RpcFailure } from "../src/rpc.mjs";

test("wrapper preserves TOML argv byte for byte and changes only stdio transport", () => {
  const args = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", 'mcp_servers.codex_app={env={VALUE="$x `literal` 日本語"}}'];
  assert.deepEqual(serverArguments(args, "/private/tmp/a.sock"), [...args, "--listen", "unix:///private/tmp/a.sock"]);
  assert.deepEqual(serverArguments(["app-server", "--stdio"], "/s"), ["app-server", "--listen", "unix:///s"]);
  assert.deepEqual(serverArguments(["app-server", "--listen=stdio://"], "/s"), ["app-server", "--listen", "unix:///s"]);
});

test("only Desktop's direct child is classified as a shared-server launch", () => {
  for (const [stdout, expected] of [
    ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n", true],
    ["/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node\n", false],
    ["/Applications/ChatGPT.app/Contents/Resources/node_repl\n", false],
    ["/usr/bin/zsh\n", false],
  ]) {
    assert.equal(isDesktopProcess({ parentPid: 123, run(command, args) {
      assert.equal(command, "/bin/ps");
      assert.deepEqual(args, ["-p", "123", "-o", "comm="]);
      return { status: 0, stdout };
    } }), expected);
  }
  assert.equal(isDesktopProcess({ run: () => ({ status: 1, stdout: "" }) }), false);
});

test("wrapper leaves unrelated invocations and schema/daemon/proxy subcommands alone", () => {
  for (const args of [["--version"], ["exec", "app-server"], ["app-server", "--help"], ["app-server", "generate-json-schema", "--out", "/tmp/out"], ["app-server", "daemon", "version"], ["app-server", "proxy"], ["-c", "key=app-server", "--version"]]) {
    assert.equal(serverArguments(args, "/s"), null);
  }
});

test("conflicting transports fail rather than starting a second listener", () => {
  assert.throws(() => serverArguments(["app-server", "--listen", "ws://127.0.0.1:1"], "/s"), /conflicting/);
  assert.throws(() => serverArguments(["app-server", "-c"], "/s"), /Incomplete/);
});

test("Desktop launch scopes overrides to one launch and does not force another instance", () => {
  const args = desktopLaunchArgs("/tmp/Codex Home", "/tmp/Wrapper Space/wrapper.mjs");
  assert.deepEqual(args, ["-a", "/Applications/ChatGPT.app", "--env", "CODEX_CLI_PATH=/tmp/Wrapper Space/wrapper.mjs", "--env", "CODEX_HOME=/tmp/Codex Home"]);
  assert.equal(args.includes("-n"), false);
});

test("startup refuses an already-running Desktop without opening or killing it", { skip: process.platform !== "darwin" }, async () => {
  const calls = [];
  await assert.rejects(startDesktop({ run(command, args) {
    calls.push({ command, args });
    return { status: 0, stdout: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n" };
  } }), /already running/);
  assert.deepEqual(calls, [{ command: "/bin/ps", args: ["-axo", "comm="] }]);
});

function doctorFixture(extraState = {}) {
  const calls = [];
  return {
    calls,
    options: {
      versions: { desktop_version: "26.903.71938", cli_version: "0.153.4" },
      inspectControl: async () => {},
      discover: async () => ({ paths: { socket: "/unused" }, state: { ...steerState, cli_version: "0.153.4", ...extraState } }),
      connect: async () => ({
        request: async method => { calls.push(method); return { data: [] }; },
        close: () => { calls.push("close"); },
      }),
    },
  };
}

test("doctor does not certify a connected wrapper with missing or PATH Node provenance", async () => {
  for (const state of [{}, { node_path: "/opt/homebrew/bin/node", node_version: "25.1.0" }]) {
    const { options, calls } = doctorFixture(state);
    const result = await appServerDoctor(options);
    assert.equal(result.ready, false);
    assert.equal(result.checks.runtime, true);
    assert.equal(result.checks.initialized, true);
    assert.equal(result.checks.bundled_wrapper_node, false);
    assert.match(result.remediation, /bundled Node runtime/);
    assert.deepEqual(calls, ["thread/loaded/list", "close"]);
  }
});

test("doctor reports the running bundled Node version and only reads server state", async () => {
  const { options, calls } = doctorFixture({ node_path: BUNDLED_NODE, node_version: "24.20.0" });
  const result = await appServerDoctor(options);
  assert.equal(result.ready, process.platform === "darwin");
  assert.equal(result.checks.bundled_wrapper_node, true);
  assert.equal(result.running_wrapper_node_version, "24.20.0");
  assert.equal(result.remediation, null);
  assert.equal(result.connection.status, "connected");
  assert.equal(result.compatibility.status, "unverified");
  assert.equal(result.compatibility.api_checks["thread/read"], "unverified");
  assert.equal(result.cli_node_version, process.versions.node);
  assert.deepEqual(calls, ["thread/loaded/list", "close"]);
});

const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
test("doctor verifies the requested observation path without returning task contents or mutating it", async () => {
  const { options } = doctorFixture({ node_path: BUNDLED_NODE, node_version: "24.20.0" }), calls = [];
  options.threadId = `codex://threads/${TARGET.toUpperCase()}`;
  options.connect = async () => ({ close() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: [TARGET] };
    assert.equal(method, "thread/read"); assert.equal(params.threadId, TARGET);
    return { thread: { id: TARGET, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [{ id: "a", type: "agentMessage", text: "private-task-content" }] }] } };
  } });
  const result = await appServerDoctor(options);
  assert.equal(result.ready, process.platform === "darwin");
  assert.equal(result.compatibility.status, "verified");
  assert.equal(result.compatibility.scope, "target-observation");
  assert.equal(result.compatibility.thread_id, TARGET);
  assert.equal(result.compatibility.api_checks["thread/read"], "verified");
  assert.equal(result.compatibility.api_checks["thread/items/list"], "unverified");
  assert.deepEqual(result.compatibility.unverified_features, ["steering", "desktop_ui", "approval_roundtrip"]);
  assert.equal(JSON.stringify(result).includes("private-task-content"), false);
  assert.equal(calls.length, 3);
});

test("doctor distinguishes unsupported APIs, invalid responses, safety stops and unavailable transport", async () => {
  for (const [mode, code, status] of [
    ["unsupported", "RPC_REJECTED", "unsupported"],
    ["invalid", "PROTOCOL_ERROR", "failed"],
    ["offline", "CONNECTION_FAILED", "unverified"],
    ["safety-stop", "CAPABILITY_UNVERIFIED", "unverified"],
    ["safety-stop", "RUNTIME_PROTOCOL_UNVERIFIED", "unverified"],
  ]) {
    const { options } = doctorFixture({ node_path: BUNDLED_NODE });
    options.threadId = TARGET;
    options.connect = async () => ({ close() {}, async request(method) {
      if (method === "thread/loaded/list") return { data: [] };
      if (mode === "unsupported") throw new RpcFailure("method not found", { code: "RPC_REJECTED", rpcCode: -32601 });
      if (mode === "offline") throw new RpcFailure("offline");
      if (mode === "safety-stop") throw Object.assign(new Error("Cannot verify the required contract."), { code });
      return { thread: { id: "wrong-task", turns: [] } };
    } });
    const result = await appServerDoctor(options);
    assert.equal(result.ready, false);
    assert.equal(result.compatibility.status, status, code);
    assert.equal(result.compatibility.api_checks["thread/read"], status, code);
    assert.equal(result.failure.code, code);
    assert.equal(result.connection.status, mode === "offline" ? "unavailable" : "connected");
    assert.equal(result.checks.observation, false);
  }
});

test("doctor preserves local pagination guard results without calling the blocked API", async () => {
  for (const [versions, status, code] of [
    [null, "unverified", "CAPABILITY_UNVERIFIED"],
    [[], "unsupported", "CAPABILITY_UNSUPPORTED"],
  ]) {
    const { options, calls } = doctorFixture({ node_path: BUNDLED_NODE, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, history_pagination: versions } });
    options.threadId = TARGET;
    options.connect = async () => ({ close() { calls.push("close"); }, async request(method) {
      calls.push(method);
      if (method === "thread/loaded/list") return { data: [TARGET] };
      assert.equal(method, "thread/read", "the pagination guard must stop before the runtime call");
      return { thread: { id: TARGET, status: { type: "idle" }, turns: [], historyMode: "paginated" } };
    } });
    const result = await appServerDoctor(options);
    assert.equal(result.ready, false);
    assert.equal(result.checks.observation, false);
    assert.equal(result.connection.status, "connected");
    assert.equal(result.compatibility.status, status);
    assert.deepEqual(result.compatibility.api_checks, {
      initialize: "verified", "thread/loaded/list": "verified", "thread/read": "verified",
      "thread/turns/list": status, "thread/items/list": "unverified",
    });
    assert.equal(result.runtime_compatibility.features.history_pagination.status, status);
    assert.deepEqual(result.failure, { code, rpc_code: null, method: "thread/turns/list", capability: "history_pagination" });
    assert.deepEqual(calls, ["thread/loaded/list", "thread/read", "close"]);
  }
});

test("doctor leaves unattempted compatibility checks unverified when discovery fails", async () => {
  const { options } = doctorFixture();
  options.discover = async () => { throw Object.assign(new Error("offline"), { code: "RUNTIME_UNAVAILABLE" }); };
  options.connect = async () => assert.fail("No connection without a verified runtime");
  const result = await appServerDoctor(options);
  assert.equal(result.ready, false);
  assert.equal(result.compatibility.status, "unverified");
  assert.ok(Object.values(result.compatibility.api_checks).every(x => x === "unverified"));
  assert.equal(result.failure.method, null);
});

test("doctor treats unknown or different product versions and package names as diagnostics", async () => {
  for (const extra of [{ codex_steer_version: undefined }, { codex_steer_version: "0.1.0" }, { codex_steer_package: "@vinhphatfsg/codex-steer" }, { cli_version: "0.153.3" }]) {
    const { options } = doctorFixture({ node_path: BUNDLED_NODE, ...extra });
    const result = await appServerDoctor(options);
    assert.equal(result.ready, process.platform === "darwin"); assert.equal(result.checks.codex_steer_version, undefined);
    assert.equal(result.codex_steer_compatibility.status, "cli_version" in extra ? "matched" : extra.codex_steer_version === undefined && "codex_steer_version" in extra ? "unverified" : "mismatch");
    assert.equal(result.runtime_compatibility.operations.send.status, "supported");
    assert.equal(result.failure, null);
    assert.equal(result.cli_version_status, "cli_version" in extra ? "mismatch" : "matched");
  }
});

test("doctor rejects incompatible common protocol before connecting", async () => {
  const { options } = doctorFixture({ node_path: BUNDLED_NODE, codex_steer_protocol: 2 });
  options.connect = () => assert.fail("unknown wire protocol must not connect");
  const result = await appServerDoctor(options);
  assert.equal(result.ready, false); assert.equal(result.failure.code, "RUNTIME_PROTOCOL_UNSUPPORTED");
  assert.equal(result.runtime_compatibility.operations.read.status, "unsupported");
  assert.equal(result.codex_steer_compatibility.status, "matched");
});

test("doctor isolates missing/unsafe subscription endpoints from observation readiness", async () => {
  for (const code of ["DESKTOP_SUBSCRIPTION_UNAVAILABLE", "RUNTIME_UNSAFE", "PERMISSION_DENIED"]) {
    const { options, calls } = doctorFixture({ node_path: BUNDLED_NODE });
    options.inspectControl = async () => { throw Object.assign(new Error("test"), { code }); };
    const result = await appServerDoctor(options);
    assert.equal(result.ready, process.platform === "darwin");
    assert.equal(result.runtime_compatibility.operations.read.status, "supported");
    assert.equal(result.runtime_compatibility.operations.send.status, "supported");
    assert.equal(result.runtime_compatibility.operations.send_new_turn.status, code === "DESKTOP_SUBSCRIPTION_UNAVAILABLE" ? "unsupported" : "failed");
    assert.equal(result.desktop_subscription.code, code);
    assert.deepEqual(calls, ["thread/loaded/list", "close"]);
  }
});

test("doctor reports unsupported individual features without blocking other operations", async () => {
  const { options } = doctorFixture({ node_path: BUNDLED_NODE, codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, turn_steer: [2] } });
  const result = await appServerDoctor(options);
  assert.equal(result.ready, process.platform === "darwin");
  assert.equal(result.runtime_compatibility.operations.send.status, "unsupported");
  assert.equal(result.runtime_compatibility.operations.send_new_turn.status, "supported");
});

test("doctor verifies observation for unknown legacy runtimes without probing mutations", async () => {
  const { options } = doctorFixture({ schema: 1, node_path: BUNDLED_NODE, cli_version: "0.150.0", codex_steer_protocol: undefined, codex_steer_version: undefined, codex_steer_package: undefined });
  options.threadId = TARGET;
  options.connect = async () => ({ close() {}, async request(method) {
    if (method === "thread/loaded/list") return { data: [] };
    assert.equal(method, "thread/read");
    return { thread: { id: TARGET, status: { type: "idle" }, turns: [] } };
  } });
  const result = await appServerDoctor(options);
  assert.equal(result.ready, process.platform === "darwin");
  assert.equal(result.codex_steer_compatibility.status, "unverified");
  assert.equal(result.compatibility.status, "verified");
  assert.equal(result.runtime_compatibility.operations.read.status, "supported");
  assert.equal(result.runtime_compatibility.features.thread_read.source, "probe-verified");
  assert.equal(result.runtime_compatibility.operations.send.status, "unverified");
});

test("startup uses the prepared path and rejects another runtime's distribution", { skip: process.platform !== "darwin" }, async () => {
  const calls = [];
  const options = { run(command, args) { calls.push({ command, args }); return { status: 0, stdout: "" }; },
    prepare: async () => ({ wrapper_path: "/private/tmp/Verified Wrapper/bin/wrapper.mjs", sha256: "expected" }),
    discover: async () => ({ paths: { socket: "/fake" }, state: { ...steerState, distribution_sha256: "different" } }),
    connect: async () => assert.fail("must not connect to a different distribution"),
  };
  await assert.rejects(startDesktop(options), { code: "DEPLOYMENT_MISMATCH" });
  assert.equal(calls[1].args.includes("CODEX_CLI_PATH=/private/tmp/Verified Wrapper/bin/wrapper.mjs"), true);
});

test("startup confirms its deployed distribution and dry-run never places or connects", { skip: process.platform !== "darwin" }, async () => {
  const deployed = { wrapper_path: "/private/tmp/wrapper.mjs", sha256: "expected" };
  let connected = false;
  const result = await startDesktop({
    run: () => ({ status: 0, stdout: "" }), prepare: async () => deployed,
    discover: async () => ({ paths: { socket: "/fake" }, state: { ...steerState, distribution_sha256: deployed.sha256 } }),
    connect: async () => ({ close() { connected = true; } }),
  });
  assert.equal(connected, true); assert.deepEqual(result.deployment, deployed); assert.equal(result.started, true);
  await startDesktop({ dryRun: true, prepare: () => assert.fail("dry-run must not deploy"), run: () => assert.fail("dry-run must not execute"), discover: () => assert.fail("dry-run must not discover") });
});
