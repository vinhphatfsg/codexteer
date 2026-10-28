import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRecord, storePath, writeRecord } from "./store.mjs";
import { cloudApi } from "./cloud-api.mjs";

const failure = (message, code = "CLOUD_OPTIONS_INVALID") => Object.assign(new Error(message), { code });
const taskPattern = /^task_[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const taskUrl = id => `https://chatgpt.com/codex/tasks/${id}`;

// Inspect original argv before a Desktop router can consume its host flags.
// This remains independent of any local/remote Desktop routing implementation.
export function cloudRoutingError(argv) {
  const prefixValues = new Set(["--host", "--remote-transport", "--context-thread", "--connection", "--supervisor", "--require-node-version"]);
  let index = 0;
  while (index < argv.length) {
    if (argv[index] === "--json") index++;
    else if (prefixValues.has(argv[index])) index += 2;
    else break;
  }
  if (argv[index] !== "cloud") return null;
  const end = argv.includes("--") ? argv.indexOf("--") : argv.length;
  if (argv.slice(0, end).some(arg => ["--host", "--remote-transport", "--context-thread"].includes(arg))) {
    return failure("Cloud commands use the official CLI directly. --host, --remote-transport, and --context-thread are Desktop options and cannot select a cloud destination.", "CLOUD_TARGET_CONFLICT");
  }
  return null;
}

export function cloudTaskId(value) {
  if (typeof value !== "string") throw failure("A Codex Cloud task ID or chatgpt.com/codex/tasks link is required.");
  if (taskPattern.test(value)) return value;
  try {
    const url = new URL(value);
    const id = url.pathname.slice("/codex/tasks/".length);
    if (url.origin === "https://chatgpt.com" && !url.username && !url.password && url.pathname.startsWith("/codex/tasks/") && taskPattern.test(id)) return id;
  } catch {}
  throw failure("Invalid Codex Cloud task. Desktop thread IDs and remote-host links are not cloud task IDs.");
}

function options(settings = {}) {
  const timeoutMs = settings.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw failure("--timeout-ms must be 1000..600000.");
  return { timeoutMs };
}

// No shell, authentication parsing, automatic installation, or Desktop fallback.
// Prompt input goes through stdin, never the child argv or an on-disk prompt file.
export async function runCloudCli(args, { input = "", timeoutMs = 120000, maxBytes = 16 * 1024 * 1024 } = {}) {
  let directory;
  try { directory = await mkdtemp(path.join(os.tmpdir(), "codexteer-cloud-cli-")); }
  catch { return { started: false, launchError: "PRIVATE_DIRECTORY_UNAVAILABLE" }; }
  // The official cloud CLI can write error.log in cwd, including backend data.
  // Do not place it in a user's checkout or package. Remove the private cwd.
  const environment = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0", TERM: "dumb" };
  delete environment.CODEX_STARTING_DIFF;
  try { return await new Promise(resolve => {
    let child, started = false, stdout = "", bytes = 0, timedOut = false, overflow = false, ioError = false, launchError, killTimer;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"], handlers = new Map();
    try {
      child = spawn("codex", ["cloud", ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: directory, env: environment });
    } catch (error) { resolve({ started, launchError: error.code }); return; }
    child.once("spawn", () => { started = true; });
    child.once("error", error => { launchError = error.code ?? "SPAWN_ERROR"; });
    const stop = signal => { child.kill(signal); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { bytes += Buffer.byteLength(chunk); if (bytes <= maxBytes) stdout += chunk; else { overflow = true; stop(); } });
    // Drain but never expose or persist raw diagnostics (which may contain secrets).
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > maxBytes) { overflow = true; stop(); } });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") ioError = true; });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    for (const signal of signals) {
      const handler = () => stop(signal); handlers.set(signal, handler); process.once(signal, handler);
    }
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      resolve({ started, stdout, exitCode, signal, timedOut, overflow, ioError, launchError });
    });
    child.stdin.end(input);
  }); } finally { await rm(directory, { recursive: true, force: true }); }
}

function completed(result) { return !result.launchError && !result.signal && !result.timedOut && !result.overflow && !result.ioError; }
function cliFailure(result) {
  const code = !result.started && result.launchError ? "CLOUD_CLI_UNAVAILABLE" : result.timedOut ? "CLOUD_TIMEOUT" : result.overflow ? "CLOUD_OUTPUT_LIMIT" : "CLOUD_CLI_FAILED";
  return Object.assign(failure(code === "CLOUD_CLI_UNAVAILABLE" ? "Cannot start codex from PATH. Install the official Codex CLI; no fallback was attempted."
    : "Codex Cloud command failed. Check the official CLI login and environment access. Raw diagnostics are omitted to avoid exposing private data.", code),
  { cli_exit_code: result.exitCode, cli_signal: result.signal });
}

async function preflight(action, run) {
  const result = await run([action, "--help"], { timeoutMs: 10000 });
  if (!completed(result) || result.exitCode !== 0) throw cliFailure(result);
  const required = action === "exec" ? ["codex cloud exec", "--env", "--branch", "--attempts"] : [`codex cloud ${action}`, ...(action === "diff" ? ["--attempt"] : [])];
  if (!required.every(text => result.stdout.includes(text))) throw failure("The installed Codex CLI does not expose the required cloud command. No task was submitted.", "CLOUD_CLI_UNSUPPORTED");
  // '-' must mean stdin, not a literal initial instruction. Older, unverified
  // CLI versions are refused before a mutation even if their flags look alike.
  const version = await run(["--version"], { timeoutMs: 10000 });
  if (!completed(version) || version.exitCode !== 0) throw cliFailure(version);
  const match = version.stdout?.trim().match(/^codex-cli-cloud (\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/);
  if (!match || !(Number(match[1]) > 0 || Number(match[2]) > 157 || (Number(match[2]) === 157 && Number(match[3]) >= 1))) throw failure("Codex Cloud requires the official CLI 0.157.1 or newer with verified stdin semantics. No task was submitted.", "CLOUD_CLI_UNSUPPORTED");
  return match[0];
}

export async function createCloudTask(environment, branch, prompt, settings = {}, dependencies = {}) {
  const limits = options(settings);
  if (typeof environment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(environment)) throw failure("--env requires a cloud environment ID or simple unique label.");
  // Require an explicit Git branch instead of inheriting the active local branch.
  if (typeof branch !== "string" || !branch || branch.length > 255 || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")
    || /[\s\x00-\x1f\x7f~^:?*\[\\]/u.test(branch) || branch.includes("..") || branch.includes("@{") || branch.includes("//")
    || branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) throw failure("--branch requires an explicit valid Git branch name.");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 1024 * 1024) throw failure("A non-empty initial instruction of at most 1 MiB is required.");
  const run = dependencies.run ?? runCloudCli, write = dependencies.write ?? writeRecord;
  const attemptId = randomUUID();
  const receipt = { schema: 1, backend: "codex-cli", execution_environment: "cloud", attempt_id: attemptId,
    environment_selector: environment, branch, creation_status: "not_created", submission_status: "not_sent",
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"), message_characters: [...prompt].length, dry_run: !!settings.dryRun };
  if (settings.dryRun) return receipt;
  receipt.cli_version = await preflight("exec", run);
  receipt.receipt_path = storePath("cloud-creations", attemptId);
  await write("cloud-creations", attemptId, receipt);
  let dispatched = false;
  try {
    await write("cloud-creations", attemptId, { ...receipt, creation_status: "dispatching", submission_status: "dispatching" });
    dispatched = true;
    const result = await run(["exec", "--env", environment, "--branch", branch, "--attempts", "1", "-"], { ...limits, input: prompt });
    if (!result.started && result.launchError) { dispatched = false; throw cliFailure(result); }
    // The official CLI prints exactly the created task URL. No inferred IDs.
    let id;
    const acknowledgement = result.stdout?.trim();
    if (typeof acknowledgement === "string" && /^https:\/\/chatgpt\.com\/codex\/tasks\/task_[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(acknowledgement)) id = cloudTaskId(acknowledgement);
    if (id) Object.assign(receipt, { task_id: id, url: taskUrl(id), creation_status: "created" });
    if (!completed(result) || result.exitCode !== 0) throw cliFailure(result);
    if (!id) throw failure("No unique cloud task ID was confirmed. Inspect the receipt and cloud task list; do not submit again automatically.", "CLOUD_CREATION_UNKNOWN");
    receipt.submission_status = "accepted";
    try { await write("cloud-creations", attemptId, receipt); } catch { receipt.receipt_update_required = true; }
    return receipt;
  } catch (error) {
    Object.assign(receipt, { creation_status: receipt.task_id ? "created" : dispatched ? "unknown" : "not_created",
      submission_status: dispatched ? "unknown" : "not_sent", error_code: error.code ?? "CLOUD_CLI_FAILED" });
    try { await write("cloud-creations", attemptId, receipt); } catch { receipt.receipt_update_required = true; }
    // Never propagate a child-process Error: its message can embed the prompt.
    throw Object.assign(failure("Cloud task submission was not fully confirmed. Inspect the receipt and existing tasks before retrying; no automatic retry was made.", receipt.error_code),
      { ...receipt, uncertain: dispatched, cli_exit_code: error.cli_exit_code, cli_signal: error.cli_signal });
  }
}

export async function cloudTaskStatus(target, settings = {}, { run = runCloudCli } = {}) {
  const taskId = cloudTaskId(target), limits = options(settings);
  await preflight("status", run);
  const result = await run(["status", taskId], limits);
  if (!completed(result) || ![0, 1].includes(result.exitCode)) throw cliFailure(result);
  const match = result.stdout?.match(/^\[(PENDING|READY|APPLIED|ERROR)\] ([^\r\n]*)/u);
  if (!match || result.exitCode !== (match[1] === "READY" ? 0 : 1)) throw failure("Unrecognized cloud status output. No task state was inferred.", "CLOUD_PROTOCOL_UNVERIFIED");
  return { backend: "codex-cli", execution_environment: "cloud", task_id: taskId, url: taskUrl(taskId), status: match[1].toLowerCase(), output: result.stdout };
}

export async function cloudTaskDiff(target, settings = {}, { run = runCloudCli, request = cloudApi } = {}) {
  const taskId = cloudTaskId(target), limits = options(settings);
  if (settings.attempt !== undefined && (!Number.isInteger(settings.attempt) || settings.attempt < 1 || settings.attempt > 4)) throw failure("--attempt must be 1..4.");
  await preflight("diff", run);
  const result = await run(["diff", taskId, ...(settings.attempt === undefined ? [] : ["--attempt", String(settings.attempt)])], limits);
  if (completed(result) && result.exitCode === 1 && settings.attempt === undefined) {
    // A finished task may have commands/files but no recorded patch. Verify
    // this through the same task's API; never turn stderr into a diff or infer
    // that no files changed from the absence of a server-provided patch.
    const details = await request(`tasks/${taskId}`, limits);
    const current = details.current_assistant_turn;
    if (details.task?.id === taskId && current?.role === "assistant" && ["completed", "failed", "cancelled"].includes(current.turn_status)
      && details.current_diff_task_turn == null && Array.isArray(current.output_items) && !current.output_items.some(item => ["output_diff", "pr"].includes(item?.type))) {
      return { backend: "codex-api", execution_environment: "cloud", task_id: taskId, url: taskUrl(taskId), attempt: null,
        attempt_selection: "official-cli-default", diff: null, diff_available: false, reason: "no-server-recorded-patch", local_changes: "unknown" };
    }
  }
  if (!completed(result) || result.exitCode !== 0) throw cliFailure(result);
  return { backend: "codex-cli", execution_environment: "cloud", task_id: taskId, url: taskUrl(taskId), attempt: settings.attempt ?? null,
    attempt_selection: settings.attempt === undefined ? "official-cli-default" : "explicit", diff: result.stdout, diff_available: true };
}

export async function cloudCreationReceipt(attemptId) {
  if (typeof attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) throw failure("A cloud creation attempt UUID is required.");
  const receipt = await readRecord("cloud-creations", attemptId) ?? await readRecord("cloud-messages", attemptId);
  if (!receipt) throw failure("Cloud creation receipt was not found.", "CLOUD_RECEIPT_NOT_FOUND");
  return receipt;
}
