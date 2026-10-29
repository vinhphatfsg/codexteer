import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { desktopCloudId, desktopCloudUuid, desktopCloudLink } from "../src/desktop-cloud-id.mjs";
import { normalizeTaskId, taskConnection } from "../src/task-id.mjs";
import { cloudInvocation } from "../src/cloud-cli.mjs";
import { connectDesktopCloud, DesktopCloudClient, desktopCloudEnvironments, desktopCloudGet } from "../src/desktop-cloud-api.mjs";
import { createDesktopCloudTask, sendDesktopCloudInput, desktopCloudReceipt } from "../src/desktop-cloud.mjs";
import { RpcFailure } from "../src/rpc.mjs";
import { readSnapshot, fetchThread } from "../src/observe.mjs";
import { registerSupervisor, controlSupervisor, assertSupervisor, listSupervisors } from "../src/supervision.mjs";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", id = `durable_${uuid}`, config = "fixture~asenvcfg_example", turn = "fixture-turn";
async function profile(t) { const home = await mkdtemp(path.join(tmpdir(), "desktop-cloud-test-")); t.after(() => rm(home, { recursive: true, force: true })); return { home }; }
const metadata = () => ({ id, turns: [], status: { type: "idle" }, historyMode: "aggregate", environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config, cwd: "/workspace" }] });
const client = (calls, fail) => ({ close() {}, async request(method, params) {
  calls.push({ method, params });
  if (method === "thread/read") return { thread: metadata() };
  if (method === "model/list") return { data: [{ model: "fixture-default", isDefault: true }] };
  if (method === "thread/start") return { thread: { ...metadata(), id } };
  if (method === "thread/name/set") return {};
  if (method === "turn/start") { if (fail) throw fail(); return { turn: { id: turn } }; }
  throw Error(`unexpected ${method}`);
} });
test("durable identity cannot reach a local or Web Cloud backend and prompt text never selects it", () => {
  assert.equal(normalizeTaskId(desktopCloudLink(id)), id); assert.equal(desktopCloudUuid(id), uuid);
  assert.equal(taskConnection(id), "desktop-cloud"); assert.throws(() => desktopCloudId(desktopCloudLink(id) + "&hostId=local")); assert.throws(() => desktopCloudId(uuid)); assert.throws(() => taskConnection(id, "cloud")); assert.throws(() => taskConnection(uuid, "desktop-cloud"));
  assert(cloudInvocation(["read", desktopCloudLink(id)])); assert(!cloudInvocation(["send", uuid, desktopCloudLink(id)]));
  assert(!cloudInvocation(["thread", "create", "--project", "fixture", id])); assert(cloudInvocation(["--connection", "desktop-cloud", "environments", "list"]));
});
test("configuration catalog paginates both scopes and exposes no secrets or scripts", async () => {
  const calls = [];
  const result = await desktopCloudEnvironments({}, { get: async route => { calls.push(route); const q = new URL(route, "https://example.test").searchParams;
    return { data: q.get("scope") === "workspace" ? [] : [{ id: q.has("cursor") ? "next-config" : config, name: "Fixture", secrets: "DO_NOT_EXPOSE", install_script: "DO_NOT_EXPOSE" }], next_cursor: q.get("scope") === "user" && !q.has("cursor") ? "page-two" : null }; } });
  assert.equal(calls.length, 3); assert.equal(result.environments.length, 2); assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|secrets|install_script/);
  await assert.rejects(desktopCloudEnvironments({}, { get: async () => ({ data: [], next_cursor: "loop" }) }));
});
test("catalog auth is constrained to the service, rejects redirects, and erases the token", async () => {
  const auth = { token: "fixture-token", accountId: "fixture-account" };
  await assert.rejects(desktopCloudGet("https://example.test/v1/environment-configs", {}, { credentials: () => assert.fail("no auth for another origin") }));
  const result = await desktopCloudGet("/v1/environment-configs?scope=user", {}, { credentials: async () => auth, fetchRequest: async (url, options) => {
    assert.equal(url.origin, "https://codex-cloud-backend.chatgpt.com"); assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, "Bearer fixture-token"); return new Response('{"data":[]}');
  } }); assert.deepEqual(result, { data: [] }); assert.equal(auth.token, "");
});
test("bearer subprotocol exceptions are redacted and transport rejects redirects/compression", async () => {
  const auth = { token: "fixture-sensitive", accountId: "fixture" };
  class Socket { constructor(url, protocols, options) { assert.equal(options.followRedirects, false); assert.equal(options.perMessageDeflate, false); assert(protocols.includes("openai-bearer.fixture-sensitive")); throw Error("openai-bearer.fixture-sensitive"); } }
  await assert.rejects(connectDesktopCloud({}, { credentials: async () => auth, Socket }), error => error.code === "CONNECTION_FAILED" && !error.message.includes("fixture-sensitive")); assert.equal(auth.token, "");
});
test("Cloud history does not require backwards bookmarks and shares aggregate cursors", async () => {
  const calls = []; let pages = 0;
  const rpc = { close() {}, async request(method, params) { calls.push({ method, params });
    if (method === "thread/read") return { thread: { ...metadata(), id: uuid } };
    if (method === "thread/turns/list") return { data: [{ id: `turn-${++pages}`, status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: `item-${pages}`, text: "ok" }] }], nextCursor: pages === 1 ? "next" : null, backwardsCursor: null };
  } };
  const c = new DesktopCloudClient(rpc), snapshot = readSnapshot(await fetchThread(c, id));
  assert.equal(snapshot.events.filter(event => event.type === "agentMessage").length, 2); assert(calls.every(call => !call.params.threadId || call.params.threadId === uuid)); assert.equal(snapshot.has_more, false);
  const old = snapshot.cursor; assert.equal(readSnapshot({ ...metadata(), turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "item-1", text: "ok" }] }, { id: "turn-2", status: "completed", items: [{ type: "agentMessage", id: "item-2", text: "ok" }] }] }, { since: old }).changed, false);
});
test("internal mutation errors stay unknown but invalid parameter rejection is not sent", async () => {
  for (const code of [-32603, -32602]) {
    const c = new DesktopCloudClient({ request: async () => { throw new RpcFailure("rejected", { rpcCode: code, code: "RPC_REJECTED" }); } });
    await assert.rejects(c.request("turn/start", { threadId: id }, { mutation: true }), e => e.uncertain === (code === -32603));
  }
});
test("creation keeps environment binding and default model and never claims project membership", async t => {
  const storage = await profile(t), calls = [];
  const deps = { ...storage, environments: async () => ({ environments: [{ id: config, name: "Fixture" }] }), connect: async () => client(calls) };
  await assert.rejects(createDesktopCloudTask(config, "test", { project: "local-fixture" }, { connect: () => assert.fail("no connection"), environments: () => assert.fail("no auth") }), { code: "DESKTOP_CLOUD_PROJECT_UNAVAILABLE" });
  const result = await createDesktopCloudTask(config, "read-only verification", { title: "Fixture" }, deps);
  assert.equal(result.project_membership, "not_requested"); assert.equal(result.delivery_status, "accepted"); assert.equal(result.thread_id, id);
  const start = calls.find(c => c.method === "thread/start").params, send = calls.find(c => c.method === "turn/start").params;
  assert.equal(start.model, "fixture-default"); assert.equal(start.environments[0].environmentConfigId, config); assert.equal(send.environments[0].environmentConfigId, config); assert.equal(send.deferredEnvironment, true); assert(!("projectId" in start)); assert(!("sandbox" in start));
  assert.equal((await desktopCloudReceipt(result.attempt_id, storage)).turn_id, turn);
});
test("unknown delivery survives exit, blocks subsequent sends, and creation retains the target", async t => {
  const storage = await profile(t), calls = [];
  const deps = { ...storage, connect: async () => client(calls, () => Object.assign(new Error("unknown"), { uncertain: true })) };
  await assert.rejects(createDesktopCloudTask(config, "test", {}, { ...deps, environments: async () => ({ environments: [{ id: config, name: "Fixture" }] }) }), error => error.thread_id === id && error.creation_status === "created" && error.delivery_status === "unknown");
  await assert.rejects(sendDesktopCloudInput(id, "different text", { newTurn: true }, { ...storage, connect: () => assert.fail("must not reconnect/resend") }), { code: "DESKTOP_CLOUD_DELIVERY_PENDING" });
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
});
test("common supervisor pause/stop and backend separation apply to durable tasks", async t => {
  const storage = await profile(t), session = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
  await registerSupervisor(id, session, { ...storage, connection: "desktop-cloud" });
  assert.equal((await listSupervisors(storage))[0].thread_id, id);
  await controlSupervisor(id, "pause", storage);
  await assertSupervisor(id, session, { ...storage, connection: "desktop-cloud" });
  await assert.rejects(assertSupervisor(id, session, { ...storage, sending: true, connection: "desktop-cloud" }), { code: "SUPERVISOR_PAUSED" });
  await assert.rejects(assertSupervisor(id, session, { ...storage, connection: "shared" }), { code: "SUPERVISOR_MISMATCH" });
  await controlSupervisor(id, "stop", storage); await assert.rejects(assertSupervisor(id, session, storage), { code: "SUPERVISOR_STOPPED" });
});

test("supervisor prompts retain Cloud scope without Web interrupt semantics", async () => {
  const { prepareSupervisorPrompt } = await import("../src/supervise.mjs");
  const result = await prepareSupervisorPrompt(id, "Observe only", { connection: "desktop-cloud", usePathCli: true });
  assert.match(result.prompt, /--connection desktop-cloud/); assert.match(result.prompt, /対象はDesktop Cloud/); assert.doesNotMatch(result.prompt, /Cloudの通常sendは、実行中の指定ターンを中断/);
});

test("history reconciles an accepted message among several users in the same turn but never guesses an unknown turn", async t => {
  const { writeRecord, readRecord } = await import("../src/store.mjs"), { reconcileMessages } = await import("../src/journal.mjs"), { digest } = await import("../src/observe.mjs");
  const storage = await profile(t), messageId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";
  const entry = { schema: 1, id: messageId, client_message_id: messageId, thread_id: id, delivery_status: "accepted", turn_id: turn, wire_text: "intended", message_sha256: digest("intended") };
  await writeRecord("messages", messageId, entry, storage);
  const thread = { ...metadata(), turns: [{ id: turn, status: "completed", items: ["original", "intended"].map((text, i) => ({ type: "userMessage", id: `item-${i}`, clientId: null, content: [{ type: "text", text }] })) }] };
  const deps = { discover: async () => ({ paths: { socket: "fixture" }, state: { codex_steer_protocol: 1 } }), connect: async () => ({ request: async () => ({ thread }), close() {} }) };
  const result = await reconcileMessages(id, messageId, storage, deps); assert.equal(result[0].verification.status, "stored");
  await writeRecord("messages", messageId, { ...entry, delivery_status: "unknown", turn_id: undefined }, storage);
  const unknown = await reconcileMessages(id, messageId, storage, deps); assert.equal(unknown[0].verification.status, "not_observed"); assert.equal((await readRecord("messages", messageId, storage)).delivery_status, "unknown");
});
