import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { BUNDLED_CLI } from "../src/wrapper.mjs";
import { readSendState, sendOnClient } from "../src/app-server.mjs";

function bounded(promise, label, milliseconds = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// Explicit opt-in: only a synthetic HOME/CODEX_HOME and a local mock Responses
// server are used. No real profile, credentials, or external model calls.
test("bundled Codex safely steers past an orphaned historical inProgress turn", {
  skip: process.env.CODEXTEER_TEST_STEER_REPLAY !== "1", timeout: 60000,
}, async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const home = await mkdtemp("/private/tmp/ct-steer-replay-");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000010", old = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011", next = "aaaaaaaa-aaaa-4aaa-8aaa-000000000012";
  const rejectedText = "LOCAL_STALE_REJECTED_STEER_REPLAY", acceptedText = "LOCAL_ACTIVE_ACCEPTED_STEER_REPLAY";
  let child, exited, lines, mock, heldResponse, stderr = "";
  const connections = new Set(), pending = new Map(), modelBodies = [], mockErrors = [], steerRequests = [];
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try { await bounded(exited, "isolated app-server shutdown", 3000); }
        catch { child.kill("SIGKILL"); await bounded(exited, "isolated app-server forced shutdown", 3000); }
      }
    } finally {
      lines?.close();
      for (const entry of pending.values()) entry.reject(new Error("Isolated app-server closed"));
      for (const socket of connections) socket.destroy();
      try { if (mock?.listening) await bounded(new Promise(resolve => mock.close(resolve)), "mock server shutdown", 3000); }
      finally { await rm(home, { recursive: true, force: true }); }
    }
  });
  const dir = `${home}/sessions/2026/10/11`; await mkdir(dir, { recursive: true });
  const file = `${dir}/rollout-2026-10-11T00-00-00-${id}.jsonl`;
  const event = payload => ({ type: "event_msg", payload });
  const start = turn_id => event({ type: "task_started", turn_id, root_turn_id: turn_id, started_at: 1791676800, model_context_window: 258400, collaboration_mode_kind: "default" });
  const item = (turn_id, itemId, text) => event({ type: "item_completed", thread_id: id, turn_id,
    item: { type: "AgentMessage", id: itemId, content: [{ type: "Text", text }], phase: "commentary" }, started_at_ms: 1791676800000, completed_at_ms: 1791676801000 });
  const rows = [
    { type: "session_meta", payload: { id, session_id: id, timestamp: "2026-10-11T00:00:00Z", cwd: home, originator: "codex_cli_rs", cli_version: "0.162.0-alpha.17.2", source: "cli", model_provider: "steer-test", history_mode: "paginated", base_instructions: { text: "" } } },
    start(old), item(old, "message-old", "Keep old content exactly."),
    start(next), item(next, "message-new", "Keep new content exactly."),
    event({ type: "task_complete", turn_id: next, root_turn_id: next, last_agent_message: "done", started_at: 1791676800, completed_at: 1791676802, duration_ms: 2000 }),
  ];
  const original = rows.map((row, ordinal) => JSON.stringify({ timestamp: "2026-10-11T00:00:00Z", ordinal, ...row })).join("\n") + "\n";
  await writeFile(file, original);
  const raw = () => {
    const db = new DatabaseSync(`${home}/thread_history_1.sqlite`, { readOnly: true });
    try {
      return {
        states: db.prepare("SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal").all(id).map(row => [row.turn_id, row.status]),
        items: db.prepare("SELECT turn_id,item_json FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal").all(id),
      };
    } finally { db.close(); }
  };
  const finishResponse = (response, number) => {
    const message = { id: `msg_mock_${number}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `LOCAL_MOCK_RESPONSE_${number}`, annotations: [] }] };
    for (const data of [
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: `resp_mock_${number}`, object: "response", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
    response.end();
  };
  let resolveModelRequest, resolveCompleted;
  const modelRequest = new Promise(resolve => { resolveModelRequest = resolve; });
  const completed = new Promise(resolve => { resolveCompleted = resolve; });
  mock = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
      let body = ""; for await (const chunk of request) body += chunk;
      modelBodies.push(body); assert.ok(modelBodies.length <= 4, "mock must not enter an unbounded request loop");
      response.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive" });
      response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_mock_${modelBodies.length}`, object: "response", created_at: 1791676800, status: "in_progress", model: "mock-model", output: [] } })}\n\n`);
      if (modelBodies.length === 1) { heldResponse = response; resolveModelRequest(); }
      else finishResponse(response, modelBodies.length);
    } catch (error) { mockErrors.push(error); response.destroy(); }
  });
  mock.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${mock.address().port}/v1`;
  child = spawn(process.env.CODEXTEER_TEST_STEER_CLI || BUNDLED_CLI, [
    "app-server", "--stdio", "-c", 'model_provider="steer-test"', "-c",
    `model_providers.steer-test={name="Steer test",base_url="${base}",wire_api="responses",stream_idle_timeout_ms=300000}`,
    "-c", 'model="gpt-5.4"',
  ], { cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, OPENAI_BASE_URL: base }, stdio: ["pipe", "pipe", "pipe"] });
  exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  let sequence = 0;
  lines = createInterface({ input: child.stdout });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.on("error", error => { for (const entry of pending.values()) entry.reject(error); });
  lines.on("line", line => {
    let reply; try { reply = JSON.parse(line); } catch { return; }
    if (reply.method === "turn/completed") resolveCompleted(reply.params.turn);
    const entry = pending.get(reply.id);
    if (entry) {
      if (reply.error) entry.reject(Object.assign(new Error(reply.error.message), { rpcCode: reply.error.code }));
      else entry.resolve(reply.result);
    }
  });
  const request = (method, params) => {
    if (method === "turn/steer") steerRequests.push(params);
    const requestId = ++sequence;
    const response = new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    return bounded(response, `${method}; ${stderr}`).finally(() => pending.delete(requestId));
  };
  const client = { request };
  await request("initialize", { clientInfo: { name: "codexteer-steer-replay-test", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  await request("thread/resume", { threadId: id, path: file, cwd: home, modelProvider: "steer-test", excludeTurns: true });
  const before = raw();
  assert.deepEqual(before.states, [[old, "inProgress"], [next, "completed"]]);
  const started = await request("turn/start", { threadId: id, input: [{ type: "text", text: "LOCAL_SYNTHETIC_START_STEER_REPLAY" }] });
  const active = started.turn.id;
  await bounded(modelRequest, "first local mock model request");
  const observed = await readSendState(client, id);
  assert.equal(observed.historyMode, "paginated"); assert.equal(observed.status.type, "active");
  assert.deepEqual(observed.turns.filter(turn => turn.status === "inProgress").map(turn => turn.id), [old, active]);
  // Control: nonempty input with the stale ID must be rejected before delivery.
  await assert.rejects(request("turn/steer", { threadId: id, expectedTurnId: old, input: [{ type: "text", text: rejectedText }] }), error => {
    assert.equal(error.rpcCode, -32600); assert.ok(error.message.includes(old)); assert.ok(error.message.includes(active)); return true;
  });
  assert.equal(JSON.stringify(raw().items).includes(rejectedText), false);
  assert.equal((await readFile(file, "utf8")).includes(rejectedText), false);
  const receipt = await sendOnClient(client, id, acceptedText, { clientMessageId: "local-active-accepted" });
  assert.equal(receipt.turn_id, active);
  assert.deepEqual(steerRequests.map(params => params.expectedTurnId), [old, active], "codexteer must make one guarded delivery attempt");
  finishResponse(heldResponse, 1);
  const finalTurn = await bounded(completed, "local mock turn completion");
  assert.equal(finalTurn.id, active); assert.equal(finalTurn.status, "completed");
  assert.equal(modelBodies.length, 2); assert.equal(modelBodies[1].includes(acceptedText), true);
  assert.ok(modelBodies.every(body => !body.includes(rejectedText)));
  assert.deepEqual(mockErrors, []);
  const after = raw(), rollout = await readFile(file, "utf8");
  assert.deepEqual(after.states, [[old, "inProgress"], [next, "completed"], [active, "completed"]], "steering must not rewrite the old orphan");
  assert.deepEqual(after.items.filter(row => row.turn_id === old || row.turn_id === next), before.items);
  assert.equal(JSON.stringify(after.items).includes(acceptedText), true); assert.equal(JSON.stringify(after.items).includes(rejectedText), false);
  assert.ok(rollout.startsWith(original)); assert.equal(rollout.includes(acceptedText), true); assert.equal(rollout.includes(rejectedText), false);
});
