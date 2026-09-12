import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { codexHome, discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { BUNDLED_CLI, BUNDLED_NODE } from "./wrapper.mjs";

export const APP_PATH = "/Applications/ChatGPT.app";
const WRAPPER = fileURLToPath(new URL("../bin/codex-steer-wrapper.mjs", import.meta.url));

export function installedVersions() {
  const app = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", `${APP_PATH}/Contents/Info.plist`], { encoding: "utf8", timeout: 3000 });
  const cli = spawnSync(BUNDLED_CLI, ["--version"], { encoding: "utf8", timeout: 5000 });
  return {
    desktop_version: app.status === 0 && /^[\d.]+$/.test(app.stdout.trim()) ? app.stdout.trim() : null,
    cli_version: cli.status === 0 ? cli.stdout.match(/codex-cli ([\w.+-]+)/)?.[1] ?? null : null,
  };
}

export async function appServerDoctor({ versions = installedVersions(), discover = discoverRuntime, connect = path => RpcClient.connect(path) } = {}) {
  const checks = { macos: process.platform === "darwin", bundled_cli: Boolean(versions.cli_version), desktop_app: Boolean(versions.desktop_version), runtime: false, initialized: false, bundled_wrapper_node: false };
  let client;
  let remediation = null;
  let serverVersion = null;
  let wrapperNodeVersion = null;
  try {
    const { paths, state } = await discover();
    checks.runtime = true;
    serverVersion = state.cli_version;
    wrapperNodeVersion = state.node_version ?? null;
    checks.bundled_wrapper_node = state.node_path === BUNDLED_NODE;
    client = await connect(paths.socket);
    await client.request("thread/loaded/list");
    checks.initialized = true;
    if (versions.cli_version !== state.cli_version) throw new Error("Desktop was updated. Finish current tasks and restart with codex-steer desktop start.");
    if (!checks.bundled_wrapper_node) throw new Error("The running wrapper does not confirm Desktop's bundled Node runtime. App tools may fail code-signing authorization. Finish current tasks, quit Desktop, then run: codex-steer desktop start");
  } catch (error) { remediation = error.message; } finally { client?.close(); }
  return { ready: !remediation && Object.values(checks).every(Boolean), backend: "app-server", ...versions, running_cli_version: serverVersion, running_wrapper_node_version: wrapperNodeVersion, checks, remediation };
}

export function desktopLaunchArgs(home, wrapper = WRAPPER) {
  return ["-a", APP_PATH, "--env", `CODEX_CLI_PATH=${wrapper}`, "--env", `CODEX_HOME=${home}`];
}

export async function startDesktop({ dryRun = false, run = spawnSync } = {}) {
  const home = codexHome();
  if (dryRun) return { backend: "app-server", dry_run: true, started: false, command: "desktop.start" };
  if (process.platform !== "darwin") throw new Error("Desktop startup requires macOS.");
  if (process.env.CODEX_APP_SERVER_WS_URL?.trim()) throw new Error("An existing CODEX_APP_SERVER_WS_URL override conflicts with shared Desktop startup. Remove it from this launch environment first.");
  await access(WRAPPER, constants.X_OK);
  await access(BUNDLED_CLI, constants.X_OK);
  await access(BUNDLED_NODE, constants.X_OK);
  // No Accessibility APIs, focus changes, process termination, or -n (new instance).
  const processes = run("/bin/ps", ["-axo", "comm="], { encoding: "utf8", timeout: 3000 });
  if (processes.status !== 0) throw new Error("Cannot check whether Desktop is running. Run desktop start from your terminal.");
  if (processes.stdout.split("\n").some(line => line.trim() === `${APP_PATH}/Contents/MacOS/ChatGPT`)) {
    throw new Error("Desktop is already running. Finish current tasks and quit Desktop, then run: codex-steer desktop start");
  }
  const launched = run("/usr/bin/open", desktopLaunchArgs(home), { encoding: "utf8", timeout: 5000 });
  if (launched.status !== 0) throw new Error("Desktop launch failed. Normal startup from the Dock is still available.");
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const { paths } = await discoverRuntime(home);
      const client = await RpcClient.connect(paths.socket, { timeoutMs: 1000 });
      client.close();
      return { backend: "app-server", dry_run: false, started: true, ...installedVersions() };
    } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`Desktop started, but its shared App Server is not ready. ${lastError?.message ?? ""}`);
}
