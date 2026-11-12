import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { desktopCloudService } from "../test-support/desktop-cloud-service.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { observeThread } from "../src/observe.mjs";
import { parseCursor } from "../src/cursor.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { sendDesktopCloudInput } from "../src/desktop-cloud.mjs";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000e1", ID = `durable_${UUID}`, ENV = "fixture~asenvcfg_evidence", SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000e2";
const UNOBSERVED = "running_turn_unobserved";
let serial = 0;
const user = text => ({ id: `item-${++serial}`, type: "userMessage", clientId: null, content: [{ type: "text", text }] });
const agent = text => ({ id: `item-${++serial}`, type: "agentMessage", text });

// A managed Desktop Cloud member behind the real client and the real reader.
async function member(t) {
  const home = await mkdtemp(tempPrefix("ct-dc-evidence-")); t.after(() => rm(home, { recursive: true, force: true }));
  const service = desktopCloudService(UUID, { environment: ENV }), connect = async () => new DesktopCloudClient(service.rpc), storage = { home };
  const read = (id, options) => observeThread(id, options, { connect });
  await registerManagedThread(ID, { projectId: "P", connection: "desktop-cloud", environmentConfigId: ENV }, storage);
  await registerSupervisor(ID, SESSION, { ...storage, connection: "desktop-cloud" });
  const dependencies = { storage, read, pollMs: 5, processIdentity: async () => "same-start" };
  const send = (id, wire, options) => sendDesktopCloudInput(id, wire, options, { ...storage, connect });
  return { ...service, storage, read, connect, dependencies, send, sync: () => syncProject("P", {}, dependencies),
    methods: () => service.state.calls.map(call => call.method),
    // The last turn ended, and the thread status still says active.
    endedButActive(status = "completed") { service.append([user("order"), agent("report")], { status }); service.state.status = "active"; },
    running() { service.append([user("order")], { status: "inProgress" }); service.state.status = "active"; } };
}

test("a member whose thread stays active after its last turn ended takes a new turn, and a steer is still refused", async t => {
  const f = await member(t); f.endedButActive();
  const work = (await f.sync()).works[0];
  assert.equal(work.execution, "idle"); assert.equal(work.group, "検収待ち"); assert.equal(work.reason.backend_status, "active");
  await assert.rejects(f.send(ID, "Steer the finished turn."), { code: "STALE_OBSERVATION" });
  assert.equal(f.methods().includes("turn/steer"), false);
  const told = await tellWork(ID, "Continue the same delegation.", { newTurn: true }, { storage: f.storage, read: f.read, send: f.send });
  assert.equal(told.delivery_status, "accepted"); assert.equal(f.methods().filter(method => method === "turn/start").length, 1);
  assert.equal(f.state.turns.at(-1).status, "inProgress");
});

test("a running turn refuses a new turn and takes a steer, whatever the thread status says", async t => {
  for (const status of ["active", "idle"]) {
    const f = await member(t); f.running(); f.state.status = status;
    await assert.rejects(f.send(ID, "Start another turn.", { newTurn: true }), { code: "STALE_OBSERVATION" });
    assert.equal(f.methods().includes("turn/start"), false, status);
    const steered = await f.send(ID, "Steer the running turn.");
    assert.equal(steered.delivery_status, "accepted"); assert.equal(steered.turn_id, f.state.turns.at(-1).id);
  }
});

test("turns that do not prove their state, and a thread status that is neither idle nor active, refuse as before", async t => {
  const unknown = await member(t); unknown.endedButActive("mystery");
  await assert.rejects(unknown.send(ID, "Start a turn.", { newTurn: true }), { code: "STALE_OBSERVATION" });
  await assert.rejects(unknown.send(ID, "Steer."), { code: "STALE_OBSERVATION" });
  const failed = await member(t); failed.endedButActive(); failed.state.status = "systemError";
  await assert.rejects(failed.send(ID, "Start a turn.", { newTurn: true }), { code: "STALE_OBSERVATION" });
  assert.deepEqual([...unknown.methods(), ...failed.methods()].filter(method => method.startsWith("turn/s")), []);
  const idle = await member(t); idle.endedButActive(); idle.state.status = "idle";
  assert.equal((await idle.send(ID, "Start a turn.", { newTurn: true })).delivery_status, "accepted");
  const empty = await member(t);
  assert.equal((await empty.send(ID, "Open the thread.", { newTurn: true })).delivery_status, "accepted", "a thread with no turn is idle");
});

test("an older turn still running behind an ended newest turn refuses a new turn, as its row is active", async t => {
  const f = await member(t);
  f.append([user("first order")], { status: "inProgress" }); f.endedButActive();
  assert.equal((await f.sync()).works[0].execution, "active");
  await assert.rejects(f.send(ID, "Start a turn.", { newTurn: true }), { code: "STALE_OBSERVATION" });
  await assert.rejects(tellWork(ID, "Continue.", { newTurn: true }, { storage: f.storage, read: f.read, send: f.send }), { code: "WORK_TELL_NEW_TURN_INVALID" });
  assert.equal(f.methods().includes("turn/start"), false);
});

test("a new turn after an active thread status is proved from every turn's status, without reading items", async t => {
  const long = await member(t);
  for (let n = 0; n < 250; n++) long.append([user(`order ${n}`), agent(`report ${n}`)]);
  long.state.status = "active"; long.resetServed();
  assert.equal((await long.send(ID, "Start a turn.", { newTurn: true })).delivery_status, "accepted");
  assert.deepEqual([long.state.served.turns, long.state.served.ids], [0, 251], "the newest turn, then every turn, as ids and statuses only");
  const unlisted = await member(t); unlisted.endedButActive(); unlisted.state.rejectNotLoaded = true;
  await assert.rejects(unlisted.send(ID, "Start a turn.", { newTurn: true }), { code: "STALE_OBSERVATION" });
  assert.equal(unlisted.methods().includes("turn/start"), false, "a service that lists no turn without its items proves nothing");
  unlisted.state.status = "idle";
  assert.equal((await unlisted.send(ID, "Start a turn.", { newTurn: true })).delivery_status, "accepted", "an idle thread status needs no such proof, as before");
});

test("status, read and watch --until idle say what the rows say, and keep the thread status", async t => {
  const f = await member(t); f.endedButActive();
  const ended = await f.read(ID, {});
  assert.equal(ended.status, "active", "the thread status is reported as the service gave it");
  assert.equal(ended.execution, "idle"); assert.equal(ended.execution_basis, "turn_status");
  assert.equal(ended.latest_turn_status, "completed"); assert.equal(ended.active_turn_count, 0); assert.equal(ended.attention_coverage, undefined);
  assert.equal((await f.sync()).works[0].execution, ended.execution);
  const idle = await f.read(ID, { watch: true, until: "idle", timeoutMs: 0, pollMs: 250 });
  assert.equal(idle.timed_out, false); assert.equal(idle.reason, "idle"); assert.equal(idle.execution, "idle"); assert.equal(idle.status, "active");

  f.running();
  const running = await f.read(ID, {});
  assert.equal(running.execution, "active"); assert.equal(running.execution_basis, undefined, "the thread status and the turns agree");
  assert.equal(running.attention_coverage, UNOBSERVED);
  f.state.status = "idle";
  const contradicted = await f.read(ID, { watch: true, until: "idle", timeoutMs: 0, pollMs: 250 });
  assert.equal(contradicted.status, "idle"); assert.equal(contradicted.execution, "active"); assert.equal(contradicted.execution_basis, "turn_status");
  assert.equal(contradicted.timed_out, true, "a running turn is not idle");
  assert.equal((await f.sync()).works[0].execution, "active");

  f.complete([agent("done")]); f.state.turns.at(-1).status = "mystery"; f.state.status = "active";
  const unknown = await f.read(ID, {});
  assert.equal(unknown.execution, "active", "unproven turns leave the thread status in charge"); assert.equal(unknown.execution_basis, undefined);
  assert.equal(unknown.attention_coverage, UNOBSERVED);
});

test("a read from the cursor's turn keeps the unobserved mark, with and without new events", async t => {
  const f = await member(t);
  for (let n = 0; n < 5; n++) f.append([user(`order ${n}`), agent(`report ${n}`)]);
  const first = await f.read(ID, {}); f.running();
  const started = await f.read(ID, { since: first.cursor });
  assert.equal(parseCursor(started.cursor, ID).v, 3); assert.equal(started.history_scope, "tail-turns");
  assert.equal(started.events.length, 2); assert.equal(started.attention_coverage, UNOBSERVED);
  f.resetServed();
  const unchanged = await f.read(ID, { since: started.cursor });
  assert.deepEqual(unchanged.events, []); assert.equal(unchanged.changed, false);
  assert.equal(f.state.served.turns, 1, "only the running turn is listed");
  assert.equal(unchanged.attention_coverage, UNOBSERVED); assert.equal(unchanged.execution, "active");
  const row = (await f.sync()).works[0];
  assert.equal(row.attention_coverage, UNOBSERVED); assert.equal(row.execution, "active");

  f.complete([agent("done")]); f.state.status = "active";
  const ended = await f.read(ID, { since: unchanged.cursor });
  assert.equal(parseCursor(ended.cursor, ID).settled, true);
  f.resetServed();
  const quiet = await f.read(ID, { since: ended.cursor });
  assert.deepEqual([f.state.served.turns, f.state.served.ids], [0, 1], "the read lists the newest turn's id and status only");
  assert.deepEqual(quiet.events, []); assert.equal(quiet.status, "active");
  assert.equal(quiet.attention_coverage, undefined, "the turns it listed prove that none runs");
  assert.equal(quiet.execution, "idle"); assert.equal(quiet.execution_basis, "turn_status");
  assert.equal(quiet.latest_turn_status, "completed"); assert.equal(quiet.active_turn_count, 0);
});

test("a wait that ends because its launcher is gone still names the members it could not observe", async t => {
  const f = await member(t); f.running();
  const wait = dependencies => waitProject("P", {}, { ...f.dependencies, ...dependencies });
  assert.equal((await waitProject("P", { timeoutMs: 0 }, f.dependencies)).reason, "initial_sync");
  let parent = 4242;
  setTimeout(() => { parent = 1; }, 50);
  const stopped = await wait({ pollMs: 15000, parentPid: () => parent });
  assert.deepEqual(stopped, { project_id: "P", changed: false, timed_out: false, reason: "launcher_exited", unreadable: [],
    attention_unobserved: [{ thread_id: ID, attention_coverage: UNOBSERVED }], sync: null });

  // The launcher goes while a poll is still reading: the last completed read names them.
  parent = 4242;
  const began = performance.now();
  const midRead = await wait({ parentPid: () => parent, read: async (...args) => {
    if (parent !== 1 && performance.now() - began > 100) { parent = 1; await delay(1500); }
    return f.read(...args);
  } });
  assert.equal(midRead.reason, "launcher_exited"); assert.equal(midRead.sync, null);
  assert.deepEqual(midRead.attention_unobserved, [{ thread_id: ID, attention_coverage: UNOBSERVED }]);
});
