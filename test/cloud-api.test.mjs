import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { cloudCredentials, cloudApi, cloudEnvironments } from "../src/cloud-api.mjs";
import { readCloudTask, watchCloudTask, sendCloudTask, reconcileCloudSend } from "../src/cloud-observe.mjs";

const task = "task_fixture_cloud", turn = `${task}~assttrn_fixture_1`, user = `${task}~usertrn_fixture_1`;
const cursor = `cloud_v1:${"a".repeat(64)}`, attempt = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const observation = { task_id: task, turn_id: turn, cursor, status: "completed", turns: [] };
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
  assert.equal((await readCloudTask(task, { since: value.cursor }, f)).changed, false);
  f.history.current_turn_id = user;
  await assert.rejects(readCloudTask(task, {}, f), { code: "CLOUD_STATE_CHANGED" });
  f.history.current_turn_id = turn; f.history.turn_mapping[user].turn.id = "task_other~usertrn_fixture";
  await assert.rejects(readCloudTask(task, {}, f), { code: "CLOUD_PROTOCOL_UNVERIFIED" });
});

function sendFixture({ status = "completed", failPost = false, failFinal = false } = {}) {
  const records = new Map(), calls = [];
  return { records, calls, read: async () => ({ ...observation, status }), lock: async (key, run) => run(), load: async (bucket, id) => records.get(`${bucket}/${id}`) ?? null,
    write: async (bucket, id, value) => { if (failFinal && value.submission_status === "accepted") throw new Error("private-marker"); records.set(`${bucket}/${id}`, structuredClone(value)); },
    request: async (route, settings) => { calls.push({ route, settings }); if (failPost) throw new Error("private-marker"); return { task: { id: task } }; },
  };
}

test("follow-up is one POST bound to observed task, exact parent turn, cursor and stdin text", async () => {
  const f = sendFixture(), prompt = "日本語\n$(no-shell)";
  const value = await sendCloudTask(task, turn, prompt, { basedOn: cursor }, f);
  assert.equal(value.submission_status, "accepted"); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].settings.body.follow_up, { task_id: task, turn_id: turn, environment_mode: "code" });
  assert.equal(f.calls[0].settings.body.input_items[0].content[0].text, prompt);
  assert.doesNotMatch(JSON.stringify([...f.records.values()]), /日本語|no-shell/);
  await assert.rejects(sendCloudTask(task, turn, prompt, { basedOn: cursor }, f), { code: "CLOUD_DUPLICATE_SEND" });
  assert.equal(f.calls.length, 1);
});

test("stale cursor, cross-task turn, busy task and dry run never submit follow-up", async () => {
  const f = sendFixture();
  await assert.rejects(sendCloudTask(task, "task_other~assttrn_fixture", "test", { basedOn: cursor }, f), { code: "CLOUD_OPTIONS_INVALID" });
  await assert.rejects(sendCloudTask(task, turn, "test", { basedOn: `cloud_v1:${"b".repeat(64)}` }, f), { code: "CLOUD_STATE_CHANGED" });
  await assert.rejects(sendCloudTask(task, turn, "test", { basedOn: cursor }, sendFixture({ status: "in_progress" })), { code: "CLOUD_TASK_BUSY" });
  assert.equal((await sendCloudTask(task, turn, "test", { basedOn: cursor, dryRun: true }, f)).submission_status, "not_sent");
  assert.equal(f.calls.length, 0); assert.equal(f.records.size, 0);
});

test("unknown follow-up is never retried, blocks another send and retains private recovery receipt", async () => {
  const f = sendFixture({ failPost: true });
  await assert.rejects(sendCloudTask(task, turn, "test", { basedOn: cursor }, f), e => e.uncertain && e.submission_status === "unknown" && e.attempt_id && !e.message.includes("private-marker"));
  assert.equal(f.calls.length, 1);
  await assert.rejects(sendCloudTask(task, turn, "test", { basedOn: cursor }, f), { code: "CLOUD_DUPLICATE_SEND" });
  const final = await sendCloudTask(task, turn, "test", { basedOn: cursor }, sendFixture({ failFinal: true }));
  assert.equal(final.submission_status, "accepted"); assert.equal(final.receipt_update_required, true);
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

test("cloud watch emits changes, polls without sending, and ends at its deadline", async () => {
  let clock = 0, reads = 0; const events = [];
  const dependencies = { now: () => clock, sleep: async n => { clock += n; }, read: async (id, s) => { reads++;return { ...observation, changed: reads === 2, cursor: s.since }; }, emit: e => events.push(e) };
  const value = await watchCloudTask(task, { timeoutMs: 3000, intervalMs: 1000, since: cursor }, dependencies);
  assert.equal(value.timed_out, false); assert.equal(reads, 2); assert.equal(events.length, 1);
  reads = 0; clock = 0; events.length = 0;
  const end = await watchCloudTask(task, { timeoutMs: 3000, intervalMs: 1000, since: cursor, stream: true }, dependencies);
  assert.equal(end.timed_out, true); assert.equal(events.length, 1);
});

test("CLI environment/read/send and non-JSON watch stream work offline with isolated official-process and HTTP fixtures", async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const root = await mkdtemp("/private/tmp/codexteer-cloud-api-cli-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = `${root}/home`, bin = `${root}/bin`, preload = `${root}/fixture.mjs`;
  await mkdir(home, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  await writeFile(`${bin}/codex`, `#!${process.execPath}
let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{pending+=s;let i;while((i=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{authMethod:'chatgpt',authToken:${JSON.stringify(token)}}}));}});`, { mode: 0o700 });
  const f = fixtureHistory();
  await writeFile(preload, `const details=${JSON.stringify(f.details)},history=${JSON.stringify(f.history)};
globalThis.fetch=async(url,options)=>{if(!url.startsWith('https://chatgpt.com/backend-api/wham/'))throw new Error('unexpected endpoint');const value=options.method==='POST'?{task:{id:${JSON.stringify(task)}}}:url.endsWith('/environments')?[{id:'env_fixture',label:'fixture/example'}]:url.endsWith('/turns')?history:details;return new Response(JSON.stringify(value),{status:200});};`);
  const invoke = args => new Promise((resolve, reject) => execFile(process.execPath, ["--import", preload, "bin/codexteer.mjs", ...args], {
    env: { ...process.env, PATH: bin, HOME: home, CODEX_HOME: home }, timeout: 15000,
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
  const environments = JSON.parse(await invoke(["cloud", "environments", "list", "--json"]));
  assert.equal(environments.data.environments[0].id, "env_fixture");
  const read = JSON.parse(await invoke(["cloud", "read", task, "--json"])).data;
  const sent = JSON.parse(await invoke(["cloud", "send", task, "--turn", read.turn_id, "--based-on", read.cursor, "fixture follow-up", "--json"])).data;
  assert.equal(sent.submission_status, "accepted");
  assert.equal(JSON.parse(await invoke(["cloud", "receipt", sent.attempt_id, "--json"])).data.task_id, task);
  const stream = await invoke(["cloud", "watch", task, "--stream", "--timeout-ms", "2000", "--interval-ms", "1000"]);
  const rows = stream.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2); assert.equal(rows[0].data.changed, true); assert.equal(rows.at(-1).data.timed_out, true);
});
