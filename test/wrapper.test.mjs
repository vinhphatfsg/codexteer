import test from "node:test";
import assert from "node:assert/strict";
import { BUNDLED_NODE, isDesktopProcess, serverArguments } from "../src/wrapper.mjs";
import { appServerDoctor, desktopLaunchArgs, startDesktop } from "../src/launcher.mjs";

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
      discover: async () => ({ paths: { socket: "/unused" }, state: { cli_version: "0.153.4", ...extraState } }),
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
  assert.deepEqual(calls, ["thread/loaded/list", "close"]);
});
