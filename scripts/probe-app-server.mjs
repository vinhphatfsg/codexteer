// Real bundled CLI + wrapper + simulated Desktop + local fake model.
// Does not launch Desktop, read account credentials, or invoke a paid model.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RpcClient } from "../src/rpc.mjs";
import { sendAppServerMessage } from "../src/app-server.mjs";
import { observeThread } from "../src/observe.mjs";
import { getMessage, reconcileMessages, listInstructions } from "../src/journal.mjs";
import { discoverRuntime, runtimePaths } from "../src/runtime.mjs";
import { BUNDLED_CLI, BUNDLED_NODE } from "../src/wrapper.mjs";
import { appServerDoctor } from "../src/launcher.mjs";
import { streamThread } from "../src/monitor.mjs";
import { prepareDeployment } from "../src/distribution.mjs";
import { RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL } from "../src/compatibility.mjs";

class SimulatedDesktop {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.requests = [];
    this.notifications = [];
    createInterface({ input: child.stdout }).on("line", line => {
      const message = JSON.parse(line);
      if (message.method) {
        if (message.id != null) this.requests.push(message);
        else this.notifications.push(message);
      } else {
        const request = this.pending.get(message.id);
        assert.ok(request, "Helper response must not leak into Desktop's stdio stream");
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`Desktop RPC rejected (${message.error.code})`));
        else request.resolve(message.result);
      }
    });
  }
  write(message) { this.child.stdin.write(JSON.stringify(message) + "\n"); }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  respond(request, result) { this.write({ id: request.id, result }); }
}

async function until(check, label) {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}

const root = await mkdtemp("/private/tmp/cs-probe-");
const paths = await runtimePaths(root);
let child;
let monitor;
let desktop;
let deployment;
let diagnostics = "";
const peers = new Set();
const streams = [];
let providerRequests = 0;
const deltaTimings = [];
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).input);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const markers = ["probe warm new turn", "probe cold new turn", "probe question"].filter(marker => input.includes(marker));
  const entry = { response, id: `probe-response-${++providerRequests}`, used: false, marker: markers.at(-1) };
  response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: entry.id } })}\n\n`);
  streams.push(entry);
});

async function boot() {
  // Exercise the Desktop branch under the real bundled Node. A test runner is
  // deliberately not classified as Desktop by the executable entry point.
  deployment ??= await prepareDeployment(root);
  const code = `import { runWrapper } from ${JSON.stringify(pathToFileURL(path.join(deployment.directory, "src/wrapper.mjs")).href)}; process.exitCode = await runWrapper(process.argv.slice(1), { desktopProcess: true });`;
  child = spawn(BUNDLED_NODE, ["--input-type=module", "-e", code, "--", "-c", "features.plugins=false", "app-server", "--analytics-default-enabled"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: root, RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-8000); });
  desktop = new SimulatedDesktop(child);
  await desktop.request("initialize", { clientInfo: { name: "codex_steer_probe_desktop", version: "0.8.0" }, capabilities: { experimentalApi: true } });
  // Match the inspected Desktop build: it does not send an initialized notification.
  const runtime = await until(() => discoverRuntime(root).catch(() => false), "wrapper ready");
  assert.equal(runtime.state.node_path, BUNDLED_NODE, "Desktop wrapper must use the signed bundled Node runtime");
  assert.ok(Number(runtime.state.node_version.split(".")[0]) >= 20);
  assert.equal(runtime.state.distribution_sha256, deployment.sha256);
  assert.equal(runtime.state.codex_steer_protocol, RUNTIME_PROTOCOL);
  assert.deepEqual(runtime.state.codex_steer_capabilities, RUNTIME_CAPABILITIES);
}

// Model metadata from wrappers that predate capability advertisement, while
// exercising the same v1 wire requests against the real bundled App Server.
async function legacyRuntime(profile) {
  const runtime = await discoverRuntime(root), state = { ...runtime.state };
  delete state.codex_steer_capabilities;
  if (profile === "pre-version") {
    for (const key of ["codex_steer_package", "codex_steer_version", "codex_steer_protocol", "distribution_sha256"]) delete state[key];
  } else state.codex_steer_version = "0.13.0";
  return { ...runtime, state };
}

async function checkHelperPassThrough() {
  const before = (await discoverRuntime(root)).state;
  const helper = spawn(deployment.wrapper_path, ["-c", "features.plugins=false", "app-server"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: root, RUST_LOG: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  helper.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-8000); });
  const helperClient = new SimulatedDesktop(helper);
  try {
    await helperClient.request("initialize", { clientInfo: { name: "codex_steer_probe_helper", version: "0.8.0" } });
    const loaded = await helperClient.request("thread/loaded/list");
    assert.deepEqual(loaded.data, []);
    const after = (await discoverRuntime(root)).state;
    assert.equal(after.instance, before.instance);
    assert.equal(after.server_pid, before.server_pid);
  } finally {
    if (helper.exitCode == null && helper.signalCode == null) {
      const done = once(helper, "exit");
      // MCP owners terminate their CLI helper when a tool session closes.
      helper.kill("SIGTERM");
      const timer = setTimeout(() => helper.kill("SIGKILL"), 5000);
      try { await done; } finally { clearTimeout(timer); }
    }
  }
  assert.equal((await discoverRuntime(root)).state.instance, before.instance);
  console.log(JSON.stringify({ checkpoint: "CP2-protocol-helper", result: "PASS", helper_stdio_initialized: true, shared_runtime_unchanged: true }));
}

async function shutdown() {
  for (const peer of peers) peer.close();
  peers.clear();
  if (child && child.exitCode == null && child.signalCode == null) {
    const closed = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  child = null;
}

async function external() {
  const client = await RpcClient.connect(paths.socket);
  peers.add(client);
  return client;
}

async function idle(threadId) {
  await until(async () => (await desktop.request("thread/read", { threadId })).thread.status.type === "idle", "task idle");
}

async function modelOutput(makeItem, marker) {
  const stream = await until(() => streams.find(s => s.marker === marker && !s.used && !s.response.destroyed && !s.response.writableEnded), "fake-model stream");
  stream.used = true;
  const item = makeItem(stream);
  for (const event of [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: stream.id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) stream.response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  stream.response.end();
}

async function modelTool(name, args, marker) {
  await modelOutput(stream => ({ type: "function_call", id: `fc-${stream.id}`, call_id: `call-${stream.id}`, name, arguments: JSON.stringify(args) }), marker);
}

async function checkUserMessageIdentity(threadId, receipt, expectedText) {
  const notification = await until(() => desktop.notifications.find(m => m.method === "item/completed" && m.params.threadId === threadId && m.params.turnId === receipt.turn_id && m.params.item?.type === "userMessage" && m.params.item.clientId === receipt.client_message_id), "Desktop user message with clientId");
  assert.deepEqual(notification.params.item.content, [{ type: "text", text: expectedText, text_elements: [] }]);
  const { thread } = await desktop.request("thread/read", { threadId, includeTurns: true });
  const messages = thread.turns.find(t => t.id === receipt.turn_id).items.filter(item => item.type === "userMessage" && item.clientId === receipt.client_message_id);
  assert.equal(messages.length, 1, "One persisted user message per send, with its presentation identity");
  assert.equal(messages[0].id, notification.params.item.id);
}

async function measureChangedRead(threadId, since, label) {
  const started = performance.now();
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../bin/codex-steer.mjs", import.meta.url)), "read", threadId, "--since", since, "--json"], {
    cwd: root, env: { ...process.env, CODEX_HOME: root }, timeout: 15000,
  });
  const ms = performance.now() - started, { ok, data } = JSON.parse(stdout);
  assert.equal(ok, true); assert.equal(data.history_scope, "tail-and-tracked-items");
  assert.equal(data.changed, true); assert.ok(data.events.length > 0);
  assert.ok(ms < 1000, `${label}: changed read took ${ms.toFixed(2)} ms (must be < 1000 ms)`);
  deltaTimings.push({ label, ms: Math.round(ms * 100) / 100, events: data.events.length });
  return data;
}

async function approval(threadId, turnId, marker) {
  await modelTool("exec_command", { cmd: "printf probe", sandbox_permissions: "require_escalated", justification: "Isolated approval routing test" }, marker);
  const request = await until(() => desktop.requests.find(r => r.method === "item/commandExecution/requestApproval" && r.params.threadId === threadId && r.params.turnId === turnId), "Desktop approval request");
  const observed = await observeThread(threadId, { watch: true, until: "attention", timeoutMs: 1000 }, { discover: () => discoverRuntime(root) });
  assert.equal(observed.timed_out, false);
  assert.ok(observed.attention.includes("waitingOnApproval"));
  desktop.respond(request, { decision: "decline" });
  await desktop.request("turn/interrupt", { threadId, turnId });
  await idle(threadId);
}

try {
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  await writeFile(`${root}/config.toml`, `model = "gpt-5.4"\nmodel_provider = "probe"\ncli_auth_credentials_store = "file"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\nplugins = false\nremote_plugin = false\napps = false\n[analytics]\nenabled = false\n`);
  await boot();
  await checkHelperPassThrough();
  const { thread } = await desktop.request("thread/start", { cwd: root, model: "gpt-5.4", approvalPolicy: "on-request", sandbox: "read-only" });
  const { turn } = await desktop.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "probe initial" }] });
  const cli = await external();
  // The start response can precede visibility on another connection. Wait for
  // this exact turn, with the same bounded wait used for other protocol events.
  const read = await until(async () => {
    const value = await cli.request("thread/read", { threadId: thread.id, includeTurns: true });
    return value.thread.status.type === "active" && value.thread.turns.at(-1)?.id === turn.id ? value : null;
  }, "started turn visible to the observer");
  assert.equal(read.thread.status.type, "active");
  assert.equal(read.thread.turns.at(-1).id, turn.id);
  const observation = await observeThread(thread.id, {}, { discover: () => legacyRuntime("pre-version") });
  assert.equal(observation.active_turn_id, turn.id);
  const result = await sendAppServerMessage(thread.id, "日本語\nprobe steer", { discover: () => legacyRuntime("pre-version") });
  assert.equal(result.turn_id, turn.id);
  await assert.rejects(cli.request("turn/steer", { threadId: thread.id, expectedTurnId: "stale", input: [{ type: "text", text: "must reject" }] }), { code: "RPC_REJECTED" });
  // Reach a model boundary so queued steering is consumed. Check the real
  // server's Desktop notification and persisted item, not only the steer ACK.
  await modelOutput(stream => ({ type: "message", id: `msg-${stream.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "probe response" }] }));
  await checkUserMessageIdentity(thread.id, result, "日本語\nprobe steer");
  const delta = await measureChangedRead(thread.id, observation.cursor, "first-user-input");
  assert.ok(delta.events.some(e => e.client_message_id === result.client_message_id));
  assert.ok(delta.events.every(e => e.type !== "reasoning"));
  // Exercise the default backend in another cwd, including URL shorthand and
  // argv text. A second identical message must retain its own identity, too.
  const cliSend = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../bin/codex-steer.mjs", import.meta.url)), `codex://threads/${thread.id}`, "日本語\nprobe steer", "--json"], {
    cwd: root, env: { ...process.env, CODEX_HOME: root }, timeout: 15000,
  });
  const cliReceipt = JSON.parse(cliSend.stdout);
  assert.equal(cliReceipt.ok, true);
  assert.equal(cliReceipt.data.backend, "app-server");
  assert.equal(cliReceipt.data.thread_id, thread.id);
  assert.notEqual(cliReceipt.data.client_message_id, result.client_message_id);
  await modelOutput(stream => ({ type: "message", id: `msg-${stream.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "probe response 2" }] }));
  await checkUserMessageIdentity(thread.id, cliReceipt.data, "日本語\nprobe steer");
  const secondDelta = await measureChangedRead(thread.id, delta.cursor, "second-user-input");
  assert.ok(secondDelta.events.some(e => e.client_message_id === cliReceipt.data.client_message_id));
  const journal = await getMessage(thread.id, cliReceipt.data.message_id, { home: root });
  assert.equal(journal.client_message_id, cliReceipt.data.client_message_id);
  const verifiedJournal = await reconcileMessages(thread.id, journal.id, { home: root }, { discover: () => discoverRuntime(root) });
  assert.equal(verifiedJournal[0].verification.status, "stored");
  const fresh = await observeThread(thread.id, {}, { discover: () => discoverRuntime(root) });
  await writeFile(`${root}/evidence.txt`, "synthetic review evidence");
  const cliArgs = [fileURLToPath(new URL("../bin/codex-steer.mjs", import.meta.url))];
  const cliOptions = { cwd: root, env: { ...process.env, CODEX_HOME: root }, timeout: 15000 };
  const typed = JSON.parse((await promisify(execFile)(process.execPath, [...cliArgs, "send", thread.id, "訂正した仮説", "--source", "claude-code", "--kind", "hypothesis", "--evidence", `${root}/evidence.txt`, "--based-on", fresh.cursor, "--supersedes", journal.id, "--json"], cliOptions)).stdout).data;
  const typedEntry = await getMessage(thread.id, typed.message_id, { home: root });
  assert.equal(typedEntry.metadata.supersedes, journal.id);
  await modelOutput(stream => ({ type: "message", id: `msg-${stream.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "probe response 3" }] }));
  await checkUserMessageIdentity(thread.id, typed, typedEntry.wire_text);
  const typedDelta = await measureChangedRead(thread.id, fresh.cursor, "typed-replacement");
  assert.ok(typedDelta.events.some(e => e.client_message_id === typed.client_message_id));
  assert.equal((await reconcileMessages(thread.id, typed.message_id, { home: root }, { discover: () => discoverRuntime(root) }))[0].verification.status, "stored");
  assert.equal((await listInstructions(thread.id, { home: root, all: true })).instructions.find(e => e.id === journal.id).instruction_status, "superseded");
  await assert.rejects(promisify(execFile)(process.execPath, [...cliArgs, "send", thread.id, "must not send stale review", "--based-on", fresh.cursor, "--json"], cliOptions), error => {
    const response = JSON.parse(error.stdout);
    assert.equal(response.error.code, "STALE_OBSERVATION"); assert.equal(response.error.sent, false); return true;
  });

  await modelTool("exec_command", { cmd: "sleep 2", yield_time_ms: 1000 });
  const runningItem = await until(() => desktop.notifications.find(m => m.method === "item/started" && m.params.turnId === turn.id && m.params.item?.type === "commandExecution"), "running command");
  // Some builds publish command history only at completion, even though the
  // Desktop has received item/started. Both readers observe persisted history.
  const runningRead = await observeThread(thread.id, {}, { discover: () => discoverRuntime(root) });
  const historyHadRunning = runningRead.running_commands.some(e => e.id === runningItem.params.item.id);
  await until(() => desktop.notifications.find(m => m.method === "item/completed" && m.params.item?.id === runningItem.params.item.id), "command completion");
  await until(async () => (await cli.request("thread/items/list", { threadId: thread.id, sortDirection: "desc", limit: 50 })).data.some(r => r.item.id === runningItem.params.item.id && r.item.status === "completed"), "command completion persisted");
  const completedRead = await measureChangedRead(thread.id, runningRead.cursor, "command-completion");
  assert.ok(completedRead.events.some(e => e.id === runningItem.params.item.id && e.change === (historyHadRunning ? "updated" : "added") && e.status === "completed"));
  console.log(JSON.stringify({ checkpoint: "changed-read-performance", result: "PASS", samples: deltaTimings, max_ms: Math.max(...deltaTimings.map(s => s.ms)), threshold_ms: 1000, includes_cli_startup: true, history_had_running_command: historyHadRunning }));

  const beforeDoctorRequests = providerRequests;
  const doctor = await appServerDoctor({ threadId: thread.id, discover: () => discoverRuntime(root) });
  assert.equal(doctor.ready, true, doctor.remediation);
  assert.equal(doctor.compatibility.status, "verified");
  for (const profile of ["pre-version", "v0.13"]) {
    const legacyDoctor = await appServerDoctor({ threadId: thread.id, discover: () => legacyRuntime(profile) });
    assert.equal(legacyDoctor.ready, true, legacyDoctor.remediation);
    assert.equal(legacyDoctor.compatibility.status, "verified");
    assert.equal(legacyDoctor.runtime_compatibility.operations.send_new_turn.status, "supported");
  }
  assert.equal(providerRequests, beforeDoctorRequests, "Doctor never invokes the model");
  const reconnectStates = [], stopWatch = new AbortController(); let watchClient;
  const watchDeadline = setTimeout(() => stopWatch.abort(), 5000);
  try {
    await streamThread(thread.id, { since: completedRead.cursor, pollMs: 250, signal: stopWatch.signal }, async data => {
      if (data.type !== "connection") return;
      reconnectStates.push(data.state);
      if (data.state === "watching") watchClient.close();
      if (data.state === "recovered") stopWatch.abort();
    }, { discover: () => discoverRuntime(root), connect: async (...args) => (watchClient = await RpcClient.connect(...args)) });
  } finally { clearTimeout(watchDeadline); }
  assert.deepEqual(reconnectStates, ["watching", "reconnecting", "recovered"]);
  assert.equal(providerRequests, beforeDoctorRequests, "Reconnect never sends or resumes a turn");
  console.log(JSON.stringify({ checkpoint: "observation-recovery", result: "PASS", doctor: doctor.compatibility, reconnect_states: reconnectStates, real_desktop_validated: false }));

  // Exactly the command a Monitor consumer runs, including backlog pagination
  // and cancellation while the task's model call is still in progress.
  const monitorLines = []; let monitorErrors = "";
  monitor = spawn(BUNDLED_NODE, [...cliArgs, "watch", thread.id, "--stream", "--since", observation.cursor, "--limit", "1", "--poll-ms", "250"], { ...cliOptions, timeout: undefined, stdio: ["ignore", "pipe", "pipe"] });
  const monitorExit = once(monitor, "exit");
  createInterface({ input: monitor.stdout }).on("line", line => monitorLines.push(line));
  monitor.stderr.on("data", data => { monitorErrors += data; });
  await until(() => monitorLines.map(line => JSON.parse(line)).find(line => line.data?.type === "observation" && line.data.events.some(e => e.client_message_id === typed.client_message_id)), "Monitor typed message");
  await until(() => monitorLines.map(line => JSON.parse(line)).find(line => line.data?.type === "observation" && line.data.events.some(e => e.id === runningItem.params.item.id && e.status === "completed")), "Monitor completed command");
  assert.ok(monitorLines.every(line => JSON.parse(line).ok === true));
  const lineCount = monitorLines.length;
  await delay(600); assert.equal(monitorLines.length, lineCount, "Unchanged task does not produce Monitor heartbeats");
  monitor.kill("SIGTERM");
  assert.deepEqual(await monitorExit, [0, null]); assert.equal(monitorErrors, ""); monitor = null;
  console.log(JSON.stringify({ checkpoint: "steering-assistance-monitor", result: "PASS", typed_replacement_stored: true, stale_review_rejected: true, jsonl_cursor_pages: true, silent_when_unchanged: true, cancellation: true }));
  await desktop.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await idle(thread.id);
  console.log(JSON.stringify({ checkpoint: "CP1-CP3-protocol", result: "PASS", thread_id: thread.id, turn_id: turn.id, stale_turn_rejected: true, desktop_steer_client_id: true, cli_url_shorthand_client_id: true }));

  const next = await sendAppServerMessage(thread.id, "probe warm new turn", { newTurn: true, discover: () => legacyRuntime("v0.13") });
  await checkUserMessageIdentity(thread.id, next, "probe warm new turn");
  await approval(thread.id, next.turn_id, "probe warm new turn");
  console.log(JSON.stringify({ checkpoint: "CP4-protocol-warm", result: "PASS", desktop_approval_after_sender_exit: true }));

  await shutdown();
  await boot();
  const coldClient = await external();
  const stored = (await coldClient.request("thread/read", { threadId: thread.id, includeTurns: true })).thread;
  assert.equal(stored.status.type, "notLoaded");
  const coldObservation = await observeThread(thread.id, {}, { discover: () => discoverRuntime(root) });
  assert.equal(coldObservation.status, "notLoaded", "Observation never resumes a cold task");
  assert.equal(stored.turns.flatMap(t => t.items).filter(item => item.type === "userMessage" && item.clientId === next.client_message_id).length, 1, "User message identity survives server restart");
  const cold = await sendAppServerMessage(thread.id, "probe cold new turn", { newTurn: true, discover: () => legacyRuntime("pre-version") });
  await approval(thread.id, cold.turn_id, "probe cold new turn");
  assert.ok(desktop.notifications.some(m => m.method === "turn/started" && m.params.threadId === thread.id));
  console.log(JSON.stringify({ checkpoint: "CP4-protocol-cold", result: "PASS", unloaded_resume: true, desktop_approval_after_sender_exit: true }));

  const questionTurn = await desktop.request("turn/start", {
    threadId: thread.id, input: [{ type: "text", text: "probe question" }],
    collaborationMode: { mode: "plan", settings: { model: "gpt-5.4" } },
  });
  await modelTool("request_user_input", { questions: [{ id: "probe", header: "Probe", question: "Synthetic test question", options: [{ label: "Yes", description: "Test answer" }, { label: "No", description: "Test alternative" }] }] }, "probe question");
  const question = await until(() => desktop.requests.find(m => m.method === "item/tool/requestUserInput" && m.params.turnId === questionTurn.turn.id), "Desktop question");
  desktop.respond(question, { answers: { probe: { answers: ["Yes"] } } });
  await desktop.request("turn/interrupt", { threadId: thread.id, turnId: questionTurn.turn.id });
  await idle(thread.id);
  console.log(JSON.stringify({ checkpoint: "CP4-protocol-question", result: "PASS", desktop_question_roundtrip: true }));
  const beforeRollback = await observeThread(thread.id, {}, { discover: () => discoverRuntime(root) });
  await desktop.request("thread/revert", { threadId: thread.id, beforeTurnId: questionTurn.turn.id });
  await assert.rejects(observeThread(thread.id, { since: beforeRollback.cursor }, { discover: () => discoverRuntime(root) }), { code: "STALE_CURSOR" });
  console.log(JSON.stringify({ checkpoint: "paged-read-rollback", result: "PASS", stale_cursor_rejected: true }));
  // Kill only the server launched by this isolated probe. Desktop stdin remains
  // open, so the wrapper must notice the broken connection and clean up itself.
  const { state } = await discoverRuntime(root);
  const wrapperExit = once(child, "exit");
  process.kill(state.server_pid, "SIGTERM");
  const [exitCode] = await wrapperExit;
  assert.notEqual(exitCode, 0);
  await assert.rejects(discoverRuntime(root), /unavailable/);
  console.log(JSON.stringify({ checkpoint: "CP2-protocol-cleanup", result: "PASS", server_crash_cleanup: true }));
  const version = spawnSync(BUNDLED_CLI, ["--version"], { encoding: "utf8" }).stdout.trim();
  console.log(JSON.stringify({ suite: "isolated-app-server", result: "PASS", cli: version, real_desktop_validated: false }));
} catch (error) {
  console.error(error.message);
  console.error(JSON.stringify({ requests: desktop?.requests.map(m => m.method), notifications: desktop?.notifications.slice(-8).map(m => ({ method: m.method, item: m.params?.item?.type })) }));
  console.error(diagnostics); // isolated environment, synthetic input, no credentials
  process.exitCode = 1;
} finally {
  if (monitor && monitor.exitCode === null && monitor.signalCode === null) { const done = once(monitor, "exit"); monitor.kill("SIGTERM"); await done; }
  await shutdown();
  for (const stream of streams) stream.response.destroy();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  await rm(paths.directory, { recursive: true, force: true, maxRetries: 3 });
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
