import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { cloudCredentials, cloudApi, cloudEnvironments } from "../src/cloud-api.mjs";
import { readCloudTask, sendCloudTask, reconcileCloudSend, cloudUserRevision, cloudSendReceipt } from "../src/cloud-observe.mjs";

const task = "task_fixture_cloud", turn = `${task}~assttrn_fixture_1`, user = `${task}~usertrn_fixture_1`;
const revision = cloudUserRevision({ turns: [] }), attempt = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const observation = { task_id: task, turn_id: turn, status: "completed", turns: [] };
const hash = text => createHash("sha256").update(text).digest("hex");
const auth = async () => ({ token: "fixture-only-token", accountId: "fixture-account" });
const ok = value => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
function fakeServer(answer, calls) {
  return (exe, args) => {
    calls.push({ exe, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    child.stdin.on("data", bytes => {
      for (const line of bytes.toString().trim().split("\n")) {
        const message = JSON.parse(line); calls.push(message);
        if (message.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: message.id === 1 ? {} : answer }) + "\n"));
      }
    });
    return child;
  };
}

test("cloud authentication delegates to official stdio API and never starts a model or reads auth files", async () => {
  const calls = [], token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  assert.deepEqual(await cloudCredentials({ spawnProcess: fakeServer({ authMethod: "chatgpt", authToken: token }, calls) }), { token, accountId: "fixture-account" });
  assert.deepEqual(calls[0], { exe: "codex", args: ["app-server", "--listen", "stdio://"] });
  assert.deepEqual(calls.slice(1).map(c => c.method), ["initialize", "initialized", "getAuthStatus"]);
  assert.deepEqual(calls.at(-1).params, { includeToken: true, refreshToken: false });
});

test("cloud auth refuses API keys, missing account and unsafe headers without leaking credentials", async () => {
  for (const answer of [{ authMethod: "apikey", authToken: "private-marker" }, { authMethod: "chatgpt", authToken: "private-marker" }, { authMethod: "chatgpt", authToken: "private-marker\n" }]) {
    await assert.rejects(cloudCredentials({ spawnProcess: fakeServer(answer, []) }), error => /CLOUD_/.test(error.code) && !error.message.includes("private-marker"));
  }
});

test("cloud HTTP fixes the official origin, rejects redirects, bounds input and never emits raw failures", async () => {
  let request;
  assert.deepEqual(await cloudApi("environments", { credentials: auth, fetchRequest: async (...args) => { request = args; return ok([]); } }), []);
  assert.equal(request[0], "https://chatgpt.com/backend-api/wham/environments");
  assert.equal(request[1].redirect, "error"); assert.equal(request[1].method, "GET");
  assert.equal(request[1].headers.Authorization, "Bearer fixture-only-token");
  for (const route of ["https://other.invalid", "../auth", "environments?url=other", "tasks/task_fixture/extra"]) await assert.rejects(cloudApi(route, { credentials: () => { throw new Error("must not load"); } }), { code: "CLOUD_OPTIONS_INVALID" });
  await assert.rejects(cloudApi("environments", { timeoutMs: NaN, credentials: () => { throw new Error("must not load"); } }), { code: "CLOUD_OPTIONS_INVALID" });
  await assert.rejects(cloudApi("environments", { credentials: auth, fetchRequest: async () => new Response("private-marker", { status: 403 }) }), error => error.code === "CLOUD_ACCESS_DENIED" && !error.message.includes("private-marker"));
  await assert.rejects(cloudApi("environments", { credentials: auth, fetchRequest: async () => { throw new Error("private-marker"); } }), error => error.code === "CLOUD_CONNECTION_FAILED" && !error.message.includes("private-marker"));
  await assert.rejects(cloudApi("environments", { credentials: auth, fetchRequest: async () => { throw Object.assign(new Error("private-marker"), { code: 20 }); } }), { code: "CLOUD_CONNECTION_FAILED" });
  await assert.rejects(cloudApi("environments", { timeoutMs: 5, credentials: auth, fetchRequest: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("private-marker", "AbortError")), { once: true });
  }) }), { code: "CLOUD_TIMEOUT" });
  await assert.rejects(cloudApi("environments", { credentials: auth, fetchRequest: async () => new Response("x".repeat(16 * 1024 * 1024 + 1)) }), { code: "CLOUD_OUTPUT_LIMIT" });
});

test("environment inventory allowlists names, IDs, repositories and branches, omitting secrets and setup", async () => {
  const value = await cloudEnvironments({}, { request: async () => [{ id: "env_fixture", label: "fixture/example", is_pinned: true, secrets: { fixture: "private-marker" }, env_vars: { private: "private-marker" }, setup: "private-marker",
    repo_map: { fixture: { repository_full_name: "fixture/example", default_branch: "main", clone_url: "private-marker" } } }] });
  assert.equal(value.environments[0].repositories[0].default_branch, "main");
  assert.doesNotMatch(JSON.stringify(value), /private-marker|secrets|env_vars|clone_url/);
  assert.match(value.source, /legacy/);
  for (const rows of [{}, [{ id: "../other" }], [{ id: "env_fixture", label: 8 }]]) await assert.rejects(cloudEnvironments({}, { request: async () => rows }), { code: "CLOUD_PROTOCOL_UNVERIFIED" });
});

test("rate limits expose only a bounded wait hint and never retry reads or submissions", async () => {
  for (const [header, expected] of [["30",30000],[null,15000],["invalid",15000],["0",1000],["9".repeat(400),Number.MAX_SAFE_INTEGER]]) {
    for (const body of [undefined, { fixture: true }]) {
      let requests = 0;
      await assert.rejects(cloudApi(body === undefined ? "environments" : "tasks", { body, credentials: auth, fetchRequest: async () => {
        requests++;
        return new Response("private-marker", { status: 429, headers: header === null ? {} : { "retry-after": header } });
      } }), e => e.code === "CLOUD_RATE_LIMITED" && e.http_status === 429 && e.retry_after_ms === expected && !e.message.includes("private-marker"));
      assert.equal(requests, 1);
    }
  }
});

function fixtureHistory() {
  const assistant = { id: turn, role: "assistant", turn_status: "completed", created_at: 2, output_items: [{ type: "message", role: "assistant", content: [{ content_type: "text", text: "done" }] }], worklog: { messages: [{ role: "assistant", content: [{ content_type: "text", text: "working" }] }] }, thread_events: { events: [
    { method: "item/completed", params: { item: { id: "fixture_command", type: "commandExecution", command: "printf 42", aggregatedOutput: "42", exitCode: 0, status: "completed", hidden: "private-marker" } } },
    { method: "rawResponseItem/completed", params: { item: { encrypted_content: "private-marker" } } },
  ] }, environment: { secrets: { leak: "private-marker" } } };
  const history = { current_turn_id: turn, turn_mapping: {
    [user]: { parent: null, turn: { id: user, role: "user", created_at: 1, input_items: [{ type: "message", content: ["initial"] }] } },
    [turn]: { parent: user, turn: assistant },
  } };
  const details = { task: { id: task, current_turn_id: turn }, current_assistant_turn: assistant };
  return { details, history, request: async route => route.endsWith("/turns") ? history : details };
}

test("cloud read binds every turn to the task, preserves history and progress, and detects races", async () => {
  const f = fixtureHistory(), value = await readCloudTask(task, {}, f);
  assert.equal(value.turns.length, 2); assert.equal(value.turns[1].progress[0].text, "working");
  assert.equal(value.turns[1].commands[0].output, "42"); assert.equal(value.turns[1].commands[0].exit_code, 0);
  assert.doesNotMatch(JSON.stringify(value), /private-marker|"environment":|"secrets":/);
  assert.equal(value.cursor, undefined);
  f.history.current_turn_id = user;
  await assert.rejects(readCloudTask(task, {}, f), { code: "CLOUD_STATE_CHANGED" });
  f.history.current_turn_id = turn; f.history.turn_mapping[user].turn.id = "task_other~usertrn_fixture";
  await assert.rejects(readCloudTask(task, {}, f), { code: "CLOUD_PROTOCOL_UNVERIFIED" });
});

test("public Cloud worklog commentary supports both text shapes and excludes private reasoning and tool/user messages", async () => {
  const f = fixtureHistory();
  f.history.turn_mapping[turn].turn.worklog.messages.push(
    { id: "progress_fixture", author: { role: "assistant" }, channel: "commentary", recipient: "all", content: { content_type: "text", parts: ["Public ", "update"] } },
    { author: { role: "assistant" }, channel: "analysis", content: { content_type: "text", parts: ["private-marker"] } },
    { role: "assistant", channel: "analysis", content: [{ content_type: "text", text: "private-marker" }] },
    { author: { role: "assistant" }, channel: "commentary", recipient: "tool", content: { content_type: "text", parts: ["private-marker"] } },
    { author: { role: "user" }, content: { content_type: "text", parts: ["private-marker"] } },
    { author: { role: "assistant" }, channel: "commentary", metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: "text", parts: ["private-marker"] } },
    { role: "assistant", metadata: { reasoning_status: "is_reasoning" }, content: [{ content_type: "text", text: "private-marker" }] },
  );
  f.history.turn_mapping[turn].turn.thread_events.events.push(
    { method: "item/started", params: { item: { id: "event_progress_fixture", type: "agentMessage", phase: "commentary", text: "Starting" } } },
    { method: "item/completed", params: { item: { id: "event_progress_fixture", type: "agentMessage", phase: "commentary", text: "Event update" } } },
    { method: "item/completed", params: { item: { id: "private_fixture", type: "agentMessage", phase: "analysis", text: "private-marker" } } },
    { method: "rawResponseItem/completed", params: { item: { id: "private_raw", type: "agentMessage", phase: "commentary", text: "private-marker" } } },
  );
  const value = await readCloudTask(task, {}, f), progress = value.turns[1].progress;
  assert.deepEqual(progress.map(p => p.text), ["working", "Public update", "Event update"]);
  assert.equal(progress[1].id, "progress_fixture");
  assert.doesNotMatch(JSON.stringify(value), /private-marker/);
});

function sendFixture({ status = "completed", failPost = false, failFinal = false } = {}) {
  const records = new Map(), calls = [];
  return { records, calls, read: async () => ({ ...observation, status }), lock: async (key, run) => run(), load: async (bucket, id) => records.get(`${bucket}/${id}`) ?? null,
    write: async (bucket, id, value) => { if (failFinal && value.submission_status === "accepted") throw new Error("private-marker"); records.set(`${bucket}/${id}`, structuredClone(value)); },
    request: async (route, settings) => { calls.push({ route, settings }); if (failPost) throw new Error("private-marker"); return { task: { id: task } }; },
  };
}

test("follow-up is one POST bound to observed task, exact parent turn, user revision and stdin text", async () => {
  const f = sendFixture(), prompt = "日本語\n$(no-shell)";
  const value = await sendCloudTask(task, turn, prompt, { expectedUserRevision: revision, deliveryMode: "new-turn" }, f);
  assert.equal(value.submission_status, "accepted"); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].settings.body.follow_up, { task_id: task, turn_id: turn, environment_mode: "code" });
  assert.equal(f.calls[0].settings.body.input_items[0].content[0].text, prompt);
  assert.doesNotMatch(JSON.stringify([...f.records.values()]), /日本語|no-shell/);
  await assert.rejects(sendCloudTask(task, turn, prompt, { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), { code: "CLOUD_DUPLICATE_SEND" });
  assert.equal(f.calls.length, 1);
});

test("stale user revision, cross-task turn, busy task and dry run never submit follow-up", async () => {
  const f = sendFixture();
  await assert.rejects(sendCloudTask(task, "task_other~assttrn_fixture", "test", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), { code: "CLOUD_OPTIONS_INVALID" });
  await assert.rejects(sendCloudTask(task, turn, "test", { expectedUserRevision: "b".repeat(64), deliveryMode: "new-turn" }, f), { code: "CLOUD_STATE_CHANGED" });
  await assert.rejects(sendCloudTask(task, turn, "test", { expectedUserRevision: revision, deliveryMode: "new-turn" }, sendFixture({ status: "in_progress" })), { code: "CLOUD_TASK_BUSY" });
  assert.equal((await sendCloudTask(task, turn, "test", { expectedUserRevision: revision, deliveryMode: "new-turn", dryRun: true }, f)).submission_status, "not_sent");
  assert.equal(f.calls.length, 0); assert.equal(f.records.size, 0);
});

test("unknown follow-up is never retried, blocks another send and retains private recovery receipt", async () => {
  const f = sendFixture({ failPost: true });
  await assert.rejects(sendCloudTask(task, turn, "test", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), e => e.uncertain && e.submission_status === "unknown" && e.attempt_id && !e.message.includes("private-marker"));
  assert.equal(f.calls.length, 1);
  await assert.rejects(sendCloudTask(task, turn, "test", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), { code: "CLOUD_DUPLICATE_SEND" });
  const final = await sendCloudTask(task, turn, "test", { expectedUserRevision: revision, deliveryMode: "new-turn" }, sendFixture({ failFinal: true }));
  assert.equal(final.submission_status, "accepted"); assert.equal(final.receipt_update_required, true);
});

test("pre-dispatch persistence failures submit nothing and restore a safely retryable reservation", async () => {
  for (const failureAt of [1, 2, 3]) {
    for (const prior of [null, { submission_status: "accepted", parent_turn_id: "older-turn", attempt_id: attempt }]) {
      const f = sendFixture(), persist = f.write; let writes = 0;
      if (prior) f.records.set(`cloud-send-heads/${task}`, prior);
      f.write = async (...args) => {
        if (++writes === failureAt) {
          if (failureAt === 3) await persist(...args); // Failure after atomic replacement.
          throw new Error("private-marker");
        }
        return persist(...args);
      };
      await assert.rejects(sendCloudTask(task, turn, "fixture", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), e => e.code === "CLOUD_PERSISTENCE_FAILED" && e.uncertain === false && e.submission_status === "not_sent" && !e.message.includes("private-marker"));
      assert.equal(f.calls.length, 0);
      if (prior) assert.deepEqual(f.records.get(`cloud-send-heads/${task}`), prior);
      assert.equal((await sendCloudTask(task, turn, "explicit retry", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f)).submission_status, "accepted");
      assert.equal(f.calls.length, 1);
    }
  }
});

test("a failed reservation rollback stays blocked and reports recovery instead of guessing it was cleared", async () => {
  const f = sendFixture(), persist = f.write; let writes = 0;
  f.write = async (...args) => {
    writes++;
    if (writes === 3) { await persist(...args); throw new Error("private-marker"); }
    if (writes === 4) throw new Error("private-marker");
    return persist(...args);
  };
  await assert.rejects(sendCloudTask(task, turn, "fixture", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), e => e.code === "CLOUD_PERSISTENCE_FAILED" && e.uncertain === false && e.reservation_cleanup_required && e.receipt_update_required);
  assert.equal(f.calls.length, 0);
  await assert.rejects(sendCloudTask(task, turn, "retry", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f), { code: "CLOUD_DUPLICATE_SEND" });
  assert.equal(f.calls.length, 0);
  const unsent = [...f.records.values()].find(value => value.dispatch_started === false);
  const restored = await reconcileCloudSend(unsent.attempt_id, { ...f, read: async () => assert.fail("persisted pre-dispatch proof requires no history guess") });
  assert.equal(restored.delivery_verification, "not_sent"); assert.equal(restored.retry_safe, true);
  assert.equal((await sendCloudTask(task, turn, "explicit retry", { expectedUserRevision: revision, deliveryMode: "new-turn" }, f)).submission_status, "accepted");
  assert.equal(f.calls.length, 1);
});

test("reconciliation matches parent and prompt digest, and not_observed never means safe to resend", async () => {
  const f = sendFixture();
  f.records.set(`cloud-messages/${attempt}`, { task_id: task, attempt_id: attempt, parent_turn_id: turn, submission_status: "unknown", prompt_hash_encoding: "utf8", prompt_sha256: hash("follow-up") });
  let result = await reconcileCloudSend(attempt, f);
  assert.equal(result.delivery_verification, "not_observed"); assert.equal(result.retry_safe, false);
  f.read = async () => ({ turns: [{ turn_id: `${task}~usertrn_fixture_2`, parent_turn_id: turn, role: "user", messages: [{ text: "follow-up" }] }] });
  result = await reconcileCloudSend(attempt, f);
  assert.equal(result.delivery_verification, "stored"); assert.equal(result.submission_status, "accepted");
});

test("attempt recovery validates its explicit task before reads or writes", async () => {
  const f = sendFixture();
  f.records.set(`cloud-messages/${attempt}`, { task_id: task, attempt_id: attempt, submission_status: "unknown" });
  f.read = async () => assert.fail("must not read another task");
  await assert.rejects(cloudSendReceipt(attempt, { ...f, taskId: "task_other" }), { code: "CLOUD_TARGET_CONFLICT" });
  await assert.rejects(reconcileCloudSend(attempt, { ...f, taskId: "task_other" }), { code: "CLOUD_TARGET_CONFLICT" });
  assert.equal(f.calls.length, 0);
});
