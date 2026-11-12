import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { cloudConnection } from "../src/cloud-connection.mjs";
import { observeThread, readSnapshot } from "../src/observe.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject, continueProjectSync } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { sendDesktopCloudInput } from "../src/desktop-cloud.mjs";
import { orchestrationPrompt } from "../src/orchestrate-prompt.mjs";
import { helpData } from "../src/help.mjs";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000031", ID = `durable_${uuid}`, ENV = "fixture~asenvcfg_coverage", PROJECT = "coverage";
const LOCAL = "11111111-1111-4111-8111-000000000031", WEB = "task_fixture_coverage";
const UNOBSERVED = "running_turn_unobserved";
const row = (result, id) => result.works.find(work => work.thread_id === id);
const order = { id: "order", type: "userMessage", content: [{ type: "text", text: "Report a focused result." }] };

// A scripted Desktop Cloud backend. While its turn runs it shows what the
// service shows: the turn, the opening message and empty flags.
async function fixture(t, { name = "worker" } = {}) {
  const home = await mkdtemp(tempPrefix("ct-coverage-")); t.after(() => rm(home, { recursive: true, force: true }));
  const state = { status: "active", flags: [], turns: [{ id: "turn-0", status: "inProgress", items: [order] }], calls: [] };
  const rpc = { close() {}, async request(method, params) {
    state.calls.push(method);
    if (method === "thread/read") return { thread: { id: uuid, name, status: { type: state.status, activeFlags: state.flags },
      environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: ENV }] } };
    if (method === "thread/turns/list") return { data: state.turns.map(turn => ({ ...turn, itemsView: "full" })), nextCursor: null };
    if (method === "turn/steer") { state.turns.at(-1).items.push({ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input }); return { turnId: state.turns.at(-1).id }; }
    if (method === "turn/start") { state.turns.push({ id: `turn-${state.turns.length}`, status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] }); return { turn: { id: state.turns.at(-1).id } }; }
    throw new Error(`Unexpected ${method}`);
  } };
  const storage = { home }, connect = async () => new DesktopCloudClient(rpc);
  const read = (id, options) => observeThread(id, options, { connect });
  await registerManagedThread(ID, { projectId: PROJECT, connection: "desktop-cloud", environmentConfigId: ENV }, storage);
  await registerSupervisor(ID, randomUUID(), { ...storage, connection: "desktop-cloud" });
  const dependencies = { storage, read, pollMs: 5, processIdentity: async () => "same-start" };
  const finish = (items = [{ id: "report", type: "agentMessage", text: "Done." }], status = "idle") => {
    state.turns.at(-1).items.push(...items); state.turns.at(-1).status = "completed"; state.status = status;
  };
  return { state, storage, read, connect, dependencies, finish, sync: (options = {}) => syncProject(PROJECT, options, dependencies),
    wait: () => waitProject(PROJECT, { timeoutMs: 0 }, dependencies) };
}

test("a Desktop Cloud member whose turn runs says its attention is unobserved in sync, and its attention value is unchanged", async t => {
  const f = await fixture(t), result = await f.sync(), work = row(result, ID);
  assert.equal(work.attention_coverage, UNOBSERVED);
  assert.equal(work.attention, "none"); assert.equal(work.execution, "active"); assert.equal(work.group, "動作中"); assert.equal(work.complete, true);
  assert.deepEqual(result.attention_unobserved, [{ thread_id: ID, attention_coverage: UNOBSERVED }]);
  const again = await continueProjectSync(result.sync_token, {}, f.storage);
  assert.deepEqual(again.attention_unobserved, result.attention_unobserved, "a continuation page of the same result repeats the list");
  assert.equal(row(again, ID).attention_coverage, UNOBSERVED);
});

test("a row too large for the byte budget keeps the mark in its compact form", async t => {
  const f = await fixture(t, { name: "w".repeat(6000) }), result = await f.sync({ byteBudget: 4096 }), work = row(result, ID);
  assert.equal(work.details_omitted, true); assert.equal(work.attention_coverage, UNOBSERVED);
  assert.ok(result.output_bytes <= 4096, "the list of unobserved members is outside the measured envelope");
  assert.deepEqual(result.attention_unobserved, [{ thread_id: ID, attention_coverage: UNOBSERVED }]);
});

test("every wait return names the members whose running turn it could not observe", async t => {
  const f = await fixture(t), first = await f.wait();
  assert.equal(first.reason, "initial_sync");
  assert.deepEqual(first.attention_unobserved, [{ thread_id: ID, attention_coverage: UNOBSERVED }]);
  assert.deepEqual(first.sync.attention_unobserved, first.attention_unobserved); assert.equal(row(first.sync, ID).attention_coverage, UNOBSERVED);
  const quiet = await f.wait();
  assert.equal(quiet.timed_out, true); assert.equal(quiet.sync, null); assert.deepEqual(quiet.unreadable, []);
  assert.deepEqual(quiet.attention_unobserved, [{ thread_id: ID, attention_coverage: UNOBSERVED }]);
});

test("a question asked during the turn is returned by wait when the turn ends, and the mark is gone", async t => {
  const f = await fixture(t); await f.wait();
  f.finish([{ id: "ask", type: "agentMessage", text: "Which one?", questions: ["A or B?"] }]);
  const ended = await f.wait(), work = row(ended.sync, ID);
  assert.equal(ended.reason, "work_changed"); assert.equal(work.attention, "human"); assert.equal(work.attention_coverage, undefined);
  assert.equal(ended.attention_unobserved, undefined); assert.equal(ended.sync.attention_unobserved, undefined);
});

test("status and read carry the mark only while the Desktop Cloud turn runs", async t => {
  const f = await fixture(t), running = await f.read(ID, { connection: "desktop-cloud" });
  assert.equal(running.attention_coverage, UNOBSERVED); assert.deepEqual(running.attention, []); assert.equal(running.status, "active");
  const since = await f.read(ID, { connection: "desktop-cloud", since: running.cursor });
  assert.equal(since.attention_coverage, UNOBSERVED); assert.equal(since.changed, false, "the mark is not part of the observed state");
  f.finish();
  const idle = await f.read(ID, { connection: "desktop-cloud", since: running.cursor });
  assert.equal(idle.attention_coverage, undefined); assert.ok(idle.events.some(event => event.id === "report"));
});

test("an idle and a settled Desktop Cloud member carry no mark", async t => {
  const f = await fixture(t); f.finish();
  const idle = await f.sync();
  assert.equal(row(idle, ID).attention_coverage, undefined); assert.equal(idle.attention_unobserved, undefined);
  await controlSupervisor(ID, "stop", f.storage);
  const settling = await f.sync(), settled = await f.sync();
  assert.equal(row(settling, ID).settled.basis, "observed"); assert.equal(row(settled, ID).observation, "settled");
  for (const result of [settling, settled]) { assert.equal(row(result, ID).attention_coverage, undefined); assert.equal(result.attention_unobserved, undefined); }
});

test("a shared member and a Web Cloud member with a running turn carry no mark", async t => {
  const home = await mkdtemp(tempPrefix("ct-coverage-other-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, local = { id: LOCAL, name: "local", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-local", status: "inProgress", items: [order] }] };
  const web = cloudConnection({ read: async () => ({ task_id: WEB, title: "web", status: "in_progress", turn_id: `${WEB}~assttrn_a`, current_turn_id: `${WEB}~assttrn_a`,
    turns: [{ turn_id: `${WEB}~usertrn_a`, role: "user", status: null, commands: [], progress: [], messages: [{ text: "order" }] },
      { turn_id: `${WEB}~assttrn_a`, role: "assistant", status: "in_progress", commands: [], progress: [], messages: [] }] }) });
  await registerManagedThread(LOCAL, { projectId: PROJECT, connection: "shared" }, storage);
  await registerManagedThread(WEB, { projectId: PROJECT, connection: "cloud" }, storage);
  const read = (id, options) => id === WEB ? observeThread(id, options, web) : Promise.resolve(readSnapshot(local, options));
  const result = await syncProject(PROJECT, {}, { storage, read });
  assert.equal(result.complete, true); assert.equal(result.attention_unobserved, undefined);
  for (const id of [LOCAL, WEB]) { assert.equal(row(result, id).execution, "active"); assert.equal(row(result, id).attention_coverage, undefined); }
  assert.equal((await observeThread(WEB, { connection: "cloud" }, web)).attention_coverage, undefined);
  const waited = await waitProject(PROJECT, { timeoutMs: 0 }, { storage, read, pollMs: 5, processIdentity: async () => "same-start" });
  assert.equal(waited.attention_unobserved, undefined);
});

test("work tell to a running Desktop Cloud turn still sends, and its receipt says pending questions were not observable", async t => {
  const f = await fixture(t); await f.sync();
  const send = (id, wire, options) => sendDesktopCloudInput(id, wire, options, { ...f.storage, connect: f.connect });
  const steered = await tellWork(ID, "Review the existing result.", {}, { storage: f.storage, read: f.read, send });
  assert.equal(steered.delivery_status, "accepted"); assert.equal(f.state.calls.filter(method => method === "turn/steer").length, 1);
  assert.equal(steered.attention_coverage, UNOBSERVED);
  f.finish(); await f.sync();
  const continued = await tellWork(ID, "Continue the same delegation.", { newTurn: true }, { storage: f.storage, read: f.read, send });
  assert.equal(continued.delivery_status, "accepted"); assert.equal(continued.attention_coverage, undefined, "an idle target was observed in full");
});

test("the orchestrator prompt and help say what a running Desktop Cloud turn hides", () => {
  for (const cloudCommand of [null, "prepared-cloud --connection desktop-cloud"]) {
    const { prompt } = orchestrationPrompt("P", "goal", "prepared-command --connection shared", { cloudCommand });
    assert.match(prompt, /attention_coverage:running_turn_unobserved/); assert.match(prompt, /attention_unobserved/);
    assert.match(prompt, /「待っているものはない」とユーザーへ伝えず、codexteerは実行中のDesktop Cloudターンを観測できないことと、Codexの画面で確認が必要なことを伝えます/);
    assert.match(prompt, /ターン中に出た質問は、ターンが終わるとwaitが返します/);
    assert.doesNotMatch(prompt, /Desktop Cloudの質問は(?:見え|観測でき)ません/);
  }
  for (const name of ["status", "read", "project", "work", "desktop-cloud"]) {
    const topic = helpData(name), text = [topic.returns, ...topic.notes].join(" ");
    assert.match(text, /attention_coverage/, name); assert.match(text, /running_turn_unobserved/, name);
  }
  assert.match(helpData("project").returns, /attention_unobserved/);
  assert.match(helpData("project").notes.join(" "), /ターンが終わった後の質問は従来どおり返す/);
  assert.match(helpData("desktop-cloud").returns, /running_turn_attention:unobserved/);
  assert.match(helpData("desktop-cloud").notes.join(" "), /ターンが終わると、その間の発言・コマンド・質問がまとめて現れる/);
});
