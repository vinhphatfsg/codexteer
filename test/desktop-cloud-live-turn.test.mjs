import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { desktopCloudService } from "../test-support/desktop-cloud-service.mjs";
import { DesktopCloudClient, connectDesktopCloud } from "../src/desktop-cloud-api.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { controlProject } from "../src/project-control.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { sendDesktopCloudInput, createDesktopCloudTask, reconcileDesktopCloudCreation } from "../src/desktop-cloud.mjs";
import { startWork } from "../src/work-start.mjs";
import { resolveCloudModelSelection } from "../src/desktop-cloud-models.mjs";

const UNOBSERVED = "running_turn_unobserved", APPROVAL = "item/commandExecution/requestApproval", FLAG = `pendingRequest:${APPROVAL}`;
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`, ID = `durable_${uuid(901)}`;
let serial = 0;
const user = text => ({ id: `item-${++serial}`, type: "userMessage", clientId: null, content: [{ type: "text", text }] });
const agent = text => ({ id: `item-${++serial}`, type: "agentMessage", text });
const question = text => ({ id: `item-${++serial}`, type: "agentMessage", text, questions: [{ id: "choice", question: text }] });
const command = (status = "inProgress") => ({ id: `item-${++serial}`, type: "commandExecution", command: "make test", cwd: "/workspace", status, exitCode: null, aggregatedOutput: "" });

// One Desktop Cloud task behind the real client, reader and project commands.
// The service shows a running turn's items only when it ends, as the service does;
// `live: false` is the switch left off.
function task(n, { live = true } = {}) {
  const id = `durable_${uuid(n)}`, service = desktopCloudService(uuid(n), { environment: `fixture~asenvcfg_${n}`, liveTurn: true });
  const connect = async () => new DesktopCloudClient(service.rpc, live ? { openLive: service.openLive, timeoutMs: 100, drainMs: 5 } : {});
  return { ...service, id, connect, environment: `fixture~asenvcfg_${n}`, session: uuid(n + 500),
    resumes: () => service.state.live.resumes.length,
    start(text = "order") { const opening = user(text); const started = service.append([opening], { status: "inProgress" }); service.state.status = "active"; return { turn: started.id, opening }; },
    endedButActive() { service.append([user("order"), agent("report")]); service.state.status = "active"; } };
}

async function project(t, tasks) {
  const home = await mkdtemp(tempPrefix("ct-dc-live-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, byId = new Map(tasks.map(x => [x.id, x]));
  for (const x of tasks) {
    await registerManagedThread(x.id, { projectId: "P", connection: "desktop-cloud", environmentConfigId: x.environment }, storage);
    await registerSupervisor(x.id, x.session, { ...storage, connection: "desktop-cloud" });
  }
  const read = (id, options) => observeThread(id, options, { connect: byId.get(id).connect });
  const dependencies = { storage, read, pollMs: 5, processIdentity: async () => "same-start" };
  const send = (id, wire, options) => sendDesktopCloudInput(id, wire, options, { ...storage, connect: byId.get(id).connect });
  return { storage, read, dependencies, send, sync: () => syncProject("P", {}, dependencies), wait: () => waitProject("P", { timeoutMs: 0 }, dependencies),
    tell: (id, body, options = {}) => tellWork(id, body, options, { storage, read, send }) };
}

async function member(t, options) {
  const x = task(901, options), p = await project(t, [x]);
  return { ...x, ...p, row: async () => (await p.sync()).works[0] };
}

const eventIds = row => row.events.map(event => event.event_id);
const liveCalls = x => x.state.live.connections.map(connection => ({ calls: connection.calls.map(call => call.method), closed: connection.closed }));

test("read and status show what a running turn has done so far, one resume per read", async t => {
  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  const first = await f.read(ID, {});
  assert.equal(f.resumes(), 0, "no turn runs, so the task is not resumed");
  const { turn, opening } = f.start("second order");
  const note = agent("Reading the schema."), asked = question("Which database should the service use?"), running = command();
  f.progress(note, asked, running);

  const read = await f.read(ID, { since: first.cursor });
  assert.deepEqual(read.events.map(event => [event.id, event.change]), [[turn, "added"], [opening.id, "added"], [note.id, "added"], [asked.id, "added"], [running.id, "added"]]);
  assert.deepEqual(read.events.find(event => event.id === asked.id).questions, asked.questions);
  assert.equal(read.live_turn_id, turn); assert.equal(read.attention_coverage, undefined, "the running turn was read");
  assert.equal(read.execution, "active"); assert.deepEqual(read.running_commands.map(event => event.id), [running.id]);
  assert.equal(f.resumes(), 1);

  const status = await f.read(ID, { since: read.cursor });
  assert.deepEqual(status.events, []); assert.equal(status.changed, false); assert.equal(status.live_turn_id, turn); assert.equal(status.attention_coverage, undefined);
  assert.equal(f.resumes(), 2);
  assert.deepEqual(liveCalls(f), [{ calls: ["thread/resume"], closed: true }, { calls: ["thread/resume"], closed: true }], "each live read resumes on its own connection, sends nothing else and closes it");
});

test("project wait returns a question asked mid-turn while the turn runs, once, and not again when the turn ends", async t => {
  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  assert.equal((await f.wait()).reason, "initial_sync");
  const { turn } = f.start("second order");
  let resumes = f.resumes();
  assert.equal((await f.wait()).timed_out, true, "a turn that starts is not a change");
  assert.equal(f.resumes() - resumes, 1, "one resume per member per poll, although the poll reads it twice");

  const asked = question("Which database should the service use?");
  f.progress(agent("Reading the schema."), asked);
  resumes = f.resumes();
  const returned = await f.wait();
  assert.equal(returned.reason, "work_changed"); assert.equal(returned.attention_unobserved, undefined);
  const row = returned.sync.works[0];
  assert.equal(row.group, "対応が必要"); assert.equal(row.attention, "human"); assert.equal(row.execution, "active"); assert.equal(row.attention_coverage, undefined);
  const summary = row.events.find(event => event.event_id === asked.id);
  assert.equal(summary.text, "Which database should the service use?");
  assert.equal(f.resumes() - resumes, 1);

  assert.equal((await f.wait()).timed_out, true, "the question is not returned twice while the turn runs");
  const final = agent("Used the default database.");
  f.complete([final]);
  resumes = f.resumes();
  const ended = await f.wait(), endedRow = ended.sync.works[0];
  assert.equal(ended.reason, "work_changed");
  assert.deepEqual(eventIds(endedRow), [asked.id, turn, final.id], "the unresolved question it keeps, then the turn end and its new item");
  assert.equal(endedRow.events[0].token, summary.token, "the question is the one already returned, not delivered again");
  assert.equal(f.resumes(), resumes, "an ended turn is not resumed");
  assert.equal((await f.wait()).timed_out, true);
});

test("a member with no running turn is never resumed", async t => {
  const idle = task(911), ended = task(912), failed = task(913), unknown = task(914), behind = task(915), stopped = task(916);
  idle.append([user("order"), agent("report")]);
  ended.endedButActive();
  failed.append([user("order"), agent("report")], { status: "failed" }); failed.state.status = "systemError";
  unknown.append([user("order"), agent("report")], { status: "mystery" }); unknown.state.status = "active";
  behind.append([user("first")], { status: "inProgress" }); behind.endedButActive();
  stopped.append([user("order"), agent("report")]);
  const all = [idle, ended, failed, unknown, behind, stopped], p = await project(t, all);
  await p.sync();
  await controlProject("P", "stop", { work: stopped.id }, p.storage);
  await p.sync(); await p.wait(); await p.wait();
  for (const x of all) await p.read(x.id, {});
  assert.equal((await p.tell(idle.id, "Continue the same delegation.", { newTurn: true })).delivery_status, "accepted");
  assert.deepEqual(all.map(x => [x.resumes(), x.state.live.wakes]), all.map(() => [0, 0]));
});

test("a failed or timed-out live read leaves the member readable and marked, and delivers nothing twice", async t => {
  for (const failure of ["error", "timeout"]) {
    const f = await member(t);
    f.append([user("first order"), agent("first report")]);
    await f.sync();
    f.start();
    const asked = question("Proceed with the migration?");
    f.progress(asked);
    const seen = await f.row();
    assert.equal(seen.complete, true); assert.equal(seen.attention_coverage, undefined); assert.equal(eventIds(seen).includes(asked.id), true);

    f.state.live.failure = failure;
    const later = agent("Migrating.");
    f.progress(later);
    const resumes = f.resumes(), blind = await f.row();
    assert.equal(blind.complete, true, failure); assert.equal(blind.history_gap, false); assert.equal(blind.error, null);
    assert.equal(blind.attention_coverage, UNOBSERVED, "the member falls back to the history view");
    assert.deepEqual(eventIds(blind), [asked.id], `${failure}: nothing new is delivered and the unresolved question stays`);
    assert.equal(blind.group, "対応が必要");
    assert.equal(f.resumes() - resumes, 1, "a failed live read is not retried in the same sync");
    const read = await f.read(ID, {});
    assert.equal(read.attention_coverage, UNOBSERVED); assert.equal(read.live_turn_id, undefined);

    f.state.live.failure = null;
    const recovered = await f.row();
    assert.equal(recovered.attention_coverage, undefined);
    assert.deepEqual(eventIds(recovered), [asked.id, later.id], "the item missed meanwhile arrives once; the question is the unresolved one kept");
    f.complete([agent("done")]);
    const done = await f.row();
    assert.equal(eventIds(done).includes(later.id), false, `${failure}: the completed history does not repeat what the live view delivered`);
  }
});

test("a server request replayed to the reader is reported as human attention and never answered", async t => {
  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  assert.equal((await f.wait()).reason, "initial_sync");
  f.start(); f.progress(command());
  f.state.live.requests = [APPROVAL];
  const returned = await f.wait();
  assert.equal(returned.reason, "work_changed");
  const row = returned.sync.works[0];
  assert.equal(row.group, "対応が必要"); assert.equal(row.attention, "human");
  assert.deepEqual(row.reason.evidence.map(entry => entry.attention_flags).filter(Boolean), [[FLAG]]);
  const read = await f.read(ID, {});
  assert.deepEqual(read.attention, [FLAG]); assert.deepEqual(read.pending_requests, [APPROVAL]);
  assert.equal((await f.wait()).timed_out, true, "a request still pending is not returned twice");

  f.state.live.failure = "error";
  assert.equal((await f.wait()).timed_out, true, "a failed live read neither clears the request nor returns it again");
  const blind = await f.read(ID, { since: read.cursor });
  assert.deepEqual(blind.attention, [FLAG]); assert.equal(blind.attention_coverage, UNOBSERVED);
  await assert.rejects(f.tell(ID, "Continue."), { code: "WORK_TELL_HUMAN_REQUIRED" });
  assert.equal(f.state.calls.some(call => call.method === "turn/steer"), false);

  f.state.live.failure = null; f.state.live.requests = [];
  const answered = await f.row();
  assert.equal(answered.attention, "none"); assert.equal(answered.group, "動作中");
  for (const connection of liveCalls(f)) assert.deepEqual(connection, { calls: ["thread/resume"], closed: true });
});

test("a turn that ends between the history read and the resume is read from the history", async t => {
  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  const first = await f.read(ID, {});
  const { turn, opening } = f.start();
  const note = agent("Working."), final = agent("Finished.");
  f.progress(note);
  f.state.live.beforeResume = () => { f.complete([final]); f.state.live.beforeResume = null; };
  const raced = await f.read(ID, { since: first.cursor });
  assert.deepEqual(raced.events.map(event => event.id), [turn, opening.id], "the snapshot of an ended turn is not used");
  assert.equal(raced.attention_coverage, UNOBSERVED); assert.equal(raced.live_turn_id, undefined);
  assert.equal(f.state.live.wakes, 1, "the residual race: a resume that arrives after the turn ended");
  const resumes = f.resumes(), next = await f.read(ID, { since: raced.cursor });
  assert.deepEqual(next.events.map(event => [event.id, event.change]), [[turn, "updated"], [note.id, "added"], [final.id, "added"]]);
  assert.equal(f.resumes(), resumes);
});

test("a live view whose item ids differ from the history fails closed to the history view", async t => {
  const opening = await member(t);
  opening.append([user("first order"), agent("first report")]);
  const first = await opening.read(ID, {});
  opening.start(); opening.progress(agent("Working."));
  opening.state.live.itemId = id => `live-${id}`;
  const refused = await opening.read(ID, { since: first.cursor });
  assert.equal(refused.events.length, 2, "the opening message has another id in the live view, so the snapshot is not used");
  assert.equal(refused.attention_coverage, UNOBSERVED);

  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  const base = await f.read(ID, {});
  const { opening: message } = f.start(), note = agent("Working.");
  f.progress(note);
  f.state.live.itemId = id => id === message.id ? id : `live-${id}`;
  const live = await f.read(ID, { since: base.cursor });
  assert.deepEqual(live.events.map(event => event.id).slice(2), [`live-${note.id}`]);
  f.complete([agent("Done.")]);
  const done = await f.read(ID, { since: live.cursor });
  assert.deepEqual(done.live_mismatch, { turn_id: f.state.turns.at(-1).id, unlisted: 1 });
  assert.equal(done.events.some(event => event.id === note.id), true, "history items are delivered, never skipped");
  f.start("third order"); f.progress(agent("More work."));
  const resumes = f.resumes(), after = await f.read(ID, { since: done.cursor });
  assert.equal(f.resumes(), resumes, "after a mismatch the task is read from the history only");
  assert.equal(after.attention_coverage, UNOBSERVED);
});

test("work tell reads the running turn live once, and refuses on a question, a pending request or new progress", async t => {
  const f = await member(t);
  f.append([user("first order"), agent("first report")]);
  f.start(); f.progress(agent("Working."));
  await f.sync();
  let resumes = f.resumes();
  const steered = await f.tell(ID, "Also update the changelog.");
  assert.equal(steered.delivery_status, "accepted"); assert.equal(steered.attention_coverage, undefined);
  assert.equal(f.resumes() - resumes, 1, "the freshness read and the check before sending share one live read");

  f.progress(agent("Updating the changelog."));
  await f.sync();
  f.progress(agent("Still going."));
  await assert.rejects(f.tell(ID, "Also run the linter."), { code: "WORK_TELL_STALE_SYNC" }, "new progress after the sync makes it stale, as on local threads");

  await f.sync();
  f.progress(question("Should the linter be strict?"));
  await assert.rejects(f.tell(ID, "Also run the linter."), { code: "WORK_TELL_HUMAN_REQUIRED" });
  await f.sync();
  await assert.rejects(f.tell(ID, "Also run the linter."), { code: "WORK_TELL_HUMAN_REQUIRED" }, "a question in the reviewed sync");
  assert.equal(f.state.calls.filter(call => call.method === "turn/steer").length, 1);
});

test("work start reads the new task's history only, and the first sync reads its running turn once", async t => {
  const home = await mkdtemp(tempPrefix("ct-dc-live-start-")), root = await mkdtemp(tempPrefix("ct-dc-live-root-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  await writeFile(`${root}/CODEXTEER.md`, "policy\n");
  const x = task(941), storage = { home }, environment = { id: x.environment, name: "Fixture" };
  const transport = { ...storage, connect: x.connect, environments: async () => ({ environments: [environment] }) };
  const read = (id, options) => observeThread(id, options, { connect: x.connect });
  const started = await startWork({ project: "P", title: "live", order: "Report a focused result.", root, environment: "Fixture", connection: "desktop-cloud" }, { storage,
    resolveEnvironment: async () => environment, resolveModelSelection: options => resolveCloudModelSelection(options, transport),
    create: ({ environmentConfigId, prompt, title, attemptId, modelSelection }) => createDesktopCloudTask(environmentConfigId, prompt, { title, attemptId, modelSelection }, transport),
    reconcile: record => reconcileDesktopCloudCreation(record, transport), read });
  assert.equal(started.thread_id, x.id); assert.equal(x.resumes(), 0, "the creation check does not resume the task");
  const note = agent("Reading the order.");
  x.progress(note);
  const sync = await syncProject("P", {}, { storage, read });
  assert.equal(sync.complete, true); assert.equal(sync.works[0].error, null); assert.equal(sync.works[0].attention_coverage, undefined);
  const ids = eventIds(sync.works[0]);
  assert.equal(ids.filter(id => id === note.id).length, 1); assert.equal(new Set(ids).size, ids.length, "nothing is delivered twice");
  assert.equal(x.resumes(), 1);
});

test("one sync and one wait poll resume each running member once", async t => {
  const running = [task(921), task(922), task(923)], idle = task(924);
  for (const x of running) { x.start(); x.progress(agent("Working.")); }
  idle.append([user("order"), agent("report")]);
  const p = await project(t, [...running, idle]);
  await p.sync();
  assert.deepEqual([...running, idle].map(x => x.resumes()), [1, 1, 1, 0]);
  await p.wait(); await p.wait();
  assert.deepEqual([...running, idle].map(x => x.resumes()), [3, 3, 3, 0]);
});

test("with the switch off, a running turn stays unobserved and is never resumed", async t => {
  const f = await member(t, { live: false });
  f.start(); f.progress(question("Which database?"));
  const row = await f.row();
  assert.equal(row.attention_coverage, UNOBSERVED); assert.equal(f.resumes(), 0);
  assert.equal((await f.read(ID, {})).attention_coverage, UNOBSERVED);
});

// The wire under connectDesktopCloud: a scripted socket that serves one task
// with a running turn and replays an approval request to a resuming client.
function wire() {
  const UUID = uuid(931), frames = [];
  const turn = { id: "turn-1", status: "inProgress", startedAt: 1, items: [{ id: "item-a", type: "userMessage", content: [{ type: "text", text: "order" }] }], itemsView: "full" };
  const asked = { id: "item-b", type: "agentMessage", text: "Which database?", questions: [{ id: "choice", question: "Which database?" }] };
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; frames.push(this.sent); setImmediate(() => { this.readyState = 1; this.emit("open"); }); }
    reply(message) { setImmediate(() => this.emit("message", Buffer.from(JSON.stringify(message)), false)); }
    send(data, done) {
      const message = JSON.parse(data); this.sent.push(message); done?.();
      if (message.id === undefined) return;
      const thread = { id: UUID, name: "worker", status: { type: "active", activeFlags: [] }, environments: [] };
      if (message.method === "initialize") this.reply({ id: message.id, result: {} });
      else if (message.method === "thread/read") this.reply({ id: message.id, result: { thread } });
      else if (message.method === "thread/turns/list") this.reply({ id: message.id, result: { data: [turn], nextCursor: null } });
      else if (message.method === "thread/resume") {
        this.reply({ id: message.id, result: { thread: { ...thread, turns: [{ ...turn, items: [...turn.items, asked] }] }, resumeKind: "attached" } });
        this.reply({ id: "approval-1", method: APPROVAL, params: { threadId: UUID } });
      } else this.reply({ id: message.id, error: { code: -32601, message: "unsupported" } });
    }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.readyState = 3; this.emit("close"); }
  }
  const connect = env => () => connectDesktopCloud({}, { credentials: async () => ({ token: "token", accountId: "account" }), Socket, env });
  return { id: `durable_${UUID}`, frames, connect };
}

test("on the wire, the reader resumes on its own connection and answers no server request", async t => {
  const on = wire();
  const read = await observeThread(on.id, {}, { connect: on.connect({ CODEXTEER_DESKTOP_CLOUD_LIVE_TURN: "on" }) });
  assert.deepEqual(read.events.map(event => event.id), ["turn-1", "item-a", "item-b"]);
  assert.deepEqual(read.attention, [FLAG]); assert.deepEqual(read.pending_requests, [APPROVAL]);
  const methods = on.frames.map(sent => sent.map(message => message.method));
  assert.deepEqual(methods[1], ["initialize", "initialized", "thread/resume"], "the live connection initializes and resumes, nothing more");
  assert.equal(methods[0].includes("thread/resume"), false, "the read connection is never subscribed");
  assert.deepEqual(on.frames.flat().filter(message => message.method === undefined), [], "no response frame, so the approval request is never answered");

  const off = wire();
  const blind = await observeThread(off.id, {}, { connect: off.connect({}) });
  assert.equal(blind.attention_coverage, UNOBSERVED); assert.equal(off.frames.length, 1, "with the switch off no live connection is opened");
  assert.equal(off.frames.flat().some(message => message.method === "thread/resume"), false);
});
