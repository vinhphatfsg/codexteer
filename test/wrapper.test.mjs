import test from "node:test";
import { VERSION, PACKAGE_NAME, RUNTIME_PROTOCOL } from "../src/version.mjs";
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

test("doctor distinguishes unsupported APIs, invalid responses and unavailable transport", async () => {
  for (const mode of ["unsupported", "invalid", "offline"]) {
    const { options } = doctorFixture({ node_path: BUNDLED_NODE });
    options.threadId = TARGET;
    options.connect = async () => ({ close() {}, async request(method) {
      if (method === "thread/loaded/list") return { data: [] };
      if (mode === "unsupported") throw new RpcFailure("method not found", { code: "RPC_REJECTED", rpcCode: -32601 });
      if (mode === "offline") throw new RpcFailure("offline");
      return { thread: { id: "wrong-task", turns: [] } };
    } });
    const result = await appServerDoctor(options);
    assert.equal(result.ready, false);
    assert.equal(result.compatibility.status, mode === "offline" ? "unverified" : mode === "unsupported" ? "unsupported" : "failed");
    assert.equal(result.failure.code, mode === "offline" ? "CONNECTION_FAILED" : mode === "unsupported" ? "RPC_REJECTED" : "PROTOCOL_ERROR");
    assert.equal(result.connection.status, mode === "offline" ? "unavailable" : "connected");
    assert.equal(result.checks.observation, false);
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

test("doctor diagnoses missing versions, different packages and protocol mismatches without certifying them", async () => {
  for (const extra of [{ codex_steer_version: undefined }, { codex_steer_version: "0.1.0" }, { codex_steer_package: "codex-steer" }, { codex_steer_protocol: 2 }]) {
    const { options } = doctorFixture({ node_path: BUNDLED_NODE, ...extra });
    const result = await appServerDoctor(options);
    assert.equal(result.ready, false); assert.equal(result.checks.codex_steer_version, false);
    assert.equal(result.codex_steer_compatibility.status, extra.codex_steer_version === undefined && "codex_steer_version" in extra ? "unverified" : "mismatch");
    assert.match(result.failure.code, /^STEER_VERSION_/);
  }
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
