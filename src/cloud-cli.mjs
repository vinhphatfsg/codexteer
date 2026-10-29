import { isCloudTask } from "./task-id.mjs";
import { cloudTaskId } from "./cloud-id.mjs";
import { cloudConnection } from "./cloud-connection.mjs";
import { observeThread, printObservation } from "./observe.mjs";
import { monitorCommand } from "./monitor.mjs";
import { notificationOptions } from "./notify.mjs";
import { prepareSupervisorPrompt, superviseAgent } from "./supervise.mjs";
import { supervisorId, registerSupervisor, getSupervisor, assertSupervisor, controlSupervisor, supervisorStatus, listSupervisors } from "./supervision.mjs";
import { createFinding, findingStatus, listFindings, resolveFinding, dismissFinding, reopenFinding, evaluateFinding, findingStats } from "./findings.mjs";
import { sendTrackedMessage, listMessages, getMessage, messageSummary, reconcileMessages, markMessage, listInstructions } from "./journal.mjs";
import { createCloudTask, cloudTaskDiff, listCloudTasks, cloudCreationReceipt } from "./cloud.mjs";
import { cloudSendReceipt, reconcileCloudSend } from "./cloud-observe.mjs";
import { cloudEnvironments } from "./cloud-api.mjs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { playSendSound } from "./sound.mjs";
import { VERSION } from "./version.mjs";
import { createCheckpoint, listCheckpoints, getCheckpoint, checkpointSummary, verifyCheckpoint, runCheckpoint, attachArtifacts } from "./checkpoint.mjs";
import { acquireResource, resourceStatus, renewResource, releaseResource, listResources, runWithResource } from "./resource.mjs";

const failure = (message, code = "CLOUD_OPTIONS_INVALID") => Object.assign(new Error(message), { code, execution_environment: "cloud" });
const values = new Set("--connection --supervisor --require-node-version --host --remote-transport --context-thread --thread --backend --source --kind --evidence --based-on --finding --expires-at --supersedes --checkpoint --limit --max-chars --since --poll-ms --timeout-ms --until --notify --settle-ms --max-hold-ms --owner --key --condition --note --rating --reason --root --path --exclude --command --cwd --artifact --status --by --token --ttl-ms --agent --project --env --branch --title --model --thinking --cursor --attempt".split(" "));
function option(args, name, fallback) {
  const index = args.indexOf(name), stop = args.indexOf("--");
  if (index < 0 || (stop >= 0 && index > stop)) return fallback;
  const value = args[index + 1]; if (value == null || value.startsWith("--")) throw failure(`${name} requires a value.`);
  args.splice(index, 2); return value;
}
function flag(args, name) {
  const index = args.indexOf(name), stop = args.indexOf("--");
  if (index < 0 || (stop >= 0 && index > stop)) return false;
  args.splice(index, 1); return true;
}
const repeated = (args, name) => { const result = []; let value; while ((value = option(args, name)) !== undefined) result.push(value); return result; };
const message = args => { if (args[0] === "--") args.shift(); return args.length === 1 && args[0] === "-" ? readFileSync(0, "utf8") : args.join(" "); };
function exact(args, count) { if (args.length !== count || args.some(arg => arg.startsWith("--"))) throw failure("Unexpected arguments. See the command's help."); }

export function cloudInvocation(argv) {
  const end = argv.indexOf("--"), own = end < 0 ? argv : argv.slice(0, end);
  const connection = own.indexOf("--connection");
  const positional = [];
  for (let i = 0; i < own.length; i++) {
    if (values.has(own[i])) { i++; continue; }
    if (!own[i].startsWith("--")) positional.push(own[i]);
  }
  const [command, action] = positional;
  if (["help", "--help", "--version"].includes(command) || own.includes("--help") || own.includes("--version")) return false;
  if (connection >= 0 && own[connection + 1] === "cloud") return true;
  const thread = own.indexOf("--thread");
  if (["doctor", "resource"].includes(command) && thread >= 0) return isCloudTask(own[thread + 1]);
  if (command === "thread" && action === "create") return false;
  const nested = ["history", "instructions", "findings", "checkpoint", "thread"].includes(command)
    || (command === "supervise" && ["prompt", "register", "status", "pause", "resume", "stop", "list"].includes(action));
  return isCloudTask(isCloudTask(command) ? command : positional[nested ? 2 : 1]);
}

// Only parsing/routing is backend-specific. Supervision, monitoring, directives,
// findings, journaling and saved-agent launch use the same local implementation.
export async function mainCloud(argv) {
  const args = [...argv], json = flag(args, "--json"), connection = option(args, "--connection", "cloud");
  if (connection !== "cloud") throw failure("A cloud task requires the cloud connection.", "CLOUD_TARGET_CONFLICT");
  const own = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
  if (own.some(value => ["--host", "--remote-transport", "--context-thread"].includes(value))) throw failure("Desktop host routes cannot select a cloud task.", "CLOUD_TARGET_CONFLICT");
  const requiredNode = option(args, "--require-node-version");
  if (requiredNode !== undefined && requiredNode !== process.version) throw failure("The saved supervisor requires its original Node version. Regenerate its prompt.", "NODE_VERSION_MISMATCH");
  const session = option(args, "--supervisor"), supervisor = session === undefined ? undefined : supervisorId(session);
  let command = args.shift();
  if (isCloudTask(command)) { args.unshift(command); command = "send"; }
  const output = (name, data) => {
    if (json) console.log(JSON.stringify({ ok: true, command: name, data }));
    else console.log(JSON.stringify(data, null, 2));
    return data;
  };
  const bound = async target => { const id = cloudTaskId(target); if (supervisor) await assertSupervisor(id, supervisor, { connection: "cloud" }); return id; };
  const dependencies = cloudConnection();

  if (["read", "status", "watch"].includes(command)) {
    const options = { supervisor, connection: "cloud", fullHistory: flag(args, "--full-history"), since: option(args, "--since"),
      limit: Number(option(args, "--limit", "50")), maxChars: Number(option(args, "--max-chars", "2000")), includeOutput: flag(args, "--include-output") };
    const stream = command === "watch" && flag(args, "--stream");
    if (command === "watch") {
      const until = option(args, "--until"), timeout = option(args, "--timeout-ms");
      if (stream && (until !== undefined || timeout !== undefined)) throw failure("--stream runs until cancelled; do not combine it with --until or --timeout-ms.");
      Object.assign(options, { watch: true, until: until ?? "change", timeoutMs: Number(timeout ?? "30000"), pollMs: Number(option(args, "--poll-ms", "5000")) });
      const notify = option(args, "--notify", stream ? "digest" : "all"), settle = option(args, "--settle-ms"), maxHold = option(args, "--max-hold-ms");
      if (!stream && (notify === "digest" || settle !== undefined || maxHold !== undefined)) throw failure("Digest options require --stream.");
      Object.assign(options, notificationOptions({ notify, ...(settle === undefined ? {} : { settleMs: Number(settle) }), ...(maxHold === undefined ? {} : { maxHoldMs: Number(maxHold) }) }));
    }
    exact(args, 1); const id = await bound(args[0]);
    if (stream) return monitorCommand(id, options, dependencies);
    const data = await observeThread(id, options, dependencies); data.connection_mode = "cloud";
    if (command === "status") delete data.events;
    if (json) output(command, data); else printObservation(data, command === "status");
    return;
  }
  if (command === "supervise") {
    const action = args[0];
    if (["register", "status", "list", "pause", "resume", "stop"].includes(action)) {
      args.shift(); const owner = action === "register" ? option(args, "--owner", "external") : undefined;
      exact(args, action === "list" ? 0 : 1);
      const id = action === "list" ? null : cloudTaskId(args[0]); let data;
      if (action === "register") {
        if (!supervisor) throw failure("supervise register requires the generated --supervisor ID.");
        data = await registerSupervisor(id, supervisor, { owner, connection: "cloud" });
      } else {
        if (supervisor && action !== "status") throw failure("A supervisor cannot change its own control state.", "SUPERVISOR_CONTROL_FORBIDDEN");
        if (supervisor && id && (await getSupervisor(id))?.session_id !== supervisor) throw failure("This command belongs to another supervisor.", "SUPERVISOR_MISMATCH");
        data = action === "list" ? (await listSupervisors()).filter(record => record.connection === "cloud") : action === "status" ? await supervisorStatus(id) : await controlSupervisor(id, action);
        if (action === "status") { const pending = await listFindings(id, { limit: 20 }); data.unresolved_findings = { total: pending.total, has_more: pending.has_more, findings: pending.findings.map(f => ({ id: f.id, title: f.title, status: f.status, revision: f.revision })) }; }
      }
      output(`supervise.${action}`, data); return;
    }
    if (supervisor) throw failure("A supervisor cannot start a replacement session.", "SUPERVISOR_CONTROL_FORBIDDEN");
    const promptOnly = action === "prompt"; if (promptOnly) args.shift();
    const separator = args.indexOf("--"), ownArgs = separator < 0 ? args : args.slice(0, separator), forwarded = separator < 0 ? [] : args.slice(separator + 1);
    const agent = option(ownArgs, "--agent", "claude"), usePathCli = flag(ownArgs, "--use-path-cli");
    if (ownArgs.length < 1 || ownArgs.length > 2 || ownArgs.some(a => a.startsWith("--"))) throw failure("Expected: supervise [prompt] <TASK> [POLICY] [--agent claude|codex].");
    const id = cloudTaskId(ownArgs[0]);
    if (promptOnly) { const data = await prepareSupervisorPrompt(id, ownArgs[1], { agent, usePathCli, connection: "cloud" }); if (json) output("supervise.prompt", data); else console.log(data.prompt); }
    else { if (json) throw failure("supervise inherits agent output and does not support --json."); process.exitCode = await superviseAgent(id, { policy: ownArgs[1], agent, usePathCli, agentArgs: forwarded, connection: "cloud" }); }
    return;
  }
  if (command === "findings") {
    const action = args.shift(), options = {};
    const names = { key: "--key", title: "--title", condition: "--condition", basedOn: "--based-on", checkpoint: "--checkpoint", note: "--note", reason: "--reason", rating: "--rating" };
    const allowed = { create: ["key", "title", "condition", "basedOn"], resolve: ["checkpoint", "note"], dismiss: ["reason"], reopen: ["reason", "condition", "basedOn"], evaluate: ["rating", "reason"] }[action] ?? [];
    for (const key of allowed) { const value = option(args, names[key]); if (value !== undefined) options[key] = value; }
    if (["create", "reopen"].includes(action)) { const evidence = repeated(args, "--evidence"); if (evidence.length) options.evidence = evidence; }
    if (action === "list") { options.all = flag(args, "--all"); options.limit = Number(option(args, "--limit", "50")); }
    const handlers = { create: createFinding, show: findingStatus, list: listFindings, resolve: resolveFinding, dismiss: dismissFinding, reopen: reopenFinding, evaluate: evaluateFinding, stats: findingStats };
    if (!Object.hasOwn(handlers, action)) throw failure("Unknown findings operation.");
    const single = ["create", "list", "stats"].includes(action); exact(args, single ? 1 : 2); const id = await bound(args[0]);
    output(`findings.${action}`, single ? await handlers[action](id, options) : await handlers[action](id, args[1], options)); return;
  }
  if (command === "history") {
    const action = args.shift(), attempt = option(args, "--attempt");
    if (attempt !== undefined) {
      if (!["show", "check"].includes(action)) throw failure("--attempt requires history show or history check.");
      exact(args, 1); const id = await bound(args[0]);
      const settings = { taskId: id };
      output(`history.${action}`, action === "show" ? await cloudSendReceipt(attempt, settings) : await reconcileCloudSend(attempt, settings)); return;
    }
    const includeText = flag(args, "--include-text"), pending = flag(args, "--pending");
    const report = action === "mark" ? { status: option(args, "--status"), note: option(args, "--note"), evidence: repeated(args, "--evidence"), by: option(args, "--by", "local") } : {};
    if (!args[0] || args.length > 2 || !["list", "show", "check", "mark"].includes(action) || (["show", "mark"].includes(action) && !args[1]) || (action === "list" && args[1])) throw failure("Invalid history arguments.");
    const id = await bound(args[0]); const data = action === "list" ? await listMessages(id, { includeText, pending }) : action === "show" ? messageSummary(await getMessage(id, args[1]), includeText)
      : action === "check" ? await reconcileMessages(id, args[1], { includeText }, dependencies) : await markMessage(id, args[1], report);
    output(`history.${action}`, data); return;
  }
  if (command === "instructions") {
    const action = args.shift();
    if (action === "list") { const all = flag(args, "--all"); exact(args, 1); output("instructions.list", await listInstructions(await bound(args[0]), { all })); return; }
    if (action !== "retract") throw failure("Expected instructions list|retract.");
    const source = option(args, "--source", "external"), reason = option(args, "--reason"), basedOn = option(args, "--based-on"), dryRun = flag(args, "--dry-run"), newTurn = flag(args, "--new-turn");
    exact(args, 2); if (!reason) throw failure("Retraction requires --reason.");
    output("instructions.retract", await sendTrackedMessage(await bound(args[0]), reason, { source, retracts: args[1], basedOn, dryRun, newTurn, supervisor, connection: "cloud" })); return;
  }
  if (command === "checkpoint") {
    const action = args.shift(), includeOutput = flag(args, "--include-output"); let data;
    if (action === "capture") {
      const paths = repeated(args, "--path"), excludes = repeated(args, "--exclude"); exact(args, 2);
      data = await createCheckpoint(await bound(args[0]), args[1], { paths, excludes });
    } else if (action === "run") {
      const timeoutMs = Number(option(args, "--timeout-ms", "0"));
      if (args[2] !== "--" || args.length < 4) throw failure("Expected checkpoint run <TASK> <ID> -- <COMMAND> [ARGS...].");
      data = await runCheckpoint(await bound(args[0]), args[1], args.slice(3), { timeoutMs });
      if (!includeOutput) delete data.output_tail; if (!data.valid) process.exitCode = 1;
    } else if (action === "attach") { const refs = repeated(args, "--artifact"); exact(args, 2); data = await attachArtifacts(await bound(args[0]), args[1], refs); }
    else if (action === "list") { exact(args, 1); data = await listCheckpoints(await bound(args[0])); }
    else if (["show", "verify"].includes(action)) { exact(args, 2); const id = await bound(args[0]); data = action === "verify" ? await verifyCheckpoint(id, args[1]) : checkpointSummary(await getCheckpoint(id, args[1]), includeOutput); if (action === "verify" && !data.valid) process.exitCode = 1; }
    else throw failure("Unknown checkpoint operation.");
    output(`checkpoint.${action}`, Array.isArray(data) ? data.map(item => ({ ...item, execution_environment: "local" })) : { ...data, execution_environment: "local", verification_target: "explicit local input/artifact paths; cloud files are not mounted" }); return;
  }
  if (command === "resource") {
    const action = args.shift(), threadInput = option(args, "--thread");
    const threadId = threadInput === undefined ? undefined : await bound(threadInput);
    if (supervisor && !threadId) throw failure("A supervisor resource command requires its --thread target.", "SUPERVISOR_CONTROL_FORBIDDEN");
    let data;
    if (["acquire", "run"].includes(action)) {
      const settings = { owner: option(args, "--owner"), ttlMs: Number(option(args, "--ttl-ms", "600000")), reason: option(args, "--reason", ""), condition: option(args, "--condition", ""), threadId };
      if (action === "run") {
        const timeoutMs = Number(option(args, "--timeout-ms", "0")), includeOutput = flag(args, "--include-output");
        if (args[1] !== "--" || args.length < 3) throw failure("Expected resource run <NAME> --owner NAME -- <COMMAND> [ARGS...].");
        data = await runWithResource(args[0], args.slice(2), { ...settings, timeoutMs }); if (!includeOutput) delete data.output_tail; if (!data.valid) process.exitCode = 1;
      } else { exact(args, 1); data = await acquireResource(args[0], settings); }
    } else if (["renew", "release"].includes(action)) {
      const token = option(args, "--token"), ttlMs = Number(option(args, "--ttl-ms", "600000")); exact(args, 1);
      data = action === "renew" ? await renewResource(args[0], token, { ttlMs }) : await releaseResource(args[0], token);
    } else if (action === "status") { exact(args, 1); data = await resourceStatus(args[0]); }
    else if (action === "list") { exact(args, 0); data = await listResources(); }
    else throw failure("Unknown resource operation.");
    output(`resource.${action}`, Array.isArray(data) ? data.map(item => ({ ...item, execution_environment: "local" })) : { ...data, execution_environment: "local", scope: "local coordination and explicitly supplied local commands" }); return;
  }
  if (command === "threads") {
    if (args.shift() !== "list") throw failure("Expected threads list.");
    const limit = Number(option(args, "--limit", "20")), cursor = option(args, "--cursor"), environment = option(args, "--env"); exact(args, 0);
    if (supervisor) throw failure("A bound supervisor cannot enumerate unrelated cloud tasks.", "SUPERVISOR_CONTROL_FORBIDDEN");
    output("threads.list", await listCloudTasks({ limit, cursor, environment })); return;
  }
  if (command === "thread" && args[0] === "receipt") {
    args.shift(); exact(args, 1);
    if (supervisor) throw failure("A bound supervisor cannot inspect unrelated creation attempts.", "SUPERVISOR_CONTROL_FORBIDDEN");
    output("thread.receipt", await cloudCreationReceipt(args[0])); return;
  }
  if (command === "thread" && args[0] === "create") {
    args.shift(); if (supervisor) throw failure("A bound supervisor cannot create another task.", "SUPERVISOR_CONTROL_FORBIDDEN");
    const project = option(args, "--project"), requestedBranch = option(args, "--branch"), dryRun = flag(args, "--dry-run");
    if (project === undefined) throw failure("Cloud creation requires --project with an environment ID or exact name.");
    const end = args.includes("--") ? args.indexOf("--") : args.length; if (args.slice(0, end).some(arg => arg.startsWith("--"))) throw failure("Unknown cloud creation option; explicit model/title/permission overrides are not implemented yet.");
    const body = message(args); if (!body.trim()) throw failure("A non-empty initial instruction is required.");
    const rows = (await cloudEnvironments()).environments, selector = project, matches = rows.filter(e => e.id === selector || e.name === selector);
    if (matches.length !== 1) throw failure("The cloud environment selector must match one accessible ID or exact name.");
    const selected = matches[0], branch = requestedBranch ?? (selected.repositories.length === 1 ? selected.repositories[0].default_branch : null);
    if (!branch) throw failure("Specify --branch: this environment does not identify one repository default branch.");
    const data = await createCloudTask(selected.id, branch, body, { dryRun });
    output("thread.create", { ...data, thread_id: data.task_id ?? null, project_id: selected.id, project_name: selected.name, deep_link: data.url ?? null,
      branch_source: requestedBranch === undefined ? "environment-default" : "explicit" }); return;
  }
  if (command === "projects") { exact(args, 1); if (args[0] !== "list") throw failure("Expected projects list."); if (supervisor) throw failure("A bound supervisor cannot enumerate unrelated cloud environments.", "SUPERVISOR_CONTROL_FORBIDDEN"); const data = await cloudEnvironments(); output("projects.list", { projects: data.environments.map(e => ({ ...e, project_id: e.id, execution_environment: "cloud" })) }); return; }
  if (command === "doctor") {
    const target = option(args, "--thread"), backend = option(args, "--backend", "app-server"); exact(args, 0);
    if (backend !== "app-server") throw failure("Cloud cannot use Desktop UI.", "CLOUD_TARGET_CONFLICT");
    if (target) {
      const id = cloudTaskId(target);
      if (supervisor) {
        const record = await getSupervisor(id);
        if (record?.session_id === supervisor) await assertSupervisor(id, supervisor, { connection: "cloud" });
        else if (record && record.state !== "stopped") throw failure("Another supervisor owns this cloud task.", "SUPERVISOR_CONFLICT");
      }
      await observeThread(id, { connection: "cloud", limit: 1 }, dependencies);
    } else { if (supervisor) throw failure("A bound supervisor doctor requires its target task.", "SUPERVISOR_CONTROL_FORBIDDEN"); await cloudEnvironments(); }
    output("doctor", { ready: true, backend: "codex-api", execution_environment: "cloud", version: VERSION,
      codex_steer_compatibility: { status: "compatible" }, connection: { status: "connected", mode: "cloud" },
      observation_compatibility: { status: target ? "verified" : "unverified" },
      runtime_compatibility: { operations: Object.fromEntries(["read", "watch", "monitor", "history_check", "send", "send_new_turn"].map(name => [name, { status: "supported" }])) },
      active_send_semantics: "interrupt-and-follow-up; same task, new turn", unverified_features: ["approval_roundtrip", "atomic_server_freshness"] }); return;
  }
  if (command === "thread" && args[0] === "resolve") { args.shift(); exact(args, 1); const id = cloudTaskId(args[0]); output("thread.resolve", { thread_id: id, task_id: id, deep_link: `https://chatgpt.com/codex/tasks/${id}`, execution_environment: "cloud" }); return; }
  if (command === "open") {
    exact(args, 1); const id = await bound(args[0]), url = `https://chatgpt.com/codex/tasks/${id}`;
    if (process.platform !== "darwin") throw failure("Open this task URL in your browser; native browser launch is only implemented on macOS.", "CLOUD_CAPABILITY_UNSUPPORTED");
    const result = spawnSync("/usr/bin/open", [url], { encoding: "utf8", timeout: 5000 }); if (result.status !== 0) throw failure("Could not open the cloud task in the browser.", "CLOUD_OPEN_FAILED");
    output("open", { thread_id: id, deep_link: url, execution_environment: "cloud" }); return;
  }
  if (command === "diff") {
    const attempt = option(args, "--attempt"), timeout = option(args, "--timeout-ms"); exact(args, 1);
    const data = await cloudTaskDiff(await bound(args[0]), { ...(attempt === undefined ? {} : { attempt: Number(attempt) }), ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }) });
    if (json) output("diff", data);
    else if (data.diff === null) console.error("No server-recorded patch is available. This does not prove the cloud working copy has no changes; inspect read command evidence.");
    else process.stdout.write(data.diff);
    return;
  }
  if (command !== "send") throw failure("This cloud operation is not implemented yet. No Desktop fallback was attempted.", "CLOUD_CAPABILITY_UNSUPPORTED");
  const dryRun = flag(args, "--dry-run"), newTurn = flag(args, "--new-turn"), backend = option(args, "--backend", "app-server");
  const noSound = flag(args, "--no-sound"), explicitSound = flag(args, "--sound"); if (noSound && explicitSound) throw failure("--sound and --no-sound cannot be combined.");
  if (backend !== "app-server") throw failure("Cloud cannot send through Desktop UI.", "CLOUD_TARGET_CONFLICT");
  const options = { dryRun, newTurn, supervisor, connection: "cloud", evidence: repeated(args, "--evidence") };
  for (const [key, name] of Object.entries({ source: "--source", kind: "--kind", basedOn: "--based-on", supersedes: "--supersedes", expiresAt: "--expires-at", checkpoint: "--checkpoint", finding: "--finding" })) { const value = option(args, name); if (value !== undefined) options[key] = value; }
  const id = cloudTaskId(args.shift()), end = args.includes("--") ? args.indexOf("--") : args.length;
  if (args.slice(0, end).some(arg => arg.startsWith("--"))) throw failure("Unknown send option. Use -- before instruction text starting with --.");
  const body = message(args); if (!body.trim()) throw failure("send requires a non-empty message.");
  const receipt = await sendTrackedMessage(id, body, options);
  receipt.sound = noSound ? { played: false, reason: "disabled" } : playSendSound(receipt);
  output("send", receipt);
}
