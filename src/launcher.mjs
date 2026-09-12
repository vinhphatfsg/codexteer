import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { codexHome, discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { BUNDLED_CLI, BUNDLED_NODE } from "./wrapper.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { readOnClient } from "./observe.mjs";
import { VERSION } from "./help.mjs";
import { versionCompatibility, assertCompatibleVersion } from "./version.mjs";
import { prepareDeployment } from "./distribution.mjs";

export const APP_PATH = "/Applications/ChatGPT.app";

export function installedVersions() {
  const app = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", `${APP_PATH}/Contents/Info.plist`], { encoding: "utf8", timeout: 3000 });
  const cli = spawnSync(BUNDLED_CLI, ["--version"], { encoding: "utf8", timeout: 5000 });
  return {
    desktop_version: app.status === 0 && /^[\d.]+$/.test(app.stdout.trim()) ? app.stdout.trim() : null,
    cli_version: cli.status === 0 ? cli.stdout.match(/codex-cli ([\w.+-]+)/)?.[1] ?? null : null,
  };
}

export async function appServerDoctor({ threadId: threadInput, versions = installedVersions(), discover = () => discoverRuntime(undefined, { requireCompatible: false }), connect = path => RpcClient.connect(path) } = {}) {
  const threadId = threadInput === undefined ? null : normalizeThreadId(threadInput);
  const checks = { macos: process.platform === "darwin", bundled_cli: Boolean(versions.cli_version), desktop_app: Boolean(versions.desktop_version), runtime: false, initialized: false, bundled_wrapper_node: false, codex_steer_version: false };
  if (threadId) checks.observation = false;
  const compatibility = {
    status: "unverified", scope: threadId ? "target-observation" : "connection-only", thread_id: threadId,
    api_checks: Object.fromEntries(["initialize", "thread/loaded/list", "thread/read", "thread/turns/list", "thread/items/list"].map(method => [method, "unverified"])),
    unverified_features: ["steering", "desktop_ui", "approval_roundtrip"],
  };
  let client;
  let remediation = null;
  let serverVersion = null;
  let wrapperNodeVersion = null;
  let connectionStatus = "unavailable", failure = null, method = null;
  let steerCompatibility = versionCompatibility();
  try {
    const { paths, state } = await discover();
    checks.runtime = true;
    serverVersion = state.cli_version;
    steerCompatibility = versionCompatibility(state);
    checks.codex_steer_version = steerCompatibility.status === "matched";
    wrapperNodeVersion = state.node_version ?? null;
    checks.bundled_wrapper_node = state.node_path === BUNDLED_NODE;
    method = "initialize";
    client = await connect(paths.socket);
    connectionStatus = "connected";
    compatibility.api_checks.initialize = "verified";
    method = "thread/loaded/list";
    const loaded = await client.request(method);
    if (!Array.isArray(loaded?.data) || !loaded.data.every(id => typeof id === "string")) {
      throw Object.assign(new Error("App Server returned an invalid loaded-task list."), { code: "PROTOCOL_ERROR" });
    }
    compatibility.api_checks[method] = "verified";
    checks.initialized = true;
    method = null;
    if (versions.cli_version !== state.cli_version) throw Object.assign(new Error("Desktop was updated. Finish current tasks and restart with codex-steer desktop start."), { code: "CLI_VERSION_MISMATCH" });
    if (!checks.bundled_wrapper_node) throw Object.assign(new Error("The running wrapper does not confirm Desktop's bundled Node runtime. App tools may fail code-signing authorization. Finish current tasks, quit Desktop, then run: codex-steer desktop start"), { code: "WRAPPER_NODE_UNVERIFIED" });
    assertCompatibleVersion(state);
    if (threadId) {
      const called = new Set();
      const probe = { request(name, ...args) { method = name; called.add(name); return client.request(name, ...args); } };
      const observation = await readOnClient(probe, threadId, { limit: 1, maxChars: 100 });
      for (const name of called) compatibility.api_checks[name] = "verified";
      compatibility.status = "verified";
      compatibility.history_scope = observation.history_scope;
      checks.observation = true;
    }
  } catch (error) {
    remediation = error.message;
    failure = { code: error.code ?? "DIAGNOSTIC_FAILED", rpc_code: error.rpcCode ?? null, method };
    const unavailable = ["CONNECTION_FAILED", "TIMEOUT", "RUNTIME_UNAVAILABLE", "RUNTIME_NOT_READY"].includes(error.code);
    if (method && !unavailable) {
      compatibility.status = error.rpcCode === -32601 ? "unsupported" : "failed";
      compatibility.api_checks[method] = compatibility.status;
    }
    if (unavailable) connectionStatus = "unavailable";
  } finally { client?.close(); }
  return { ready: !remediation && Object.values(checks).every(Boolean), backend: "app-server", ...versions,
    codex_steer_version: VERSION, cli_node_version: process.versions.node,
    running_cli_version: serverVersion, running_wrapper_node_version: wrapperNodeVersion,
    codex_steer_compatibility: steerCompatibility,
    connection: { status: connectionStatus }, compatibility, failure, checks, remediation };
}

export function desktopLaunchArgs(home, wrapper) {
  if (typeof wrapper !== "string" || !wrapper.startsWith("/")) throw new Error("Desktop startup requires a verified wrapper path.");
  return ["-a", APP_PATH, "--env", `CODEX_CLI_PATH=${wrapper}`, "--env", `CODEX_HOME=${home}`];
}

export async function startDesktop({ dryRun = false, run = spawnSync, prepare = prepareDeployment, discover = discoverRuntime, connect = RpcClient.connect } = {}) {
  const home = codexHome();
  if (dryRun) return { backend: "app-server", dry_run: true, started: false, command: "desktop.start" };
  if (process.platform !== "darwin") throw new Error("Desktop startup requires macOS.");
  if (process.env.CODEX_APP_SERVER_WS_URL?.trim()) throw new Error("An existing CODEX_APP_SERVER_WS_URL override conflicts with shared Desktop startup. Remove it from this launch environment first.");
  await access(BUNDLED_CLI, constants.X_OK);
  await access(BUNDLED_NODE, constants.X_OK);
  // No Accessibility APIs, focus changes, process termination, or -n (new instance).
  const processes = run("/bin/ps", ["-axo", "comm="], { encoding: "utf8", timeout: 3000 });
  if (processes.status !== 0) throw new Error("Cannot check whether Desktop is running. Run desktop start from your terminal.");
  if (processes.stdout.split("\n").some(line => line.trim() === `${APP_PATH}/Contents/MacOS/ChatGPT`)) {
    throw new Error("Desktop is already running. Finish current tasks and quit Desktop, then run: codex-steer desktop start");
  }
  const deployment = await prepare(home);
  const launched = run("/usr/bin/open", desktopLaunchArgs(home, deployment.wrapper_path), { encoding: "utf8", timeout: 5000 });
  if (launched.status !== 0) throw new Error("Desktop launch failed. Normal startup from the Dock is still available.");
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const { paths, state } = await discover(home);
      assertCompatibleVersion(state);
      if (state.distribution_sha256 !== deployment.sha256) throw Object.assign(new Error("The running wrapper is not the distribution selected for this launch."), { code: "DEPLOYMENT_MISMATCH" });
      const client = await connect(paths.socket, { timeoutMs: 1000 });
      client.close();
      return { backend: "app-server", dry_run: false, started: true, ...installedVersions(), deployment };
    } catch (error) {
      if (!["RUNTIME_UNAVAILABLE", "RUNTIME_NOT_READY", "CONNECTION_FAILED", "TIMEOUT"].includes(error.code)) throw error;
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Desktop started, but its shared App Server is not ready. ${lastError?.message ?? ""}`);
}
