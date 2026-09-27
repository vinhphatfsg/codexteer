import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { claimRuntime } from "./runtime.mjs";
import { connectSocket } from "./rpc.mjs";
import { relay } from "./bridge.mjs";
import { DesktopSubscriptions, serveSubscriptions } from "./subscription.mjs";
import { VERSION, PACKAGE_NAME } from "./version.mjs";
import { RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } from "./compatibility.mjs";
import { describeDistribution } from "./distribution.mjs";
import { inspectAppServerSocket } from "./socket-endpoint.mjs";

const DESKTOP_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";
const LEGACY_BUNDLED_CLI = path.join(DESKTOP_RESOURCES, "codex");

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveManifestCli(packageDirectory, resourcesDirectory) {
  try {
    const root = realpathSync(packageDirectory);
    if (!isWithinDirectory(resourcesDirectory, root)) return null;
    const manifest = JSON.parse(readFileSync(path.join(root, "codex-package.json"), "utf8"));
    if ((manifest.variant != null && manifest.variant !== "codex")
      || (manifest.layoutVersion != null && (!Number.isSafeInteger(manifest.layoutVersion) || manifest.layoutVersion < 1))
      || typeof manifest.entrypoint !== "string" || manifest.entrypoint.length === 0
      || manifest.entrypoint.includes("\0") || path.isAbsolute(manifest.entrypoint)
      || manifest.entrypoint.split(/[\\/]/).some(part => part === "" || part === "." || part === "..")) return null;

    const entrypoint = realpathSync(path.resolve(root, manifest.entrypoint));
    if (!isWithinDirectory(root, entrypoint) || !statSync(entrypoint).isFile()) return null;
    accessSync(entrypoint, fsConstants.X_OK);
    return entrypoint;
  } catch {
    return null;
  }
}

function resolveBundledCli() {
  try {
    const resourcesDirectory = realpathSync(DESKTOP_RESOURCES);
    const packages = readdirSync(resourcesDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => path.join(resourcesDirectory, entry.name))
      .sort();
    const manifestCli = packages.map(directory => resolveManifestCli(directory, resourcesDirectory)).find(Boolean);
    if (manifestCli) return manifestCli;
  } catch {
    // Fall through to the pre-manifest app layout.
  }

  try {
    if (statSync(LEGACY_BUNDLED_CLI).isFile()) {
      accessSync(LEGACY_BUNDLED_CLI, fsConstants.X_OK);
      return LEGACY_BUNDLED_CLI;
    }
  } catch {
    // Preserve the legacy path for a useful ENOENT diagnostic at startup.
  }
  return LEGACY_BUNDLED_CLI;
}

export const BUNDLED_CLI = resolveBundledCli();
export const BUNDLED_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
const DESKTOP_EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";

export function isDesktopProcess({ parentPid = process.ppid, run = spawnSync } = {}) {
  const parent = run("/bin/ps", ["-p", String(parentPid), "-o", "comm="], { encoding: "utf8", timeout: 3000 });
  return parent.status === 0 && parent.stdout.trim() === DESKTOP_EXECUTABLE;
}

async function forwardInvocation(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map(signal => () => child.kill(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  try {
    const [code, signal] = await once(child, "exit");
    return code ?? (signal ? 1 : 0);
  } finally {
    signals.forEach((signal, index) => process.off(signal, handlers[index]));
  }
}

export function serverArguments(args, socketPath) {
  // Parse CLI/global options, not substrings of TOML values or user prompts.
  const values = new Set(["-c", "--config", "--enable", "--disable"]);
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (values.has(args[index])) index += 2;
    else if (/^--(?:config|enable|disable)=/.test(args[index])) index++;
    else return null;
  }
  if (args[index] !== "app-server") return null;
  const transformed = args.slice(0, index + 1);
  for (let i = index + 1; i < args.length; i++) {
    const arg = args[i];
    if (["--help", "-h", "--version", "-V"].includes(arg)) return null;
    if (!arg.startsWith("-")) return null; // daemon, proxy, schema generation, help
    if (arg === "--stdio") continue;
    if (arg === "--listen" || arg.startsWith("--listen=")) {
      const value = arg === "--listen" ? args[++i] : arg.slice(9);
      if (value !== "stdio://") throw new Error("Desktop requested a conflicting App Server transport.");
      continue;
    }
    transformed.push(arg);
    if (values.has(arg) || ["--code-mode-host", "--ws-auth", "--ws-token-file", "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds"].includes(arg)) {
      if (args[i + 1] == null) throw new Error("Incomplete App Server startup arguments.");
      transformed.push(args[++i]);
    }
  }
  return [...transformed, "--listen", `unix://${socketPath}`];
}

export async function stopChild(child) {
  if (!child?.pid) return;
  const signal = name => {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  if (child.exitCode == null && child.signalCode == null) {
    await Promise.race([once(child, "exit").catch(() => {}), delay(2000)]);
  }
  // Include only the process group created for this server, including its hosts.
  signal("SIGKILL");
}

export async function runWrapper(args, { executable = BUNDLED_CLI, env = process.env, input = process.stdin, output = process.stdout, desktopProcess } = {}) {
  // CODEX_CLI_PATH is inherited by MCP/Computer Use helpers which launch their
  // own stdio servers. Only Desktop's direct child owns the shared runtime.
  // Check origin before parsing/changing transports so helper calls remain exact.
  if (!(desktopProcess ?? isDesktopProcess()) || !serverArguments(args, "/unused")) {
    return forwardInvocation(executable, args, env);
  }
  // Desktop's app-tools peer authorization checks the process ancestry.
  if (process.execPath !== BUNDLED_NODE) {
    throw new Error("Run the Desktop wrapper directly so it uses Desktop's bundled Node runtime.");
  }
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, env });
  const cliVersion = version.stdout?.match(/codex-cli ([\w.+-]+)/)?.[1];
  if (version.status !== 0 || !cliVersion) throw new Error("Could not verify the bundled Codex CLI.");
  const distribution = await describeDistribution();
  const lease = await claimRuntime(env.CODEX_HOME, {
    cli_version: cliVersion, node_path: process.execPath, node_version: process.versions.node,
    codex_steer_package: PACKAGE_NAME, codex_steer_version: VERSION, codex_steer_protocol: RUNTIME_PROTOCOL,
    codex_steer_capabilities: RUNTIME_CAPABILITIES,
    distribution_sha256: distribution.sha256,
  });
  let child;
  let socket;
  let stopSubscriptions;
  let subscriptions;
  let interrupted;
  const signal = () => { interrupted = true; socket?.terminate(); input.destroy(); };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    child = spawn(executable, serverArguments(args, lease.paths.socket), {
      env, detached: true, stdio: ["ignore", "ignore", "inherit"],
    });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    for (let i = 0; i < 100; i++) {
      if (interrupted || spawnError || child.exitCode != null || child.signalCode != null) throw new Error("App Server exited during startup.");
      if (await lstat(lease.paths.socket).catch(() => null)) break;
      await delay(100);
    }
    const endpoint = await inspectAppServerSocket(lease.paths.socket);
    await lease.update({ server_pid: child.pid });
    socket = await connectSocket(endpoint.socket);
    subscriptions = new DesktopSubscriptions(socket);
    stopSubscriptions = await serveSubscriptions(lease.paths.control, subscriptions);
    let initId;
    await relay(input, output, socket, {
      onDesktopMessage(message) {
        if (message.method === "initialize") initId = message.id;
      },
      onServerMessage(message) {
        // Desktop 26.903.71938 sends initialize and considers its response the
        // handshake completion; it does not emit the optional initialized
        // notification shown in the public client example. Forward either form.
        if (!message.method && initId != null && message.id === initId && message.result) {
          subscriptions.ready = true;
          lease.update({ desktop_connected: true }).catch(() => socket.terminate());
        }
        return subscriptions.consume(message);
      },
    });
    return 0;
  } finally {
    process.off("SIGTERM", signal);
    process.off("SIGINT", signal);
    await lease.update({ desktop_connected: false }).catch(() => {});
    socket?.terminate();
    await stopSubscriptions?.();
    await stopChild(child);
    await lease.release();
  }
}
