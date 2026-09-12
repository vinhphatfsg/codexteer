import { readFileSync } from "node:fs";
import { desktopDoctor, inspectDesktopUi, openDesktopThread, sendDesktopMessage } from "./desktop.mjs";
import { normalizeThreadId, threadDeepLink } from "./thread-id.mjs";
import { listLocalThreads } from "./thread-store.mjs";
import { sendTrackedMessage, listMessages, getMessage, messageSummary, reconcileMessages, markMessage, listInstructions } from "./journal.mjs";
import { appServerDoctor, startDesktop } from "./launcher.mjs";
import { VERSION, helpData, renderHelp } from "./help.mjs";
import { observeThread, printObservation } from "./observe.mjs";
import { monitorCommand } from "./monitor.mjs";
import { createCheckpoint, listCheckpoints, getCheckpoint, checkpointSummary, verifyCheckpoint, runCheckpoint, attachArtifacts } from "./checkpoint.mjs";
import { acquireResource, resourceStatus, renewResource, releaseResource, listResources, runWithResource } from "./resource.mjs";
import { playSendSound } from "./sound.mjs";
import { prepareSupervisorPrompt, superviseAgent } from "./supervise.mjs";

const DEFAULT_SEND_BACKEND = "app-server";

function success(command, data, json) {
  if (json) console.log(JSON.stringify({ ok: true, command, data }));
  return data;
}

function fail(error, json) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, ...(error.watch ? { command: "watch", data: error.watch } : {}), error: {
    message, code: error.code, delivery_status: error.delivery_status,
    operation: error.operation, capability: error.capability,
    sent: error.sent, thread_id: error.thread_id, rpc_code: error.rpc_code ?? error.rpcCode,
    message_id: error.message_id, client_message_id: error.client_message_id, journal_update_required: error.journal_update_required,
  } }));
  else console.error(`codex-steer: ${message}`);
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

export async function main(argv) {
  const args = [...argv];
  let json = takeFlag(args, "--json");

  try {
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
      const topic = candidate === "supervise" && args[1] === "prompt" ? "supervise prompt"
        : /^(codex:\/\/|[0-9a-f]{8}-)/i.test(candidate) ? "send" : candidate;
      const data = helpData(topic);
      success("help", data, json);
      if (!json) console.log(renderHelp(data));
      return;
    }

    let command = args.shift();
    if (command === "supervise" && args[0] === "prompt") {
      args.shift();
      if (args.length !== 1) throw new Error("Expected: supervise prompt <THREAD>. See codex-steer help supervise prompt.");
      const data = await prepareSupervisorPrompt(args[0]);
      success("supervise.prompt", data, json);
      if (!json) console.log(data.prompt);
      return;
    }
    if (command === "supervise") {
      if (json) throw new Error("supervise inherits agent output and does not support --json. Use help supervise --json or supervise prompt <THREAD> --json.");
      const separator = args.indexOf("--");
      const ownArgs = separator < 0 ? args : args.slice(0, separator);
      const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
      const agent = takeOption(ownArgs, "--agent", undefined);
      if (ownArgs.length !== 1 || !agent) throw new Error("Expected: supervise <THREAD> --agent claude [-- <AGENT-ARGS...>].");
      process.exitCode = await superviseAgent(ownArgs[0], { agent, agentArgs });
      return;
    }
    if (command === "resource") {
      const action = args.shift(); let data;
      if (["acquire", "run"].includes(action)) {
        const options = { owner: takeOption(args, "--owner", undefined), ttlMs: Number(takeOption(args, "--ttl-ms", "600000")), reason: takeOption(args, "--reason", ""), condition: takeOption(args, "--condition", ""), threadId: takeOption(args, "--thread", undefined) };
        if (action === "run") {
          const timeoutMs = Number(takeOption(args, "--timeout-ms", "0")), includeOutput = takeFlag(args, "--include-output");
          if (args[1] !== "--" || args.length < 3) throw new Error("Expected: resource run <NAME> --owner NAME -- <COMMAND> [ARGS...]");
          data = await runWithResource(args[0], args.slice(2), { ...options, timeoutMs });
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
      else throw new Error("See codex-steer help resource.");
      success(`resource.${action}`, data, json);
      if (!json) console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (command === "checkpoint") {
      const action = args.shift(), includeOutput = takeFlag(args, "--include-output");
      let data;
      if (action === "capture") {
        const paths = takeOptions(args, "--path"), excludes = takeOptions(args, "--exclude");
        if (args.length !== 2) throw new Error("Expected: checkpoint capture <THREAD> <NAME> --path PATH ...");
        data = await createCheckpoint(args[0], args[1], { paths, excludes });
      } else if (action === "run") {
        const timeoutMs = Number(takeOption(args, "--timeout-ms", "0"));
        if (args[2] !== "--" || args.length < 4) throw new Error("Expected: checkpoint run <THREAD> <ID> -- <COMMAND> [ARGS...]");
        data = await runCheckpoint(args[0], args[1], args.slice(3), { timeoutMs });
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
      } else throw new Error("See codex-steer help checkpoint.");
      success(`checkpoint.${action}`, data, json);
      if (!json) console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (command === "instructions") {
      const action = args.shift();
      if (action === "list") {
        const all = takeFlag(args, "--all");
        if (args.length !== 1) throw new Error("Expected: instructions list <THREAD> [--all].");
        const data = await listInstructions(args[0], { all });
        success("instructions.list", data, json);
        if (!json) { for (const entry of data.instructions) console.log(`${entry.id}  ${entry.instruction_status}  ${entry.metadata?.source ?? "unspecified"}\n${entry.body}`); if (data.pending_changes.length) console.log(`配送未確認: ${data.pending_changes.map(e => e.id).join(", ")}`); }
        return;
      }
      if (action !== "retract") throw new Error("See codex-steer help instructions.");
      const reason = takeOption(args, "--reason", undefined), source = takeOption(args, "--source", undefined), basedOn = takeOption(args, "--based-on", undefined);
      const dryRun = takeFlag(args, "--dry-run"), newTurn = takeFlag(args, "--new-turn");
      if (args.length !== 2 || !reason?.trim()) throw new Error("Expected: instructions retract <THREAD> <MESSAGE-ID> --reason TEXT.");
      const data = await sendTrackedMessage(args[0], reason, { retracts: args[1], source, basedOn, dryRun, newTurn });
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
      if (!threadId || args.length > 2 || !["list", "show", "check", "mark"].includes(action) || (["show", "mark"].includes(action) && !id) || (action === "list" && id)) throw new Error("See codex-steer help history.");
      const data = action === "list" ? await listMessages(threadId, { includeText, pending }) : action === "show" ? messageSummary(await getMessage(threadId, id), includeText) : action === "check" ? await reconcileMessages(threadId, id, { includeText }) : await markMessage(threadId, id, report);
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
      const stream = command === "watch" && takeFlag(args, "--stream");
      if (stream) json = true;
      if (command === "watch") {
        const until = takeOption(args, "--until", undefined), timeout = takeOption(args, "--timeout-ms", undefined);
        if (stream && (until !== undefined || timeout !== undefined)) throw new Error("--stream runs until cancelled; do not combine it with --until or --timeout-ms. See codex-steer help monitor.");
        Object.assign(options, { watch: true, until: until ?? "change", timeoutMs: Number(timeout ?? "30000"), pollMs: Number(takeOption(args, "--poll-ms", "1000")) });
      }
      if (args.length !== 1) throw new Error(`Expected: ${command} <THREAD>. See codex-steer help ${command}.`);
      if (stream) { await monitorCommand(args[0], options); return; }
      const data = await observeThread(args[0], options);
      if (command === "status") delete data.events;
      success(command, data, json);
      if (!json) printObservation(data, command === "status");
      return;
    }
    if (command === "doctor") {
      const backend = backendOption(args, "app-server");
      const target = takeOption(args, "--thread", undefined);
      if (target !== undefined && backend !== "app-server") throw new Error("doctor --thread requires --backend app-server.");
      const threadId = target === undefined ? undefined : normalizeThreadId(target);
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const report = backend === "ui" ? desktopDoctor() : await appServerDoctor({ threadId });
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
          console.log(`  codex-steer: ${report.codex_steer_compatibility.status} (local ${report.codex_steer_version}, running ${report.codex_steer_compatibility.runtime.version ?? "unknown"})`);
          console.log(`  runtime protocol: ${report.runtime_compatibility.protocol.status}`);
          for (const [operation, contract] of Object.entries(report.runtime_compatibility.operations)) console.log(`    ${operation}: ${contract.status}${contract.failure ? ` (${contract.failure})` : ""}`);
          console.log(`  observation compatibility: ${report.compatibility.status} (${report.compatibility.scope})`);
          for (const [method, status] of Object.entries(report.compatibility.api_checks)) console.log(`    ${method}: ${status}`);
          if (target === undefined) console.log("  Verify a target: codex-steer doctor --thread <THREAD> --json");
          if (report.failure) console.log(`  failure: ${report.failure.code}${report.failure.rpc_code === null ? "" : ` (RPC ${report.failure.rpc_code})`}`);
        }
        if (report.remediation) console.log(`\n${report.remediation}`);
      }
      if (!report.ready) process.exitCode = 1;
      return;
    }

    if (command === "desktop") {
      if (args.shift() !== "start") throw new Error("Expected: codex-steer desktop start");
      const dryRun = takeFlag(args, "--dry-run");
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const data = await startDesktop({ dryRun });
      success("desktop.start", data, json);
      if (!json) console.log(dryRun ? "Dry run: would launch Desktop with the shared App Server wrapper." : "Desktop shared App Server is ready.");
      return;
    }

    if (command === "threads") {
      if (args.shift() !== "list") throw new Error("Expected: codex-steer threads list");
      const limit = Number.parseInt(takeOption(args, "--limit", "20"), 10);
      const desktopOnly = takeFlag(args, "--desktop-only");
      if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("--limit must be an integer between 1 and 500.");
      }
      const threads = await listLocalThreads({ limit, desktopOnly });
      success("threads.list", { threads, count: threads.length }, json);
      if (!json) printThreads(threads);
      return;
    }

    if (command === "thread") {
      if (args.shift() !== "resolve") throw new Error("Expected: codex-steer thread resolve <THREAD>");
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
      const data = openDesktopThread(threadId);
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
    const explicitSound = takeFlag(args, "--sound");
    const noSound = takeFlag(args, "--no-sound");
    if (explicitSound && noSound) throw new Error("--sound and --no-sound cannot be combined.");
    if (explicitSound && backend !== "app-server") throw new Error("--sound requires --backend app-server so receipt can be confirmed.");
    const newTurn = takeFlag(args, "--new-turn");
    const directive = { source: takeOption(args, "--source", undefined), kind: takeOption(args, "--kind", undefined), evidence: takeOptions(args, "--evidence"), basedOn: takeOption(args, "--based-on", undefined), supersedes: takeOption(args, "--supersedes", undefined), expiresAt: takeOption(args, "--expires-at", undefined), checkpoint: takeOption(args, "--checkpoint", undefined) };
    if (backend === "ui" && (directive.source || directive.kind || directive.evidence.length || directive.basedOn || directive.supersedes || directive.expiresAt || directive.checkpoint)) throw new Error("Directive metadata requires --backend app-server.");
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
      ? await sendTrackedMessage(threadId, message, { dryRun, newTurn, ...directive })
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
      if (!noSound && !dryRun && data.sent === true && !data.sound.played) console.error(`codex-steer: Input was accepted, but the sound could not be played (${data.sound.reason}).`);
    }
  } catch (error) {
    fail(error, json);
  }
}
