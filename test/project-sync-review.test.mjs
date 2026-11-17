import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { completedCloudThread } from "../test-support/fixtures/desktop-cloud-completed.mjs";
import { readSnapshot, fetchThread } from "../src/observe.mjs";
import { cloudThread } from "../src/cloud-connection.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { sendDesktopCloudInput } from "../src/desktop-cloud.mjs";
import { sendOnClient } from "../src/app-server.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { tellWork } from "../src/work-tell.mjs";

async function fixture(t, connection = "shared") {
  const home = await mkdtemp(tempPrefix("ct-review-")); t.after(() => rm(home, { recursive: true, force: true }));
  const thread = completedCloudThread();
  if (connection === "shared") { thread.id = thread.id.slice(8); delete thread.environments; }
  thread.historyMode = "aggregate";
  const storage = { home }, calls = [];
  const raw = { close() {}, async request(method, params, options) {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { ...structuredClone(thread), id: connection === "desktop-cloud" ? thread.id.slice(8) : thread.id } };
    if (method === "thread/turns/list") { const turns = thread.turns.map(turn => ({ ...structuredClone(turn), itemsView: "full" })); return { data: params.sortDirection === "desc" ? turns.reverse().slice(0, params.limit) : turns, nextCursor: null }; }
    if (method === "thread/items/list") return { data: structuredClone(thread.turns.find(turn => turn.id === params.turnId).items).map(item => ({ turnId: params.turnId, item })), nextCursor: null };
    if (method === "turn/start") {
      assert.equal(options.mutation, true);
      const id = thread.turns.some(turn => turn.id === "next-turn") ? `next-turn-${thread.turns.length}` : "next-turn";
      thread.turns.push({ id, status: "inProgress", items: [{ id: "next-input", type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] });
      thread.status = { type: "active", activeFlags: [] };
      return { turn: { id } };
    }
    if (method === "turn/steer") {
      assert.equal(options.mutation, true); assert.equal(params.expectedTurnId, thread.turns.at(-1).id);
      thread.turns.at(-1).items.push({ id: `steer-${calls.length}`, type: "userMessage", clientId: params.clientUserMessageId, content: params.input });
      return { turnId: params.expectedTurnId };
    }
    assert.fail(`Unexpected operation ${method}`);
  } };
  const connect = async () => connection === "desktop-cloud" ? new DesktopCloudClient(raw) : raw;
  const read = async (id, options) => readSnapshot(await fetchThread(await connect(), id), options);
  await registerManagedThread(thread.id, { projectId: "review", connection,
    ...(connection === "desktop-cloud" ? { environmentConfigId: "fixture-config" } : {}), syncCursor: readSnapshot(thread).cursor }, storage);
  await registerSupervisor(thread.id, "22222222-2222-4222-8222-000000000007", { ...storage, connection });
  const send = async (id, text, options) => connection === "desktop-cloud" ? sendDesktopCloudInput(id, text, options, { ...storage, connect })
    : { ...await sendOnClient(raw, id, text, { ...options, subscribe: async target => assert.equal(target, id) }), sent: true, delivery_status: "accepted" };
  return { storage, read, thread, calls, send };
}

for (const connection of ["shared", "desktop-cloud"]) test(`${connection}: empty-delta review -> explicit new turn -> active, without recreating the worker`, async t => {
  const f = await fixture(t, connection);
  const result = await syncProject("review", {}, f), work = result.works[0];
  assert.equal(result.complete, true); assert.equal(work.events.length, 0, "completion does not depend on redisplaying an old turn event");
  assert.equal(work.execution, "idle"); assert.equal(work.attention, "review"); assert.equal(work.group, "検収待ち");
  assert.equal(work.reason.review_basis, "idle_after_completed_turn"); assert.equal(work.reason.latest_turn_id, "turn-fixture");
  assert.equal((await syncProject("review", {}, f)).works[0].attention, "review", "review persists on a later empty delta");
  const receipt = await tellWork(f.thread.id, "Address the remaining verification.", { newTurn: true }, f);
  assert.equal(receipt.delivery_status, "accepted");
  await assert.rejects(tellWork(f.thread.id, "Do not replay the start.", { newTurn: true }, f), { code: "WORK_TELL_NEW_TURN_INVALID" }, "the turn it started is running");
  const active = (await syncProject("review", {}, f)).works[0];
  assert.equal(active.execution, "active"); assert.equal(active.attention, "none"); assert.equal(active.group, "動作中");
  assert.equal(active.turn_identity, "next-turn");
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 1); assert.ok(f.calls.every(c => c.method !== "thread/start"));
  f.thread.turns.at(-1).status = "completed"; f.thread.status.type = "idle";
  assert.equal((await syncProject("review", {}, f)).works[0].group, "検収待ち");
});

const mutations = f => f.calls.filter(c => ["turn/start", "turn/steer"].includes(c.method)).map(c => c.method);
const endTurn = f => { f.thread.turns.at(-1).status = "completed"; f.thread.turns.at(-1).items.push({ id: "next-report", type: "agentMessage", text: "Finished." }); f.thread.status = { type: "idle", activeFlags: [] }; };
// The transport's own read is the first to see the change.
const changedBeforeSend = (f, change) => { let pending = true; return { ...f, send: (...args) => { if (pending) { pending = false; change(); } return f.send(...args); } }; };

for (const connection of ["shared", "desktop-cloud"]) test(`${connection}: work tell without --new-turn starts a new turn on a reviewed idle member and steers a running one`, async t => {
  const f = await fixture(t, connection);
  assert.equal((await syncProject("review", {}, f)).works[0].execution, "idle");
  const started = await tellWork(f.thread.id, "Address the remaining verification.", {}, f);
  assert.deepEqual([started.delivery_status, started.delivery_action, started.delivery_action_source, mutations(f)], ["accepted", "new-turn", "auto", ["turn/start"]]);
  assert.equal((await syncProject("review", {}, f)).works[0].execution, "active");
  const steered = await tellWork(f.thread.id, "Also run the linter.", {}, f);
  assert.deepEqual([steered.delivery_status, steered.delivery_action, steered.delivery_action_source, mutations(f)], ["accepted", "steer", "auto", ["turn/start", "turn/steer"]]);
});

// The service lists codexteer's messages without the client id it sent.
const dropClientIds = f => { for (const item of f.thread.turns.flatMap(turn => turn.items)) if (item.type === "userMessage") item.clientId = null; };

for (const connection of ["shared", "desktop-cloud"]) test(`${connection}: a turn that ends between the check and the send gets the instruction once, as a new turn`, async t => {
  const f = await fixture(t, connection);
  await syncProject("review", {}, f); await tellWork(f.thread.id, "Start the follow-up.", {}, f);
  assert.equal((await syncProject("review", {}, f)).works[0].execution, "active");
  const receipt = await tellWork(f.thread.id, "Steer the follow-up.", {}, changedBeforeSend(f, () => endTurn(f)));
  assert.deepEqual([receipt.retried_from?.delivery_action, receipt.retried_from?.code, receipt.delivery_action, receipt.delivery_status], ["steer", connection === "shared" ? "TASK_IDLE" : "STALE_OBSERVATION", "new-turn", "accepted"]);
  assert.deepEqual(mutations(f), ["turn/start", "turn/start"], "the steer was not dispatched; the new turn was, once");
  assert.equal(receipt.unseen_since_basis.latest_agent_message.text, "Finished.", "the report the worker made meanwhile is returned for review");
});

for (const connection of ["shared", "desktop-cloud"]) test(`${connection}: a follow-up right after a delivered tell is steered without another sync, and progress since the sync does not stop it`, async t => {
  const f = await fixture(t, connection);
  await syncProject("review", {}, f);
  assert.equal((await tellWork(f.thread.id, "Address the remaining verification.", {}, f)).delivery_action, "new-turn");
  dropClientIds(f); f.thread.turns.at(-1).items.push({ id: "worker-note", type: "agentMessage", text: "Looking at the verification." });
  const followUp = await tellWork(f.thread.id, "Also keep the public API unchanged.", {}, f);
  assert.deepEqual([followUp.delivery_status, followUp.delivery_action, mutations(f)], ["accepted", "steer", ["turn/start", "turn/steer"]]);
  dropClientIds(f);
  assert.equal((await tellWork(f.thread.id, "And update the changelog.", {}, f)).delivery_status, "accepted", "a third, with both earlier tells unreviewed");
});

const startTurn = f => { f.thread.turns.push({ id: "someone-else", status: "inProgress", items: [{ id: "other-input", type: "userMessage", content: [{ type: "text", text: "Another request." }] }] }); f.thread.status = { type: "active", activeFlags: [] }; };

for (const connection of ["shared", "desktop-cloud"]) test(`${connection}: a turn someone else starts between the check and the send is not steered`, async t => {
  const f = await fixture(t, connection);
  assert.equal((await syncProject("review", {}, f)).works[0].execution, "idle");
  const error = await tellWork(f.thread.id, "Continue the verification.", {}, changedBeforeSend(f, () => startTurn(f))).then(() => assert.fail("sent"), error => error);
  assert.deepEqual([error.retried_from?.delivery_action, error.delivery_action, error.code, error.delivery_status], ["new-turn", "steer", "WORK_TELL_FOREIGN_INPUT", "not_sent"]);
  assert.deepEqual(mutations(f), [], "the other request's turn was neither steered nor joined by a new turn");
});

test("shared: a thread status that still said active when the reviewed turn had ended is retried as a new turn and delivered", async t => {
  const f = await fixture(t, "shared");
  f.thread.status = { type: "active", activeFlags: [] };
  const row = (await syncProject("review", {}, f)).works[0];
  assert.equal(row.execution, "active", "the row follows the thread status, so the tell chooses a steer");
  const receipt = await tellWork(f.thread.id, "Address the remaining verification.", {}, changedBeforeSend(f, () => { f.thread.status = { type: "idle", activeFlags: [] }; }));
  assert.deepEqual([receipt.delivery_status, receipt.delivery_action, receipt.retried_from?.delivery_action, receipt.retried_from?.code], ["accepted", "new-turn", "steer", "TASK_IDLE"]);
  assert.deepEqual(mutations(f), ["turn/start"]);
});

test("initial idle, pending start, unknown/missing turn evidence, unknown attention and contradictory running turns are not review", async t => {
  for (const kind of ["initial", "pending", "missing", "unknown-status", "flags", "active-conflict", "notLoaded", "incomplete"]) {
    const f = await fixture(t);
    if (kind === "initial") f.thread.turns = [];
    if (kind === "pending") f.thread.turns.at(-1).status = "pending";
    if (kind === "unknown-status") delete f.thread.turns.at(-1).status;
    if (kind === "flags") f.thread.status.activeFlags = null;
    if (kind === "active-conflict") f.thread.turns.unshift({ id: "unfinished", status: "inProgress", items: [] });
    if (kind === "notLoaded") f.thread.status.type = "notLoaded";
    // Start from the current snapshot so this test isolates metadata, not a stale cursor.
    const read = async (_id, options) => {
      if (kind === "incomplete") throw Object.assign(new Error("missing"), { code: "THREAD_NOT_FOUND" });
      const page = readSnapshot(f.thread, { ...options, since: undefined });
      if (kind === "missing") { delete page.latest_turn_id; delete page.latest_turn_status; delete page.active_turn_count; }
      // The same cursor may recur only on an empty final page.
      return { ...page, events: [] };
    };
    const result = await syncProject("review", {}, { storage: f.storage, read });
    assert.equal(result.works[0].attention, "unknown", kind); assert.equal(result.works[0].group, "未確認", kind);
  }
});

test("known approvals and unresolved questions outrank completed-turn review", async t => {
  for (const kind of ["approval", "question"]) {
    const f = await fixture(t);
    if (kind === "approval") f.thread.status.activeFlags = ["waitingOnApproval"];
    else f.thread.turns.at(-1).items.push({ id: "question", type: "agentMessage", text: "Which?", questions: ["A or B?"] });
    let first = true;
    const read = async (_id, options) => { const page = readSnapshot(f.thread, { ...options, ...(first ? { since: undefined } : {}) }); first = false; return page; };
    const result = await syncProject("review", {}, { storage: f.storage, read });
    assert.equal(result.works[0].attention, "human"); assert.equal(result.works[0].group, "対応が必要");
    await assert.rejects(tellWork(f.thread.id, "No proxy answer", { newTurn: true }, { ...f, read }), { code: "WORK_TELL_HUMAN_REQUIRED" });
  }
});

test("legacy Cloud completion cannot prove human attention is clear, including a synthetic completed user turn", async t => {
  for (const role of ["assistant", "user"]) {
    const home = await mkdtemp(tempPrefix("ct-legacy-review-")); t.after(() => rm(home, { recursive: true, force: true }));
    const task = "task_fixture_review", turn = `${task}~${role === "assistant" ? "assttrn" : "usertrn"}_one`;
    const snapshot = { task_id: task, title: "fixture", status: "completed", turn_id: turn, current_turn_id: turn,
      turns: [{ turn_id: turn, role, status: "completed", commands: [], messages: [{ text: "result" }], progress: [] }] };
    const thread = cloudThread(snapshot), storage = { home };
    await registerManagedThread(task, { projectId: "legacy", connection: "cloud", syncCursor: readSnapshot(thread).cursor }, storage);
    const result = await syncProject("legacy", {}, { storage, read: async (_id, options) => readSnapshot(cloudThread(snapshot), options) });
    assert.equal(result.works[0].execution, "idle"); assert.equal(result.works[0].attention, "unknown"); assert.equal(result.works[0].group, "未確認");
  }
});
