import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { legacyHead } from "../test-support/fixtures/project-sync-head-0.23.0.mjs";
import { registerManagedThread, listManagedThreads, managedMembershipDigest, updateManagedThreadCursor } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { readRecord, writeRecord, removeRecord, recordStats } from "../src/store.mjs";

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, session = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2), C = uuid(3);
const key = project => createHash("sha256").update(project).digest("hex").slice(0, 40);
const approval = ["waitingOnApproval"];

// A scripted backend: each work's cursor is the number of its events already read.
async function fixture(t, { count = 2, project = "P" } = {}) {
  const home = await mkdtemp(tempPrefix("ct-wait-unreadable-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, works = new Map(), calls = [];
  for (let n = 1; n <= count; n++) {
    await registerManagedThread(uuid(n), { projectId: project, connection: "shared", syncCursor: "c0" }, storage);
    await registerSupervisor(uuid(n), session(n), storage);
    works.set(uuid(n), { status: "idle", attention: [], turn: `turn-${n}`, turnStatus: "completed", events: [], error: null });
  }
  const read = async (id, options) => {
    calls.push(id); const work = works.get(id);
    if (work.error) throw Object.assign(new Error("unreadable"), { code: work.error });
    return { thread_id: id, cursor: `c${work.events.length}`, events: work.events.slice(Number(options.since.slice(1))), has_more: false,
      status: work.status, attention: work.attention, latest_turn_id: work.turn, latest_turn_status: work.turnStatus, active_turn_count: work.status === "active" ? 1 : 0 };
  };
  const dependencies = { storage, read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start", orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  const finishTurn = id => { const work = works.get(id), turn = `next-${work.events.length + 1}`; Object.assign(work, { turn, status: "idle", turnStatus: "completed" }); work.events.push({ id: turn, type: "turn", status: "completed" }); };
  return { storage, works, calls, finishTurn, dependencies, sync: (options = {}) => syncProject(project, options, dependencies),
    wait: (timeoutMs = 0) => { calls.length = 0; return waitProject(project, { timeoutMs }, dependencies); },
    head: () => readRecord("project-sync-heads", key(project), storage),
    history: async () => (await Promise.all(["project-sync-events", "project-sync-results"].map(bucket => recordStats(bucket, storage)))).flat().reduce((sum, record) => sum + record.bytes, 0) };
}

test("a permanently unreadable member is returned once, then wait stays quiet and saves nothing until something changes", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  const first = await f.wait();
  assert.equal(first.reason, "initial_sync"); assert.equal(first.changed, true); assert.equal(first.sync.complete, false);
  assert.deepEqual(first.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE" }]);
  const quiet = [];
  for (const attempt of [2, 3]) {
    const result = await f.wait(30);
    assert.equal(result.reason, "timeout", `wait ${attempt}`); assert.equal(result.changed, false);
    assert.deepEqual(result.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE" }], `wait ${attempt} still lists the member`);
    assert.ok(f.calls.includes(A), `wait ${attempt} keeps reading the member`);
    quiet.push({ history: await f.history(), head: await f.head() });
  }
  assert.ok(quiet[0].history > 0);
  assert.equal(quiet[1].history, quiet[0].history, "repeated probes save no sync history");
  assert.deepEqual(quiet[1].head, quiet[0].head, "repeated probes publish nothing");

  f.finishTurn(B);
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed"); assert.equal(changed.changed, true); assert.equal(changed.sync.complete, false);
  assert.deepEqual(changed.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE" }]);
  assert.ok(changed.sync.works.find(work => work.thread_id === B).events.some(event => event.event_id === "next-1"));
  assert.equal((await f.wait(30)).reason, "timeout", "the same change is not returned twice");

  f.works.get(A).error = "RPC_REJECTED";
  const failed = await f.wait(1000);
  assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false);
  assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "RPC_REJECTED" }]);
  assert.equal((await f.wait(30)).reason, "timeout", "a changed code is returned once");

  f.works.get(A).error = null;
  const recovered = await f.wait(1000);
  assert.equal(recovered.reason, "work_changed", "the first complete read of a never-read member is new"); assert.equal(recovered.sync.complete, true);
  assert.deepEqual(recovered.unreadable, []);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a member that recovers without a change does not wake wait", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "RPC_REJECTED";
  assert.equal((await f.wait()).reason, "observation_failed");
  f.works.get(A).error = null;
  const recovered = await f.wait(30);
  assert.equal(recovered.reason, "timeout"); assert.deepEqual(recovered.unreadable, []);
});

test("a partial ordinary sync does not consume a change wait has not returned", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  assert.equal((await f.wait()).reason, "initial_sync");
  f.finishTurn(B);
  const partial = await f.sync();
  assert.equal(partial.complete, false); assert.ok(partial.works.find(work => work.thread_id === B).events.length > 0);
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed"); assert.deepEqual(changed.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE" }]);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a wait whose publication loses to a concurrent sync fails the observation and keeps the change for the next wait", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  assert.equal((await f.wait()).reason, "initial_sync");
  f.finishTurn(B); let raced = false;
  const lost = await waitProject("P", { timeoutMs: 1000 }, { ...f.dependencies, read: async (id, options) => {
    if (id === B && !raced) { raced = true; assert.equal((await f.sync()).complete, false); }
    return f.dependencies.read(id, options);
  } });
  assert.ok(raced); assert.equal(lost.sync.publication_conflict, "SYNC_CURSOR_CONFLICT");
  assert.equal(lost.reason, "observation_failed"); assert.equal(lost.changed, false); assert.equal(lost.timed_out, false);
  assert.ok(lost.sync.works.every(work => work.complete === false));
  assert.deepEqual(lost.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE" }], "only the member that could not be read is unreadable");
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed", "the turn the lost publication saw is still new"); assert.equal(changed.sync.publication_conflict, undefined);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a renewed approval on a member that was unreadable at the last return still wakes wait", async t => {
  const f = await fixture(t);
  Object.assign(f.works.get(A), { status: "active", turnStatus: "inProgress", attention: approval });
  await f.sync();
  f.works.get(A).attention = [];
  assert.equal((await f.wait(30)).reason, "timeout", "the clear is observed, not returned");
  f.works.get(A).error = "RPC_REJECTED";
  assert.equal((await f.wait()).reason, "observation_failed");
  Object.assign(f.works.get(A), { error: null, attention: approval });
  const renewed = await f.wait(1000);
  assert.equal(renewed.reason, "work_changed"); assert.deepEqual(renewed.unreadable, []);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a standing approval on a member read by the last return does not wake wait again", async t => {
  const f = await fixture(t);
  Object.assign(f.works.get(A), { status: "active", turnStatus: "inProgress", attention: approval });
  await f.sync();
  f.works.get(A).attention = [];
  assert.equal((await f.wait(30)).reason, "timeout");
  f.works.get(A).attention = approval;
  assert.equal((await f.wait(1000)).reason, "work_changed");
  assert.equal((await f.wait(30)).reason, "timeout", "the returned approval is not returned again");
  f.finishTurn(B);
  assert.equal((await f.wait(1000)).reason, "work_changed");
  assert.equal((await f.wait(30)).reason, "timeout");
});

for (const activeUnreadable of [false, true]) test(`settled work is never listed as unreadable or remembered as a failure${activeUnreadable ? " while active work stays unreadable" : ""}`, async t => {
  const f = await fixture(t, { count: 4 }), D = uuid(4);
  await f.sync(); await controlSupervisor(A, "stop", f.storage); await f.sync();
  assert.ok((await f.head()).settled[A]);
  f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  await controlSupervisor(B, "stop", f.storage); f.works.get(B).error = "PAYLOAD_TOO_LARGE";
  if (activeUnreadable) f.works.get(D).error = "RPC_REJECTED";
  const remaining = activeUnreadable ? [{ thread_id: D, error: "RPC_REJECTED" }] : [];
  const stopped = await f.wait();
  assert.equal(stopped.reason, "observation_failed", "stopped but unsettled work is still read");
  assert.deepEqual(stopped.unreadable, [{ thread_id: B, error: "PAYLOAD_TOO_LARGE" }, ...remaining]);
  assert.equal((await f.sync({ excludeUnreadable: B, reason: "history exceeds the receive limit" })).complete, !activeUnreadable);
  const head = await f.head();
  assert.deepEqual(Object.keys(head.settled).sort(), [A, B]);
  assert.deepEqual(head.wait_reported_failures, activeUnreadable ? { [D]: "RPC_REJECTED" } : undefined);
  assert.deepEqual(Object.keys(head.wait_baseline.works).sort(), [C, D]);
  const quiet = await f.wait(30);
  assert.equal(quiet.reason, "timeout"); assert.deepEqual(quiet.unreadable, remaining);
  assert.deepEqual([...new Set(f.calls)].sort(), [C, D]);
});

test("a 0.23.0 head and wait record behave as before on the first wait and keep an observed clear", async t => {
  const f = await fixture(t, { project: "legacy" });
  for (const id of [A, B]) await updateManagedThreadCursor(id, "c0", "c1", f.storage);
  for (const id of [A, B]) f.works.get(id).events.push({ id: "read", type: "agentMessage", text: "read by 0.23.0" });
  const head = legacyHead(managedMembershipDigest(await listManagedThreads("legacy", f.storage)));
  head.wait_baseline.works[A].signal.attention = approval;
  await writeRecord("project-sync-heads", key("legacy"), head, f.storage);
  // As 0.23.0 saves it after observing the approval clear.
  await writeRecord("project-wait-attention", key("legacy"), { schema: 1, project_id: "legacy", baseline: head.wait_baseline.sync_token, flags: { [A]: [] } }, f.storage);
  f.works.get(A).error = "RPC_REJECTED";
  const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false);
  assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "RPC_REJECTED" }]);
  assert.equal((await f.wait(30)).reason, "timeout");
  Object.assign(f.works.get(A), { error: null, attention: approval });
  assert.equal((await f.wait(1000)).reason, "work_changed", "the clear 0.23.0 observed still makes the approval new");
});

test("a member that fails only the wait probe is returned once, however many ordinary syncs follow", async t => {
  const f = await fixture(t, { count: 3 }); await f.sync();
  const unknown = { [B]: "PROJECT_WAIT_ATTENTION_UNKNOWN" };
  f.works.get(B).attention = undefined;
  const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, [{ thread_id: B, error: unknown[B] }]);
  for (const round of [1, 2]) {
    assert.equal((await f.sync()).complete, true, "an ordinary sync reads the member in full");
    assert.deepEqual((await f.head()).wait_reported_failures, unknown, `complete sync ${round} keeps what wait reported`);
    const saved = await f.history(), quiet = await f.wait(30);
    assert.equal(quiet.reason, "timeout", `wait after sync ${round}`); assert.deepEqual(quiet.unreadable, [{ thread_id: B, error: unknown[B] }]);
    assert.equal(await f.history(), saved, `wait after sync ${round} saves nothing`);
  }
  f.works.get(A).error = "RPC_REJECTED";
  assert.equal((await f.sync()).complete, false);
  assert.deepEqual((await f.head()).wait_reported_failures, unknown, "a partial sync reports nothing to wait");
  assert.equal((await f.wait()).reason, "observation_failed", "the failure the sync saw is still new to wait");
  assert.deepEqual((await f.head()).wait_reported_failures, { [A]: "RPC_REJECTED", ...unknown });
  await removeRecord("project-index", createHash("sha256").update(B).digest("hex").slice(0, 40), f.storage);
  await f.sync();
  assert.deepEqual((await f.head()).wait_reported_failures, { [A]: "RPC_REJECTED" }, "work no longer in the project is forgotten");
});
