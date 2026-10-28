import { spawn, spawnSync } from "node:child_process";
import { mkdir, lstat, readFile, writeFile, rename, rmdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { codexHome } from "./runtime.mjs";
import { prepareCodexHome, prepareDeployment } from "./distribution.mjs";
import { APP_PATH, startDesktop, appServerDoctor } from "./launcher.mjs";

const script = fileURLToPath(new URL("../scripts/update-desktop.applescript", import.meta.url));
const error = (code, message) => Object.assign(new Error(message), { code });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) throw error("UPDATE_COMMAND_FAILED", result.error?.message ?? result.stderr?.trim() ?? `${command} failed`);
  return result.stdout.trim();
}
export function updateUi(operation) { return run("/usr/bin/osascript", [script, operation]); }
export function updateBuild() {
  return run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", `${APP_PATH}/Contents/Info.plist`]);
}
export function desktopPids() {
  return run("/bin/ps", ["-axo", "pid=,comm="]).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === `${APP_PATH}/Contents/MacOS/ChatGPT` ? [Number(match[1])] : [];
  });
}

// Separate orchestration from platform effects to exercise restarts/failures without
// updating the developer's app. No signal-based termination or task resumption.
export async function performUpdate({ timeoutMs = 600000, initialBuild, initialPids }, {
  build = updateBuild, pids = desktopPids, ui = updateUi,
  quit = () => run("/usr/bin/osascript", ["-e", 'tell application id "com.openai.codex" to quit']),
  start = startDesktop, doctor = appServerDoctor, save = async () => {}, sleep = delay, now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastPhase = "checking", newBuild;
  await save({ phase: lastPhase, initial_build: initialBuild });
  await ui("check");
  while (now() < deadline) {
    const running = await pids();
    try { newBuild = await build(); }
    catch (e) {
      // Sparkle can temporarily move the bundle away during installation.
      if (!running.length && ["downloading", "installing"].includes(lastPhase)) { await sleep(1000); continue; }
      throw e;
    }
    // Both the on-disk build and process generation must change before quitting
    // the relaunched app. Do not interrupt Sparkle's installation or its old app.
    if (newBuild !== initialBuild && running.length && running.every(pid => !initialPids.includes(pid))) break;
    if (running.length && newBuild === initialBuild && lastPhase !== "installing") {
      let phase;
      try { phase = await ui("advance"); }
      catch (e) {
        // The app can exit between the process snapshot and the AX request.
        if (!(await pids()).length) { await sleep(1000); continue; }
        throw e;
      }
      if (phase === "up_to_date") return { phase, initial_build: initialBuild, final_build: newBuild, wrapper_verified: false };
      if (["downloading", "installing"].includes(phase) && phase !== lastPhase) {
        lastPhase = phase; await save({ phase });
      }
    }
    await sleep(1000);
  }
  if (now() >= deadline) throw error("UPDATE_TIMEOUT", "Update/relaunch did not complete in time. Inspect Codex or its updater for dialogs. No processes were forcibly stopped.");
  await save({ phase: "restoring_wrapper", final_build: newBuild });
  await quit();
  const quitDeadline = now() + 30000;
  while ((await pids()).length) {
    if (now() >= quitDeadline) throw error("UPDATE_QUIT_TIMEOUT", "Codex did not quit normally. Finish its work, quit it, and run codexteer desktop start.");
    await sleep(500);
  }
  await start();
  const report = await doctor();
  if (!report.ready || report.connection?.mode !== "shared" || !report.checks?.bundled_wrapper_node || report.cli_version_status !== "matched") {
    throw error("UPDATE_WRAPPER_UNVERIFIED", "Update installed, but wrapper verification failed. Run codexteer doctor --json.");
  }
  return { phase: "complete", initial_build: initialBuild, final_build: newBuild, wrapper_verified: true, doctor: report };
}

async function privateDirectory(directory) {
  await mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw error("UPDATE_STATE_UNSAFE", `Unsafe update state directory: ${directory}`);
}
async function stateRoot(requestedHome = codexHome()) {
  const home = await prepareCodexHome(requestedHome);
  const parent = path.join(home, "codex-steer");
  await privateDirectory(parent);
  const root = path.join(parent, "desktop-update");
  await privateDirectory(root);
  return { home, root };
}
async function writeStatus(root, state) {
  const temporary = path.join(root, `status-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...state, updated_at: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path.join(root, "status.json"));
}
export async function desktopUpdateStatus() {
  const { root } = await stateRoot();
  try {
    const file = path.join(root, "status.json"), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw error("UPDATE_STATE_UNSAFE", "Unsafe update status file.");
    const state = JSON.parse(await readFile(file, "utf8"));
    if (state.worker_pid && !["complete", "up_to_date", "failed"].includes(state.phase)) {
      try { process.kill(state.worker_pid, 0); state.worker_alive = true; }
      catch (e) { if (e.code !== "ESRCH") throw e; state.worker_alive = false; }
    }
    return state;
  } catch (e) { if (e.code === "ENOENT") return { phase: "not_started" }; throw e; }
}
export async function launchDesktopUpdate({ dryRun = false, timeoutMs = 600000 } = {}, {
  platform = process.platform, executablePath = process.execPath, pids = desktopPids,
  ui = updateUi, build = updateBuild, prepare = prepareDeployment, spawnWorker = spawn,
  home: requestedHome = codexHome(),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 3600000) throw error("UPDATE_ARGUMENT", "--timeout-ms must be an integer between 10000 and 3600000.");
  if (dryRun) return { dry_run: true, started: false, timeout_ms: timeoutMs, steps: ["official_update_ui", "wait_for_new_build_and_relaunch", "normal_quit", "wrapper_start", "doctor"] };
  if (platform !== "darwin") throw error("UPDATE_PLATFORM", "Desktop update requires macOS.");
  if (process.env.CODEX_APP_SERVER_WS_URL?.trim()) throw error("UPDATE_ENVIRONMENT", "Remove CODEX_APP_SERVER_WS_URL before updating with a shared wrapper.");
  const executable = await realpath(executablePath);
  if (executable.includes(".app/Contents/")) throw error("UPDATE_NODE", "Run desktop update with an external Node installation, so replacing the app cannot remove the worker runtime.");
  const initialPids = pids();
  if (initialPids.length !== 1) throw error("UPDATE_APP_STATE", "Exactly one running Codex Desktop is required.");
  if (ui("preflight") !== "checking") throw error("UPDATE_UI_UNAVAILABLE", "Codex update menu is unavailable. Allow Accessibility/Automation for your terminal and retry.");
  const initialBuild = build();
  const { home, root } = await stateRoot(requestedHome);
  const deployment = await prepare(home);
  const lock = path.join(root, "lock");
  await mkdir(lock, { mode: 0o700 }).catch(e => {
    if (e.code === "EEXIST") throw error("UPDATE_BUSY", `An update lock exists. Check desktop update-status; if its worker has stopped, inspect the app before manually removing ${lock}.`);
    throw e;
  });
  try {
    await writeStatus(root, { phase: "starting", initial_build: initialBuild });
    const child = spawnWorker(executable, [path.join(deployment.directory, "bin/codexteer-update.mjs"), JSON.stringify({ root, timeoutMs, initialBuild, initialPids })], {
      detached: true, stdio: "ignore", cwd: deployment.directory, env: { ...process.env, CODEX_HOME: home },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { started: true, worker_pid: child.pid, status_command: "codexteer desktop update-status --json", status_path: path.join(root, "status.json") };
  } catch (e) { await writeStatus(root, { phase: "failed", error: e.message }); await rmdir(lock); throw e; }
}
export async function updateWorker(options) {
  let state = { phase: "starting", worker_pid: process.pid, initial_build: options.initialBuild };
  const save = async patch => { state = { ...state, ...patch }; await writeStatus(options.root, state); };
  try {
    await save({});
    const running = desktopPids();
    if (updateBuild() !== options.initialBuild || running.length !== 1 || running[0] !== options.initialPids[0]) {
      throw error("UPDATE_APP_CHANGED", "Codex changed after preflight. Inspect its update state before retrying.");
    }
    await save(await performUpdate(options, { save }));
  } catch (e) {
    await save({ phase: "failed", error: { code: e.code ?? "UPDATE_FAILED", message: e.message }, recovery: "Inspect Codex and the updater. After installation finishes, quit normally and run codexteer desktop start, then codexteer doctor --json." });
    process.exitCode = 1;
  } finally { await rmdir(path.join(options.root, "lock")); }
}
