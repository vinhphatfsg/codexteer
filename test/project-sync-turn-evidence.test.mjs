import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";

const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`, session = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const ids = { "desktop-cloud": `durable_${uuid(41)}`, shared: uuid(42), cloud: "task_fixture_turn_evidence" };
const row = (result, id) => result.works.find(work => work.thread_id === id);

// A scripted backend: the cursor is the number of events already read, and the
// thread status and the turn evidence are set independently of each other.
async function fixture(t, connection = "desktop-cloud") {
  const home = await mkdtemp(tempPrefix("ct-turn-evidence-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, id = ids[connection], calls = [];
  const work = { status: "active", attention: [], turn: connection === "cloud" ? `${id}~assttrn_a` : "turn-1", turnStatus: "completed", activeTurns: 0, events: [] };
  await registerManagedThread(id, { projectId: "P", connection, syncCursor: "c0" }, storage);
  await registerSupervisor(id, session(1), { ...storage, connection });
  const read = async (thread, options) => {
    calls.push(thread);
    return { thread_id: thread, cursor: `c${work.events.length}`, events: work.events.slice(Number(options.since.slice(1))), has_more: false, title: "work",
      status: work.status, attention: work.attention, latest_turn_id: work.turn, latest_turn_status: work.turnStatus, active_turn_count: work.activeTurns };
  };
  const dependencies = { storage, read, pollMs: 5, processIdentity: async () => "same-start" };
  return { id, work, calls, storage, sync: () => { calls.length = 0; return syncProject("P", {}, dependencies); },
    wait: () => waitProject("P", { timeoutMs: 0 }, dependencies), stop: () => controlSupervisor(id, "stop", storage) };
}

test("a Desktop Cloud thread that stays active after its last turn completed is idle and awaits review", async t => {
  const f = await fixture(t), work = row(await f.sync(), f.id);
  assert.equal(work.execution, "idle"); assert.equal(work.attention, "review"); assert.equal(work.group, "検収待ち");
  assert.equal(work.attention_coverage, undefined, "no turn runs, so nothing is hidden");
  assert.deepEqual(work.reason, { backend_status: "active", attention_flags: [], question_event: false, failure_event: false,
    execution_basis: "turn_status", review_basis: "idle_after_completed_turn", latest_turn_id: "turn-1", latest_turn_status: "completed", active_turn_count: 0 });
});

for (const [turnStatus, attention, group] of [["interrupted", "unknown", "未確認"], ["failed", "failure", "対応が必要"]]) {
  test(`a Desktop Cloud thread that stays active after its last turn ${turnStatus} is not an active execution`, async t => {
    const f = await fixture(t); f.work.turnStatus = turnStatus;
    const work = row(await f.sync(), f.id);
    assert.equal(work.execution, "idle"); assert.equal(work.attention, attention); assert.equal(work.group, group);
    assert.equal(work.reason.execution_basis, "turn_status"); assert.equal(work.reason.backend_status, "active", "the raw thread status stays visible");
    assert.equal(work.reason.latest_turn_status, turnStatus); assert.equal(work.reason.active_turn_count, 0);
  });
}

test("a stopped Desktop Cloud member whose thread stays active after all turns ended settles and is not read again", async t => {
  const f = await fixture(t); f.work.events.push({ id: "report", type: "agentMessage", text: "Done." }); await f.stop();
  const first = await f.sync();
  assert.equal(first.complete, true); assert.equal(row(first, f.id).execution, "idle"); assert.equal(row(first, f.id).settled.basis, "observed");
  const second = await f.sync();
  assert.deepEqual(f.calls, [], "the settled member is not read"); assert.equal(row(second, f.id).observation, "settled");
  assert.equal(row(second, f.id).reason.backend_status, "active");
});

for (const [name, question, group, attention] of [["a completed turn", false, "検収待ち", "review"], ["an unanswered question", true, "対応が必要", "human"]]) {
  test(`a member settled on turn evidence after ${name} keeps its row and moves to the group of settled rows`, async t => {
    const f = await fixture(t);
    if (question) f.work.events.push({ id: "q", type: "agentMessage", text: "Which?", questions: ["Which?"] });
    await f.stop();
    const settling = row(await f.sync(), f.id);
    assert.equal(settling.settled.basis, "observed"); assert.equal(settling.group, group, "the result that read it keeps the classified group");
    assert.equal(settling.reason.execution_basis, "turn_status"); assert.equal(settling.reason.backend_status, "active");
    for (const result of [await f.sync(), (await f.wait()).sync ?? await f.sync()]) {
      const carried = row(result, f.id);
      assert.deepEqual(f.calls, [], "the settled member is not read");
      assert.equal(carried.observation, "settled"); assert.equal(carried.group, "監視終了");
      assert.equal(carried.execution, "idle"); assert.equal(carried.attention, attention);
      assert.deepEqual(carried.reason, settling.reason, "the turn evidence that settled it stays on the row");
    }
  });
}

test("a turn that ends while the Desktop Cloud thread status stays active is returned by wait", async t => {
  const f = await fixture(t); Object.assign(f.work, { turnStatus: "inProgress", activeTurns: 1 });
  assert.equal((await f.wait()).reason, "initial_sync"); assert.equal((await f.wait()).timed_out, true);
  f.work.events.push({ id: "report", type: "agentMessage", text: "Done." }); Object.assign(f.work, { turnStatus: "completed", activeTurns: 0 });
  const ended = await f.wait();
  assert.equal(ended.reason, "work_changed"); assert.equal(row(ended.sync, f.id).execution, "idle"); assert.equal(row(ended.sync, f.id).attention, "review");
});

for (const status of ["idle", "notLoaded"]) {
  test(`a Desktop Cloud member reported ${status} while a turn runs is active and never quiet`, async t => {
    const f = await fixture(t); Object.assign(f.work, { status, turnStatus: "inProgress", activeTurns: 1 }); await f.stop();
    for (const attempt of [1, 2]) {
      const work = row(await f.sync(), f.id);
      assert.deepEqual(f.calls.includes(f.id), true, `sync ${attempt} reads the stopped member`);
      assert.equal(work.execution, "active"); assert.equal(work.settled, undefined);
      assert.equal(work.reason.execution_basis, "turn_status"); assert.equal(work.reason.backend_status, status);
    }
  });
}

const unproven = { "no turn count": { activeTurns: null }, "no turn status": { turnStatus: null },
  "a running count beside an ended latest turn": { activeTurns: 1 }, "no running count beside a running latest turn": { turnStatus: "inProgress" } };
for (const [name, evidence] of Object.entries(unproven)) {
  test(`with ${name}, a Desktop Cloud member keeps the thread status and is not quiet`, async t => {
    const f = await fixture(t); Object.assign(f.work, evidence); await f.stop();
    const active = row(await f.sync(), f.id);
    assert.equal(active.execution, "active"); assert.equal(active.reason.execution_basis, undefined); assert.equal(active.settled, undefined);
    assert.equal(active.attention_coverage, "running_turn_unobserved", "a turn that may be running hides what it asks");
    f.work.status = "idle";
    const idle = row(await f.sync(), f.id);
    assert.equal(idle.execution, "idle"); assert.equal(idle.settled, undefined, "an idle status does not prove that no turn runs");
    assert.equal(idle.attention_coverage, "running_turn_unobserved");
    assert.ok(f.calls.includes(f.id));
  });
}

for (const connection of ["shared", "cloud"]) {
  test(`a ${connection} member keeps the execution its thread status gives`, async t => {
    const f = await fixture(t, connection), work = row(await f.sync(), f.id);
    assert.equal(work.execution, "active"); assert.equal(work.attention, connection === "cloud" ? "unknown" : "none");
    assert.equal(work.reason.execution_basis, undefined);
    Object.assign(f.work, { status: "idle", turnStatus: "inProgress", activeTurns: 1 });
    assert.equal(row(await f.sync(), f.id).execution, "idle");
  });
}

test("a stopped shared member reported idle is not quiet while its latest turn is in progress", async t => {
  const f = await fixture(t, "shared"); Object.assign(f.work, { status: "idle", turnStatus: "inProgress", activeTurns: 0 }); await f.stop();
  assert.equal(row(await f.sync(), f.id).settled, undefined);
  f.work.turnStatus = "completed";
  assert.equal(row(await f.sync(), f.id).settled.basis, "observed");
});
