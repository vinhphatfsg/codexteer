import { readFileSync } from "node:fs";
import { desktopDoctor, inspectDesktopUi, openDesktopThread, sendDesktopMessage } from "./desktop.mjs";
import { normalizeThreadId, threadDeepLink, parseThreadTarget } from "./thread-id.mjs";
import { targetHost, targetContext, withTarget, validateHostId, hostFields, remoteReadOnly, remoteTransport, validateRemoteTransport, isControlTransport } from "./target.mjs";
import { listLocalThreads } from "./thread-store.mjs";
import { sendTrackedMessage, listMessages, getMessage, messageSummary, reconcileMessages, markMessage, listInstructions } from "./journal.mjs";
import { launchDesktopUpdate, desktopUpdateStatus } from "./update.mjs";
import { appServerDoctor, startDesktop } from "./launcher.mjs";
import { VERSION, helpData, renderHelp } from "./help.mjs";
import { observeThread, printObservation } from "./observe.mjs";
import { monitorCommand } from "./monitor.mjs";
import { notificationOptions } from "./notify.mjs";
import { createCheckpoint, listCheckpoints, getCheckpoint, checkpointSummary, verifyCheckpoint, runCheckpoint, attachArtifacts } from "./checkpoint.mjs";
import { acquireResource, resourceStatus, renewResource, releaseResource, listResources, runWithResource } from "./resource.mjs";
import { playSendSound } from "./sound.mjs";
import { prepareSupervisorPrompt, superviseAgent } from "./supervise.mjs";
import { prepareOrchestrationPrompt, orchestrateAgent } from "./orchestrate.mjs";
import { supervisorId, registerSupervisor, getSupervisor, assertSupervisor, controlSupervisor, supervisorStatus, listSupervisors } from "./supervision.mjs";
import { createFinding, findingStatus, listFindings, resolveFinding, dismissFinding, reopenFinding, evaluateFinding, findingStats } from "./findings.mjs";
import { connectionMode, observationConnection, desktopReadOnly } from "./connection.mjs";
import { repairTurns } from "./turn-repair.mjs";
import { listProjects, registeredRemoteProjects } from "./projects.mjs";
import { createProjectThread } from "./thread-create.mjs";
import { verifyProjectThread } from "./thread-verify.mjs";
import { withDeviceAccount, prepareDevice, recoverDeviceKey, enrollDevice, pairDevice, verifyDevice, deviceStatus, deviceIdentityInfo, readPairingCode } from "./remote-device.mjs";
import { readDevice } from "./remote-device-store.mjs";
import { listRemoteProjects, listRemoteThreads, createRemoteProjectThread, verifyRemoteProjectThread, ensureRemoteDesktopSubscription } from "./remote-management.mjs";

const DEFAULT_SEND_BACKEND = "app-server";

function success(command, data, json) {
  if (data && !Array.isArray(data)) Object.assign(data, hostFields());
  if (json) console.log(JSON.stringify({ ok: true, command, data }));
  return data;
}

export function fail(error, json) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, ...(error.watch ? { command: "watch", data: error.watch } : {}), error: {
    message, code: error.code, ...hostFields(), delivery_status: error.delivery_status,
    operation: error.operation, capability: error.capability,
    ...((error.execution_environment === "cloud" || (typeof error.code === "string" && error.code.startsWith("CLOUD_"))) ? {
      execution_environment: error.execution_environment, task_id: error.task_id, url: error.url,
      submission_status: error.submission_status, uncertain: error.uncertain,
      cli_exit_code: error.cli_exit_code, cli_signal: error.cli_signal,
      http_status: error.http_status, retry_after_ms: error.retry_after_ms,
    } : {}),
    sent: error.sent, thread_id: error.thread_id, rpc_code: error.rpc_code ?? error.rpcCode,
    message_id: error.message_id, client_message_id: error.client_message_id, journal_update_required: error.journal_update_required,
    existing_message_id: error.existing_message_id,
    existing_attempt_id: error.existing_attempt_id, existing_receipt_path: error.existing_receipt_path,
    supervision_update_required: error.supervision_update_required,
    history_changed: error.history_changed, backup_path: error.backup_path, receipt_path: error.receipt_path,
    repair_stat: error.repair_stat,
    creation_status: error.creation_status, attempt_id: error.attempt_id, receipt_update_required: error.receipt_update_required,
    reservation_cleanup_required: error.reservation_cleanup_required,
    native_call_id: error.native_call_id,
    uncertain: error.uncertain, resource: error.resource, lease_retained: error.lease_retained, remote_execution_status: error.remote_execution_status,
    remote_process_id: error.remote_process_id,
    verification_checks: error.verification_checks,
    remote_control_auth: error.remote_control_auth,
  } }));
  else {
    console.error(`codexteer: ${message}`);
    if (error.execution_environment === "cloud" || (typeof error.code === "string" && error.code.startsWith("DESKTOP_CLOUD_"))) {
      // Recovery metadata must survive an uncertain submission or a stale
      // on-disk receipt. Never print the child error, prompt, or diagnostics.
      for (const key of ["creation_status", "submission_status", "delivery_status", "attempt_id", "receipt_path", "existing_attempt_id", "existing_receipt_path", "task_id", "thread_id", "url"]) {
        if (typeof error[key] === "string") console.error(`${key}: ${JSON.stringify(error[key])}`);
      }
      if (error.receipt_update_required) console.error("receipt_update_required: true");
      if (error.reservation_cleanup_required) console.error("reservation_cleanup_required: true");
      if (Number.isSafeInteger(error.retry_after_ms)) console.error(`retry_after_ms: ${error.retry_after_ms}`);
    }
  }
  process.exitCode = 1;
}

function takeOption(args, name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1 || (args.includes("--") && index > args.indexOf("--"))) return defaultValue;
  const value = args[index + 1];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || (args.includes("--") && index > args.indexOf("--"))) return false;
  args.splice(index, 1);
  return true;
}

function takeOptions(args, name) {
  const values = []; let value;
  while ((value = takeOption(args, name, undefined)) !== undefined) values.push(value);
  return values;
}

function routingThread(probe) {
  const valued = new Set(["--backend", "--source", "--kind", "--evidence", "--based-on", "--supersedes", "--expires-at", "--checkpoint", "--finding",
    "--wait-ms", "--limit", "--max-chars", "--since", "--until", "--timeout-ms", "--poll-ms", "--notify", "--settle-ms", "--max-hold-ms",
    "--owner", "--agent", "--status", "--note", "--by", "--reason", "--condition", "--ttl-ms", "--token", "--cwd", "--exec-backend", "--shell", "--key", "--title", "--rating", "--path", "--exclude", "--artifact"]);
  const positional = [];
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === "--") { positional.push(...probe.slice(i + 1)); break; }
    if (probe[i].startsWith("--")) { if (valued.has(probe[i])) i++; continue; }
    positional.push(probe[i]);
  }
  const [command, action] = positional;
  if (/^(codex:\/\/|[0-9a-f]{8}-)/i.test(command ?? "")) return command;
  const nested = ["history", "instructions", "findings", "checkpoint", "thread"].includes(command)
    || (command === "supervise" && ["prompt", "register", "status", "pause", "resume", "stop", "list"].includes(action));
  return positional[nested ? 2 : 1];
}

function readMessage(parts) {
  if (parts[0] === "--") parts.shift();
  if (parts.length === 1 && parts[0] === "-") return readFileSync(0, "utf8");
  return parts.join(" ");
}

function backendOption(args, fallback) {
  const backend = takeOption(args, "--backend", fallback);
  if (backend != null && !["app-server", "ui"].includes(backend)) throw new Error("--backend must be app-server or ui.");
  return backend;
}

function printThreads(threads) {
  if (threads.length === 0) {
    console.log("No local Codex threads found.");
    return;
  }
  for (const thread of threads) {
    const location = thread.cwd ? `  ${thread.cwd}` : "";
    console.log(`${thread.thread_id}  ${thread.updated_at}${location}`);
  }
}

function printSupervisor(data) {
  if (Array.isArray(data)) {
    if (!data.length) console.log("No supervisor sessions registered.");
    for (const entry of data) console.log(`${entry.thread_id}  ${entry.state}  ${entry.owner}  ${entry.connection}  observed:${entry.observation?.last_observed_at ?? "none"}`);
    return;
  }
  console.log(`${data.thread_id}  ${data.state}${data.owner ? `  ${data.owner}  ${data.connection}` : ""}`);
  if (data.session_id) console.log(`session: ${data.session_id}`);
  if (Object.hasOwn(data, "observation")) console.log(`observation: ${data.observation?.connection ?? "none"}  last:${data.observation?.last_observed_at ?? "none"}  age_ms:${data.observation_age_ms ?? "unknown"}`);
  if (Object.hasOwn(data, "launcher_alive")) console.log(`launcher: ${data.launcher_alive === null ? "unverified (copied prompt)" : data.launcher_alive ? "alive" : "exited"}`);
  if (data.last_delivery) console.log(`delivery: ${data.last_delivery.status}  message:${data.last_delivery.message_id ?? "none"}`);
  if (data.last_error) console.log(`last error: ${data.last_error.code}`);
  if (data.unresolved_findings) {
    console.log(`unresolved findings: ${data.unresolved_findings.total}`);
    for (const finding of data.unresolved_findings.findings) console.log(`  ${finding.id}  ${finding.status}  ${finding.title}`);
  }
}

export async function main(argv) {
  const args = [...argv];
  try {
    const transport = validateRemoteTransport(takeOption(args, "--remote-transport", "native"));
    const explicitHost = takeOption(args, "--host", undefined);
    if (args.slice(0, args.includes("--") ? args.indexOf("--") : args.length).includes("--host")) throw new Error("Specify --host only once.");
    if (explicitHost !== undefined) validateHostId(explicitHost);
    const probe = [...args];
    takeFlag(probe, "--json");
    for (const flag of ["--connection", "--supervisor", "--require-node-version"]) takeOption(probe, flag, undefined);
    takeOption(probe, "--context-thread", undefined);
    const command = probe[0];
    const contextThread = takeOption(args, "--context-thread", undefined);
    let candidate;
    if (command === "doctor") candidate = takeOption(probe, "--thread", undefined);
    else if (command === "resource") candidate = takeOption(probe, "--thread", undefined);
    else if (["read", "status", "watch", "send", "open", "debug-ui", "supervise", "history", "instructions", "findings", "checkpoint"].includes(command)
      || (command === "thread" && ["resolve", "repair"].includes(probe[1])) || /^(codex:\/\/|[0-9a-f]{8}-)/i.test(command ?? "")) {
      candidate = routingThread(probe);
    }
    const linkHost = candidate === undefined ? undefined : parseThreadTarget(candidate).hostId;
    if (explicitHost !== undefined && linkHost !== undefined && explicitHost !== linkHost) throw Object.assign(new Error("--host conflicts with the thread link hostId."), { code: "HOST_MISMATCH" });
    const host = linkHost ?? explicitHost ?? "local";
    const ownArguments = probe.slice(0, probe.includes("--") ? probe.indexOf("--") : probe.length);
    if (isControlTransport(transport) && host === "local" && command !== "remote" && !["help", "--help", "--version"].some(value => ownArguments.includes(value))) throw Object.assign(new Error("--remote-transport control requires a remote hostId link or --host."), { code: "REMOTE_HOST_REQUIRED" });
    return await withTarget(host, contextThread, () => mainOnTarget(args), { transport });
  } catch (error) { fail(error, argv.includes("--json")); }
}

async function mainOnTarget(argv) {
  const args = [...argv];
  let json = takeFlag(args, "--json");

  try {
    const sessionOption = takeOption(args, "--supervisor", undefined);
    const supervisor = sessionOption === undefined ? undefined : supervisorId(sessionOption);
    const connection = connectionMode(takeOption(args, "--connection", "shared"));
    const connectionDependencies = observationConnection(connection);
    const requiredNode = takeOption(args, "--require-node-version", undefined);
    if (requiredNode !== undefined) {
      if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(requiredNode)) throw new Error("--require-node-version requires a Node version such as v25.1.0.");
      if (requiredNode !== process.version) throw Object.assign(new Error(`This supervision command requires Node ${requiredNode}, but is running ${process.version}. Regenerate the supervisor prompt with the intended Node runtime.`), { code: "NODE_VERSION_MISMATCH" });
    }
    if (takeFlag(args, "--version")) {
      if (json) success("version", { version: VERSION }, true);
      else console.log(VERSION);
      return;
    }
    if (args.length === 0 || takeFlag(args, "--help") || args[0] === "help") {
      if (args[0] === "help") args.shift();
      const candidate = args[0] ?? "overview";
      const topic = ["supervise", "orchestrate"].includes(candidate) && args[1] === "prompt" ? `${candidate} prompt`
        : /^(codex:\/\/|[0-9a-f]{8}-)/i.test(candidate) ? "send" : candidate;
      const data = helpData(topic);
      success("help", data, json);
      if (!json) console.log(renderHelp(data));
      return;
    }

    let command = args.shift();
    const control = isControlTransport();
    if (targetHost() !== "local" && ["desktop", "debug-ui"].includes(command)) throw Object.assign(new Error("Desktop process/update and Accessibility diagnostics cannot target the remote host. No local operation was run."), { code: "REMOTE_HOST_OPERATION_UNSUPPORTED" });
    if (targetHost() !== "local" && !["remote", "projects", "read", "status", "watch", "doctor", "supervise", "findings", "history", "instructions", "thread", "open", ...(control ? ["send"] : []), ...(remoteTransport() === "paired" ? ["threads", "resource", "checkpoint", "orchestrate"] : [])].includes(command)
      && !(control && /^(codex:\/\/|[0-9a-f]{8}-)/i.test(command))) throw remoteReadOnly();
    if (targetHost() !== "local" && command === "thread" && args[0] !== "resolve" && remoteTransport() !== "paired") throw remoteReadOnly();
    if (targetHost() !== "local" && command === "thread" && args[0] === "repair") throw Object.assign(new Error("Offline rollout repair is supported only for validated local macOS/CLI versions. The remote history was not modified."), { code: "REMOTE_REPAIR_UNSUPPORTED" });
    if (targetHost() !== "local" && command === "instructions" && args[0] !== "list" && !control) throw remoteReadOnly();
    // An explicit observation endpoint can never silently route a mutation to
    // the shared wrapper or UI. Local records/help remain available.
    if (connection === "desktop" && !["supervise", "findings", "history", "instructions", "checkpoint", "resource", "read", "status", "watch", "doctor", "threads", "thread"].includes(command)) throw desktopReadOnly();
    if (command === "remote") {
      if (supervisor) throw Object.assign(new Error("A bound supervisor cannot enroll, pair or manage account credentials."), { code: "SUPERVISOR_MISMATCH" });
      const action = args.shift(), codeStdin = takeFlag(args, "--code-stdin"), provider = takeOption(args, "--key-provider", undefined);
      if (provider !== undefined && action !== "prepare") throw new Error("--key-provider is only available for remote prepare.");
      if (!["prepare", "recover-key", "enroll", "status", "identity", "pair", "verify"].includes(action) || args.length || (codeStdin && action !== "pair") || (action === "pair" && !codeStdin)) throw new Error("Expected: remote prepare|recover-key|enroll|status|identity|verify, or --host HOST remote pair --code-stdin.");
      if (["prepare", "enroll"].includes(action) && targetHost() !== "local") throw new Error("remote prepare/enroll registers this local controller; omit --host.");
      // Code input is never an argv option or a chat message.
      if (action === "pair" && !/^remote-control:env_[A-Za-z0-9_-]+$/.test(targetHost())) throw new Error("remote pair requires --host remote-control:env_...");
      if (action === "pair" && process.stdin.isTTY) console.error("codexteer: Enter the selected host's fresh pairing code (hidden), then press Enter.");
      const code = action === "pair" ? await readPairingCode() : undefined;
      if (code && code.length > 128) throw new Error("Invalid pairing code input.");
      const data = await withDeviceAccount(context => action === "prepare" ? prepareDevice(context, { ...(provider ? { provider } : {}) }) : action === "recover-key" ? recoverDeviceKey(context) : action === "enroll" ? enrollDevice(context, { progress: text => console.error(`codexteer: ${text}`) })
        : action === "pair" ? pairDevice(context, targetHost(), code)
          : action === "verify" ? verifyDevice(context) : action === "identity" ? deviceIdentityInfo(context) : readDevice(context.home, context.identity).then(deviceStatus));
      success(`remote.${action}`, data, json); if (!json) console.log(JSON.stringify(data, null, 2)); return;
    }
    if (command === "supervise" && ["register", "status", "list", "pause", "resume", "stop"].includes(args[0])) {
      const action = args.shift(), owner = action === "register" ? takeOption(args, "--owner", "external") : undefined;
      if (args.length !== (action === "list" ? 0 : 1)) throw new Error(`Expected: supervise ${action}${action === "list" ? "" : " <THREAD>"}.`);
      let data;
      if (action === "register") {
        if (!supervisor) throw new Error("supervise register requires the --supervisor ID from a generated prompt.");
        data = await registerSupervisor(args[0], supervisor, { owner, connection });
      } else {
        if (supervisor && action !== "status") throw Object.assign(new Error("Supervisors cannot change their own control state. Run this control command from the user's terminal without --supervisor."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
        if (supervisor) {
          const record = await getSupervisor(args[0]);
          if (record?.session_id !== supervisor) throw Object.assign(new Error("This supervisor belongs to a different session or task."), { code: "SUPERVISOR_MISMATCH" });
        }
        data = action === "list" ? await listSupervisors() : action === "status" ? await supervisorStatus(args[0]) : await controlSupervisor(args[0], action);
        if (action === "status") {
          const pending = await listFindings(args[0], { limit: 20 });
          data.unresolved_findings = { total: pending.total, has_more: pending.has_more,
            findings: pending.findings.map(finding => ({ id: finding.id, title: finding.title, status: finding.status, revision: finding.revision })) };
        }
      }
      success(`supervise.${action}`, data, json);
      if (!json) printSupervisor(data);
      return;
    }
    if (command === "findings") {
      const action = args.shift();
      const flags = names => Object.fromEntries(names.map(([field, option]) => [field, takeOption(args, option, undefined)]));
      let options = {}, data;
      if (action === "create") options = { ...flags([["key", "--key"], ["title", "--title"], ["condition", "--condition"], ["basedOn", "--based-on"]]), evidence: takeOptions(args, "--evidence") };
      else if (action === "resolve") options = flags([["checkpoint", "--checkpoint"], ["note", "--note"]]);
      else if (action === "dismiss") options = flags([["reason", "--reason"]]);
      else if (action === "reopen") {
        options = flags([["reason", "--reason"], ["condition", "--condition"], ["basedOn", "--based-on"]]);
        const evidence = takeOptions(args, "--evidence"); if (evidence.length) options.evidence = evidence;
      } else if (action === "evaluate") options = flags([["rating", "--rating"], ["reason", "--reason"]]);
      else if (action === "list") options = { all: takeFlag(args, "--all"), limit: Number(takeOption(args, "--limit", "50")) };
      const handlers = { create: createFinding, show: findingStatus, list: listFindings, resolve: resolveFinding, dismiss: dismissFinding, reopen: reopenFinding, evaluate: evaluateFinding, stats: findingStats };
      const single = ["create", "list", "stats"].includes(action);
      if (!Object.hasOwn(handlers, action) || args.length !== (single ? 1 : 2) || args.some(arg => arg.startsWith("--"))) throw new Error("See codexteer help findings.");
      if (supervisor) await assertSupervisor(args[0], supervisor, { connection });
      data = single ? await handlers[action](args[0], options) : await handlers[action](args[0], args[1], options);
      success(`findings.${action}`, data, json);
      if (!json) console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (command === "orchestrate") {
      if (supervisor) throw Object.assign(new Error("Managed supervision is bound to its existing task and cannot orchestrate a project."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
      const promptOnly = args[0] === "prompt";
      if (promptOnly) args.shift();
      else if (json) throw new Error("orchestrate inherits agent output and does not support --json. Use help orchestrate --json or orchestrate prompt --project ID|NAME <GOAL> --json.");
      const separator = promptOnly ? -1 : args.indexOf("--");
      const ownArgs = separator < 0 ? args : args.slice(0, separator);
      const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
      const project = takeOption(ownArgs, "--project", undefined);
      const agent = takeOption(ownArgs, "--agent", promptOnly ? undefined : "claude");
      const usePathCli = takeFlag(ownArgs, "--use-path-cli");
      if (promptOnly && ownArgs[0] === "--") ownArgs.shift();
      else if (ownArgs.some(arg => arg.startsWith("--"))) throw new Error("Unknown orchestrate option. See help orchestrate; agent arguments belong after --.");
      if (ownArgs.length !== 1) throw new Error("Expected: orchestrate [prompt] --project <ID-or-exact-name> <GOAL>. Quote the goal as one argument, or use - for stdin.");
      const goal = ownArgs[0] === "-" ? readFileSync(0, "utf8") : ownArgs[0];
      if (promptOnly) {
        const data = await prepareOrchestrationPrompt(project, goal, { agent, connection, usePathCli });
        success("orchestrate.prompt", data, json);
        if (!json) console.log(data.prompt);
      } else process.exitCode = await orchestrateAgent(project, goal, { agent, agentArgs, connection, usePathCli });
      return;
    }
    if (command === "supervise" && args[0] === "prompt") {
      args.shift();
      const agent = takeOption(args, "--agent", "claude");
      const usePathCli = takeFlag(args, "--use-path-cli");
      if (args.length < 1 || args.length > 2 || args.some(arg => arg.startsWith("--"))) throw new Error("Expected: supervise prompt <THREAD> [MESSAGE]. See codexteer help supervise prompt.");
      if (supervisor) throw new Error("A supervisor cannot generate a replacement session.");
      const data = await prepareSupervisorPrompt(args[0], args[1], { agent, connection, usePathCli });
      success("supervise.prompt", data, json);
      if (!json) console.log(data.prompt);
      return;
    }
    if (command === "supervise") {
      if (supervisor) throw new Error("A supervisor cannot start a replacement session.");
      if (json) throw new Error("supervise inherits agent output and does not support --json. Use help supervise --json or supervise prompt <THREAD> --json.");
      const separator = args.indexOf("--");
      const ownArgs = separator < 0 ? args : args.slice(0, separator);
      const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
      const agent = takeOption(ownArgs, "--agent", "claude");
      const usePathCli = takeFlag(ownArgs, "--use-path-cli");
      if (ownArgs.length < 1 || ownArgs.length > 2 || ownArgs.some(arg => arg.startsWith("--"))) throw new Error("Expected: supervise <THREAD> [MESSAGE] [--agent claude|codex] [--use-path-cli] [-- <AGENT-ARGS...>].");
      process.exitCode = await superviseAgent(ownArgs[0], { agent, agentArgs, policy: ownArgs[1], connection, usePathCli });
      return;
    }
    if (command === "resource") {
      const action = args.shift(); let data;
      if (["acquire", "run"].includes(action)) {
        const options = { owner: takeOption(args, "--owner", undefined), ttlMs: Number(takeOption(args, "--ttl-ms", "600000")), reason: takeOption(args, "--reason", ""), condition: takeOption(args, "--condition", ""), threadId: takeOption(args, "--thread", undefined), cwd: takeOption(args, "--cwd", undefined) };
        if (action === "run") {
          const timeoutMs = Number(takeOption(args, "--timeout-ms", "0")), includeOutput = takeFlag(args, "--include-output"), execBackend = takeOption(args, "--exec-backend", "app-server"), remoteShell = takeOption(args, "--shell", undefined);
          if (supervisor) await assertSupervisor(options.threadId, supervisor, { connection, sending: execBackend === "thread-shell" });
          if (args[1] !== "--" || args.length < 3) throw new Error("Expected: resource run <NAME> --owner NAME -- <COMMAND> [ARGS...]");
          data = await runWithResource(args[0], args.slice(2), { ...options, timeoutMs, execBackend, remoteShell, supervisor, connection });
          if (!includeOutput) delete data.output_tail;
          if (!data.valid) process.exitCode = 1;
        } else {
          if (args.length !== 1) throw new Error("Expected: resource acquire <NAME> --owner NAME.");
          data = await acquireResource(args[0], options);
        }
      } else if (["renew", "release"].includes(action)) {
        const token = takeOption(args, "--token", undefined), ttlMs = action === "renew" ? Number(takeOption(args, "--ttl-ms", "600000")) : undefined;
        if (args.length !== 1) throw new Error(`Expected: resource ${action} <NAME> --token TOKEN.`);
        data = action === "renew" ? await renewResource(args[0], token, { ttlMs }) : await releaseResource(args[0], token);
      } else if (action === "status" && args.length === 1) data = await resourceStatus(args[0]);
      else if (action === "list" && args.length === 0) data = await listResources();
      else throw new Error("See codexteer help resource.");
      success(`resource.${action}`, data, json);
      if (!json) console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (command === "checkpoint") {
      const action = args.shift(), includeOutput = takeFlag(args, "--include-output");
      if (supervisor) await assertSupervisor(args[0], supervisor, { connection });
      let data;
      if (action === "capture") {
        const paths = takeOptions(args, "--path"), excludes = takeOptions(args, "--exclude");
        if (args.length !== 2) throw new Error("Expected: checkpoint capture <THREAD> <NAME> --path PATH ...");
        data = await createCheckpoint(args[0], args[1], { paths, excludes });
      } else if (action === "run") {
        const timeoutMs = Number(takeOption(args, "--timeout-ms", "0")), execBackend = takeOption(args, "--exec-backend", "app-server"), remoteShell = takeOption(args, "--shell", undefined);
        if (supervisor && execBackend === "thread-shell") await assertSupervisor(args[0], supervisor, { connection, sending: true });
        if (args[2] !== "--" || args.length < 4) throw new Error("Expected: checkpoint run <THREAD> <ID> -- <COMMAND> [ARGS...]");
        data = await runCheckpoint(args[0], args[1], args.slice(3), { timeoutMs, execBackend, remoteShell, supervisor, connection });
        if (!includeOutput) delete data.output_tail;
        if (!data.valid) process.exitCode = 1;
      } else if (action === "attach") {
        const refs = takeOptions(args, "--artifact");
        if (args.length !== 2) throw new Error("Expected: checkpoint attach <THREAD> <ID> --artifact FILE ...");
        data = await attachArtifacts(args[0], args[1], refs);
      } else if (action === "list") {
        if (args.length !== 1) throw new Error("Expected: checkpoint list <THREAD>.");
        data = await listCheckpoints(args[0]);
      } else if (["show", "verify"].includes(action)) {
        if (args.length !== 2) throw new Error(`Expected: checkpoint ${action} <THREAD> <ID>.`);
        data = action === "verify" ? await verifyCheckpoint(args[0], args[1]) : checkpointSummary(await getCheckpoint(args[0], args[1]), includeOutput);
        if (action === "verify" && !data.valid) process.exitCode = 1;
      } else throw new Error("See codexteer help checkpoint.");
      success(`checkpoint.${action}`, data, json);
      if (!json) console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (command === "instructions") {
      const action = args.shift();
      if (action === "list") {
        const all = takeFlag(args, "--all");
        if (args.length !== 1) throw new Error("Expected: instructions list <THREAD> [--all].");
        if (supervisor) await assertSupervisor(args[0], supervisor, { connection });
        const data = await listInstructions(args[0], { all });
        success("instructions.list", data, json);
        if (!json) { for (const entry of data.instructions) console.log(`${entry.id}  ${entry.instruction_status}  ${entry.metadata?.source ?? "unspecified"}\n${entry.body}`); if (data.pending_changes.length) console.log(`配送未確認: ${data.pending_changes.map(e => e.id).join(", ")}`); }
        return;
      }
      if (action !== "retract") throw new Error("See codexteer help instructions.");
      if (connection === "desktop") throw desktopReadOnly();
      const reason = takeOption(args, "--reason", undefined), source = takeOption(args, "--source", undefined), basedOn = takeOption(args, "--based-on", undefined);
      const dryRun = takeFlag(args, "--dry-run"), newTurn = takeFlag(args, "--new-turn");
      if (args.length !== 2 || !reason?.trim()) throw new Error("Expected: instructions retract <THREAD> <MESSAGE-ID> --reason TEXT.");
      const data = await sendTrackedMessage(args[0], reason, { retracts: args[1], source, basedOn, dryRun, newTurn, supervisor, connection });
      success("instructions.retract", data, json);
      if (!json) console.log(dryRun ? "撤回の送信プレビューです。" : `撤回を受け付けました。message_id: ${data.message_id}`);
      return;
    }
    if (command === "history") {
      const action = args.shift();
      const includeText = takeFlag(args, "--include-text");
      const pending = takeFlag(args, "--pending");
      const report = action === "mark" ? { status: takeOption(args, "--status", undefined), note: takeOption(args, "--note", undefined), evidence: takeOptions(args, "--evidence"), by: takeOption(args, "--by", "local") } : {};
      const [threadId, id] = args;
      if (!threadId || args.length > 2 || !["list", "show", "check", "mark"].includes(action) || (["show", "mark"].includes(action) && !id) || (action === "list" && id)) throw new Error("See codexteer help history.");
      if (supervisor) await assertSupervisor(threadId, supervisor, { connection });
      const data = action === "list" ? await listMessages(threadId, { includeText, pending }) : action === "show" ? messageSummary(await getMessage(threadId, id), includeText) : action === "check" ? await reconcileMessages(threadId, id, { includeText }, connectionDependencies) : await markMessage(threadId, id, report);
      success(`history.${action}`, data, json);
      if (!json) for (const entry of Array.isArray(data) ? data : [data]) console.log(`${entry.id}  ${entry.delivery_status}  history:${entry.verification?.status ?? "unchecked"}  response:${entry.response.status}${entry.body ? "\n" + entry.body : ""}`);
      return;
    }
    if (["read", "status", "watch"].includes(command)) {
      const fullHistory = takeFlag(args, "--full-history");
      const options = command === "status" ? { fullHistory } : {
        fullHistory,
        since: takeOption(args, "--since", undefined),
        limit: Number(takeOption(args, "--limit", "50")),
        maxChars: Number(takeOption(args, "--max-chars", "2000")),
        includeOutput: takeFlag(args, "--include-output"),
      };
      options.supervisor = supervisor; options.connection = connection;
      const stream = command === "watch" && takeFlag(args, "--stream");
      if (stream) json = true;
      if (command === "watch") {
        const until = takeOption(args, "--until", undefined), timeout = takeOption(args, "--timeout-ms", undefined);
        if (stream && (until !== undefined || timeout !== undefined)) throw new Error("--stream runs until cancelled; do not combine it with --until or --timeout-ms. See codexteer help monitor.");
        const notify = takeOption(args, "--notify", stream ? "digest" : "all"), settle = takeOption(args, "--settle-ms", undefined), maxHold = takeOption(args, "--max-hold-ms", undefined);
        if (!stream && (notify === "digest" || settle !== undefined || maxHold !== undefined)) throw new Error("--notify digest, --settle-ms and --max-hold-ms require --stream.");
        if (notify !== "digest" && (settle !== undefined || maxHold !== undefined)) throw new Error("--settle-ms and --max-hold-ms require --notify digest.");
        Object.assign(options, notificationOptions({ notify, ...(settle === undefined ? {} : { settleMs: Number(settle) }), ...(maxHold === undefined ? {} : { maxHoldMs: Number(maxHold) }) }));
        Object.assign(options, { watch: true, until: until ?? "change", timeoutMs: Number(timeout ?? "30000"), pollMs: Number(takeOption(args, "--poll-ms", "1000")) });
      }
      if (args.length !== 1) throw new Error(`Expected: ${command} <THREAD>. See codexteer help ${command}.`);
      if (stream) { await monitorCommand(args[0], options, connectionDependencies); return; }
      const data = await observeThread(args[0], options, connectionDependencies);
      data.connection_mode = connection;
      if (command === "status") delete data.events;
      success(command, data, json);
      if (!json) printObservation(data, command === "status");
      return;
    }
    if (command === "doctor") {
      const backend = backendOption(args, "app-server");
      if (connection === "desktop" && backend === "ui") throw desktopReadOnly();
      const target = takeOption(args, "--thread", undefined);
      if (target !== undefined && backend !== "app-server") throw new Error("doctor --thread requires --backend app-server.");
      const threadId = target === undefined ? undefined : normalizeThreadId(target);
      if (supervisor && threadId) {
        const record = await getSupervisor(threadId);
        if (record && record.session_id !== supervisor && record.state !== "stopped") throw Object.assign(new Error("Another supervisor is registered for this task."), { code: "SUPERVISOR_CONFLICT" });
        if (record?.session_id === supervisor) await assertSupervisor(threadId, supervisor, { connection });
      }
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      if (targetHost() !== "local" && backend === "ui") throw remoteReadOnly();
      const report = backend === "ui" ? desktopDoctor() : await appServerDoctor({ threadId, ...connectionDependencies });
      if (report.connection) Object.assign(report.connection, { mode: connection, observation_only: connection === "desktop" || (targetHost() !== "local" && !control), ...hostFields() });
      report.default_send_backend = DEFAULT_SEND_BACKEND;
      report.rollout_status = "enabled";
      success("doctor", report, json);
      if (!json) {
        console.log(`${report.backend}: ${report.ready ? "ready" : "not ready"}`);
        for (const [name, ok] of Object.entries(report.checks)) {
          console.log(`  ${ok ? "ok" : "missing"}  ${name}`);
        }
        if (report.compatibility) {
          console.log(`  connection: ${report.connection.status}`);
          console.log(`  Desktop: ${report.desktop_version ?? "unknown"}, CLI: ${report.running_cli_version ?? "unknown"}, wrapper Node: ${report.running_wrapper_node_version ?? "unknown"}, local Node: ${report.cli_node_version}`);
          console.log(`  codexteer: ${report.codex_steer_compatibility.status} (local ${report.codex_steer_version}, running ${report.codex_steer_compatibility.runtime.version ?? "unknown"})`);
          console.log(`  runtime protocol: ${report.runtime_compatibility.protocol.status}`);
          for (const [operation, contract] of Object.entries(report.runtime_compatibility.operations)) console.log(`    ${operation}: ${contract.status}${contract.failure ? ` (${contract.failure})` : ""}`);
          console.log(`  observation compatibility: ${report.compatibility.status} (${report.compatibility.scope})`);
          for (const [method, status] of Object.entries(report.compatibility.api_checks)) console.log(`    ${method}: ${status}`);
          if (target === undefined) console.log("  Verify a target: codexteer doctor --thread <THREAD> --json");
          if (report.failure) console.log(`  failure: ${report.failure.code}${report.failure.rpc_code === null ? "" : ` (RPC ${report.failure.rpc_code})`}`);
        }
        if (report.remediation) console.log(`\n${report.remediation}`);
      }
      if (!report.ready) process.exitCode = 1;
      return;
    }

    if (command === "desktop") {
      const action = args.shift();
      if (action === "update-status") {
        if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
        const data = await desktopUpdateStatus();
        success("desktop.update-status", data, json);
        if (!json) console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (action === "update") {
        if (supervisor) throw Object.assign(new Error("A supervisor cannot update or restart Desktop. Run this command from the user's terminal without --supervisor."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
        const dryRun = takeFlag(args, "--dry-run");
        const timeoutMs = Number(takeOption(args, "--timeout-ms", "600000"));
        if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
        const data = await launchDesktopUpdate({ dryRun, timeoutMs });
        success("desktop.update", data, json);
        if (!json) console.log(dryRun ? "Dry run: official update, relaunch, normal quit, wrapper startup, and verification." : `Update worker started (${data.worker_pid}). Check: ${data.status_command}`);
        return;
      }
      if (action !== "start") throw new Error("Expected: codexteer desktop start|update|update-status");
      const dryRun = takeFlag(args, "--dry-run");
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const data = await startDesktop({ dryRun });
      success("desktop.start", data, json);
      if (!json) console.log(dryRun ? "Dry run: would launch Desktop with the shared App Server wrapper." : "Desktop shared App Server is ready.");
      return;
    }

    if (command === "projects") {
      if (connection === "desktop") throw desktopReadOnly();
      if (args.shift() !== "list") throw new Error("Expected: codexteer projects list [--remote | --all] [--host HOST-ID]");
      const remote = takeFlag(args, "--remote"), all = takeFlag(args, "--all");
      if (args.length || (remote && all) || (all && targetHost() !== "local")) throw new Error("Use projects list [--remote | --all] or projects list --host HOST-ID.");
      const saved = targetHost() !== "local" && remoteTransport() === "paired" ? await listRemoteProjects()
        : remote || all || targetHost() !== "local" ? await registeredRemoteProjects() : [];
      const projects = [...(!remote && (all || targetHost() === "local") ? await listProjects() : []),
        ...saved.filter(project => targetHost() === "local" || project.host_id === targetHost())];
      success("projects.list", { projects, count: projects.length }, json);
      if (!json) for (const project of projects) console.log(`${project.project_id}  ${project.name}${project.host_id ? `  [${project.host_id}; availability: ${project.availability}]` : ""}\n${project.roots.map(root => `  ${root}`).join("\n")}`);
      return;
    }

    if (command === "threads") {
      if (args.shift() !== "list") throw new Error("Expected: codexteer threads list");
      const limit = Number.parseInt(takeOption(args, "--limit", "20"), 10);
      const desktopOnly = takeFlag(args, "--desktop-only");
      const cursor = takeOption(args, "--cursor", undefined), projectId = takeOption(args, "--project", undefined), search = takeOption(args, "--search", undefined);
      if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("--limit must be an integer between 1 and 500.");
      }
      if (targetHost() === "local" && [cursor, projectId, search].some(value => value !== undefined)) throw new Error("--cursor/--project/--search currently require a paired remote host.");
      const data = targetHost() === "local" ? { threads: await listLocalThreads({ limit, desktopOnly }) } : await listRemoteThreads({ limit, desktopOnly, cursor, projectId, search });
      const threads = data.threads;
      success("threads.list", { ...data, count: threads.length }, json);
      if (!json) printThreads(threads);
      return;
    }

    if (command === "thread") {
      const action = args.shift();
      if (action === "verify") {
        if (connection === "desktop") throw desktopReadOnly();
        if (supervisor) throw Object.assign(new Error("Managed supervision is bound to its existing task. Verify a project creation receipt without --supervisor."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
        const timeoutMs = Number(takeOption(args, "--timeout-ms", "120000"));
        if (args.length !== 1 || args[0].startsWith("--")) throw new Error("Expected: thread verify <ATTEMPT-ID> [--timeout-ms N].");
        const data = await (targetHost() === "local" ? verifyProjectThread : verifyRemoteProjectThread)(args[0], { timeoutMs });
        success("thread.verify", data, json);
        if (!json) console.log(`Verified existing ${data.deep_link}; creation and initial instruction were not repeated.`);
        return;
      }
      if (action === "create") {
        if (connection === "desktop") throw desktopReadOnly();
        if (supervisor) throw Object.assign(new Error("Managed supervision is bound to its existing task. Run thread create without --supervisor under the user's delegated creation scope."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
        const selector = takeOption(args, "--project", undefined);
        const options = { title: takeOption(args, "--title", undefined), cwd: takeOption(args, "--cwd", undefined), model: takeOption(args, "--model", undefined),
          permissions: takeOption(args, "--permissions", undefined), sandbox: takeOption(args, "--sandbox", undefined),
          approvalPolicy: takeOption(args, "--approval-policy", undefined), approvalsReviewer: takeOption(args, "--approvals-reviewer", undefined), dryRun: takeFlag(args, "--dry-run"),
          contextThread: targetContext(), thinking: takeOption(args, "--thinking", undefined), timeoutMs: takeOption(args, "--timeout-ms", undefined) };
        if (options.timeoutMs !== undefined) {
          options.timeoutMs = Number(options.timeoutMs);
        }
        const literal = args.indexOf("--");
        if (args.slice(0, literal < 0 ? args.length : literal).some(arg => arg.startsWith("--"))) throw new Error("Unknown thread create option. Use -- before an instruction starting with --.");
        const message = readMessage(args);
        const data = await (targetHost() === "local" ? createProjectThread : createRemoteProjectThread)(selector, message, options);
        success("thread.create", data, json);
        if (!json) console.log(options.dryRun ? `Dry run: ${data.project_name} (${data.cwd}), ${data.message_characters} characters.` : `Created ${data.deep_link} in ${data.project_name}; initial instruction accepted${data.turn_id ? ` (turn ${data.turn_id})` : ""}.`);
        return;
      }
      if (action === "repair") {
        const apply = takeFlag(args, "--apply"), dryRun = takeFlag(args, "--dry-run");
        if (args.length !== 1 || args[0].startsWith("--") || (apply && dryRun)) throw new Error("Expected: thread repair <THREAD> [--dry-run | --apply].");
        if (connection === "desktop") throw desktopReadOnly();
        if (supervisor) throw Object.assign(new Error("A supervisor cannot repair task history. Run this command from the user's terminal without --supervisor."), { code: "SUPERVISOR_CONTROL_FORBIDDEN" });
        const data = await repairTurns(args[0], { apply });
        success("thread.repair", data, json);
        if (!json) console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (action !== "resolve") throw new Error("Expected: codexteer thread create|verify|resolve|repair. See help thread.");
      if (args.length !== 1) throw new Error("thread resolve requires exactly one thread ID or URL.");
      const threadId = normalizeThreadId(args[0]);
      const data = { thread_id: threadId, deep_link: threadDeepLink(threadId) };
      success("thread.resolve", data, json);
      if (!json) console.log(threadId);
      return;
    }

    if (command === "open") {
      if (args.length !== 1) throw new Error("open requires exactly one thread ID or URL.");
      const threadId = normalizeThreadId(args[0]);
      const data = targetHost() === "local" ? openDesktopThread(threadId) : await ensureRemoteDesktopSubscription(threadId);
      success("open", data, json);
      if (!json) console.log(`Opened ${data.deep_link}`);
      return;
    }

    if (command === "debug-ui") {
      const waitMs = Number.parseInt(takeOption(args, "--wait-ms", "1500"), 10);
      if (args.length !== 1) throw new Error("debug-ui requires exactly one thread ID or URL.");
      const threadId = normalizeThreadId(args[0]);
      const data = inspectDesktopUi(threadId, { waitMs });
      success("debug-ui", data, json);
      if (!json) console.log(data.diagnostic);
      return;
    }

    if (command !== "send") {
      args.unshift(command);
      command = "send";
    }

    const dryRun = takeFlag(args, "--dry-run");
    const backend = backendOption(args, DEFAULT_SEND_BACKEND);
    if (targetHost() !== "local" && backend === "ui") {
      if (remoteTransport() !== "paired") throw remoteReadOnly();
      throw Object.assign(new Error("UI sending on the remote host is unsupported. No UI or other delivery route was used."), { code: "REMOTE_UI_UNSUPPORTED", sent: false, delivery_status: "not_sent" });
    }
    if (supervisor && backend !== "app-server") throw new Error("Managed supervision requires the app-server backend.");
    const explicitSound = takeFlag(args, "--sound");
    const noSound = takeFlag(args, "--no-sound");
    if (explicitSound && noSound) throw new Error("--sound and --no-sound cannot be combined.");
    if (explicitSound && backend !== "app-server") throw new Error("--sound requires --backend app-server so receipt can be confirmed.");
    const newTurn = takeFlag(args, "--new-turn");
    const directive = { source: takeOption(args, "--source", undefined), kind: takeOption(args, "--kind", undefined), evidence: takeOptions(args, "--evidence"), basedOn: takeOption(args, "--based-on", undefined), supersedes: takeOption(args, "--supersedes", undefined), expiresAt: takeOption(args, "--expires-at", undefined), checkpoint: takeOption(args, "--checkpoint", undefined), finding: takeOption(args, "--finding", undefined) };
    if (backend === "ui" && (directive.source || directive.kind || directive.evidence.length || directive.basedOn || directive.supersedes || directive.expiresAt || directive.checkpoint || directive.finding)) throw new Error("Directive metadata requires --backend app-server.");
    const keepFocus = takeFlag(args, "--keep-focus");
    const waitInput = takeOption(args, "--wait-ms", undefined);
    if (backend !== "ui" && (keepFocus || waitInput != null)) throw new Error("--keep-focus and --wait-ms require --backend ui.");
    const waitMs = Number(waitInput ?? "1500");
    const threadInput = args.shift();
    if (!threadInput) throw new Error("send requires a thread ID or codex://threads URL.");
    const message = readMessage(args);
    if (message.trim() === "") throw new Error("send requires a non-empty message.");
    const threadId = normalizeThreadId(threadInput);
    const data = backend === "app-server"
      ? await sendTrackedMessage(threadId, message, { dryRun, newTurn, ...directive, supervisor, connection })
      : sendDesktopMessage(threadId, message, { dryRun, waitMs, newTurn, keepFocus });
    data.sound = noSound ? { played: false, reason: "disabled" } : playSendSound(data);
    success("send", data, json);
    if (!json) {
      console.log(dryRun
        ? `Dry run: would ${newTurn ? "start a new turn in" : "steer"} ${threadId} (${data.message_characters} characters)`
        : backend === "ui"
          ? `Submitted through Desktop UI for ${threadId}; delivery is unverified.`
          : `App Server accepted input for ${threadId} (turn ${data.turn_id}).`);
      if (data.message_id) console.log(`message_id: ${data.message_id}`);
      if (!noSound && !dryRun && data.sent === true && !data.sound.played) console.error(`codexteer: Input was accepted, but the sound could not be played (${data.sound.reason}).`);
    }
  } catch (error) {
    fail(error, json);
  }
}
