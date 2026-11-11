import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
// grace null leaves the product's own grace in place; hold is how long a failing read takes.
async function fixture(t, { count = 2, project = "P", grace = 0, hold = 0 } = {}) {
  const home = await mkdtemp(tempPrefix("ct-wait-unreadable-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, works = new Map(), calls = [], failed = [];
  let polls = 0;
  const join = async n => {
    await registerManagedThread(uuid(n), { projectId: project, connection: "shared", syncCursor: "c0" }, storage);
    await registerSupervisor(uuid(n), session(n), storage);
    works.set(uuid(n), { status: "idle", attention: [], turn: `turn-${n}`, turnStatus: "completed", events: [], error: null });
  };
  for (let n = 1; n <= count; n++) await join(n);
  const read = async (id, options) => {
    calls.push(id); const work = works.get(id);
    if (work.error) { failed.push({ poll: polls, thread_id: id, error: work.error }); await delay(hold); throw Object.assign(new Error("unreadable"), { code: work.error }); }
    return { thread_id: id, cursor: `c${work.events.length}`, events: work.events.slice(Number(options.since.slice(1))), has_more: false,
      status: work.status, attention: work.attention, latest_turn_id: work.turn, latest_turn_status: work.turnStatus, active_turn_count: work.status === "active" ? 1 : 0 };
  };
  // A wait checks its owner once before each poll, so that check numbers the polls and lets a test script the backend per poll.
  const f = { script: null }, owner = async pid => { if (pid !== 123) return "same-start"; polls++; await f.script?.(polls); return "owner-start"; };
  const dependencies = { storage, read, pollMs: 5, ...(grace === null ? {} : { unreadGraceMs: grace }), processIdentity: owner, orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  const finishTurn = id => { const work = works.get(id), turn = `next-${work.events.length + 1}`; Object.assign(work, { turn, status: "idle", turnStatus: "completed" }); work.events.push({ id: turn, type: "turn", status: "completed" }); };
  const history = async () => (await Promise.all(["project-sync-events", "project-sync-results"].map(bucket => recordStats(bucket, storage)))).flat().reduce((sum, record) => sum + record.bytes, 0);
  const head = () => readRecord("project-sync-heads", key(project), storage);
  // Every entry of a return says whether the head now holds its member as reported.
  const checked = async result => {
    const now = (await head())?.wait_reported_failures ?? {};
    for (const entry of result.unreadable) assert.equal(entry.reported, Object.hasOwn(now, entry.thread_id), `${result.reason}: reported matches the head for ${entry.thread_id}`);
    return result;
  };
  return Object.assign(f, { storage, works, calls, failed, checked, polls: () => polls, finishTurn, join, dependencies, sync: (options = {}) => syncProject(project, options, dependencies),
    wait: async (timeoutMs = 0) => { calls.length = 0; return f.checked(await waitProject(project, { timeoutMs }, dependencies)); },
    // Waits until something other than a timeout comes back; a restarted wait makes one poll per call.
    until: async restarted => { for (;;) { const result = await f.wait(restarted ? 0 : 10000); if (result.reason !== "timeout") return result; } },
    head, history, saved: async () => ({ history: await history(), head: await head() }) });
}

// Freezes Date.now; the returned function moves it to an offset from the start.
function clock(t) {
  const real = Date.now, start = real(); let now = start;
  Date.now = () => now; t.after(() => { Date.now = real; });
  return ms => { now = start + ms; };
}

// What a return lists: a member that failed the last poll only, and one the wait has reported.
const listed = reported => (...ids) => ids.map(thread_id => ({ thread_id, error: "TIMEOUT", reported }));
const unread = listed(false), reported = listed(true);

test("a permanently unreadable member is returned once, then wait stays quiet and saves nothing until something changes", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  const first = await f.wait();
  assert.equal(first.reason, "initial_sync"); assert.equal(first.changed, true); assert.equal(first.sync.complete, false);
  assert.deepEqual(first.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: false }]);
  const failed = await f.wait(1000);
  assert.equal(failed.reason, "observation_failed", "one failed poll at the first return is not yet a report"); assert.equal(failed.changed, false);
  assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: true }]);
  const quiet = [];
  for (const attempt of [2, 3]) {
    const result = await f.wait(30);
    assert.equal(result.reason, "timeout", `wait ${attempt}`); assert.equal(result.changed, false);
    assert.deepEqual(result.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: true }], `wait ${attempt} still lists the member`);
    assert.ok(f.calls.includes(A), `wait ${attempt} keeps reading the member`);
    quiet.push({ history: await f.history(), head: await f.head() });
  }
  assert.ok(quiet[0].history > 0);
  assert.equal(quiet[1].history, quiet[0].history, "repeated probes save no sync history");
  assert.deepEqual(quiet[1].head, quiet[0].head, "repeated probes publish nothing");

  f.finishTurn(B);
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed"); assert.equal(changed.changed, true); assert.equal(changed.sync.complete, false);
  assert.deepEqual(changed.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: true }]);
  assert.ok(changed.sync.works.find(work => work.thread_id === B).events.some(event => event.event_id === "next-1"));
  assert.equal((await f.wait(30)).reason, "timeout", "the same change is not returned twice");

  f.works.get(A).error = "RPC_REJECTED";
  const recoded = await f.wait(30);
  assert.equal(recoded.reason, "timeout", "a reported member is not returned for another code");
  assert.deepEqual(recoded.unreadable, [{ thread_id: A, error: "RPC_REJECTED", reported: true }]);

  f.works.get(A).error = null;
  const recovered = await f.wait(1000);
  assert.equal(recovered.reason, "work_changed", "the first complete read of a never-read member is new"); assert.equal(recovered.sync.complete, true);
  assert.deepEqual(recovered.unreadable, []);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a member that recovers without a change does not wake wait", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "RPC_REJECTED";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.works.get(A).error = null;
  const recovered = await f.wait(30);
  assert.equal(recovered.reason, "timeout"); assert.deepEqual(recovered.unreadable, []);
});

test("a reported failure that returns after a recovery without a change is returned again, once", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "CONNECTION_FAILED";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.works.get(A).error = null;
  assert.equal((await f.wait(30)).reason, "timeout", "the recovery alone is not a change");
  const ordinary = await f.sync();
  assert.equal(ordinary.complete, true);
  f.works.get(A).error = "CONNECTION_FAILED";
  const again = await f.wait(1000);
  assert.equal(again.reason, "observation_failed"); assert.deepEqual(again.unreadable, [{ thread_id: A, error: "CONNECTION_FAILED", reported: true }]);
  assert.equal((await f.wait(30)).reason, "timeout", "the recurrence is returned once");
});

test("a recovery seen only by an ordinary sync lets the same failure be returned again", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "CONNECTION_FAILED";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.works.get(A).error = null;
  assert.equal((await f.sync()).complete, true);
  assert.equal((await f.head()).wait_reported_failures, undefined, "the complete read clears the reported failure");
  f.works.get(A).error = "CONNECTION_FAILED";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  assert.equal((await f.wait(30)).reason, "timeout", "the recurrence is returned once");
});

test("a recovery and a recurrence inside one wait do not return the failure again", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "CONNECTION_FAILED";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.works.get(A).error = null;
  let reads = 0; const read = f.dependencies.read;
  f.dependencies.read = async (id, options) => { if (id === A && ++reads === 3) f.works.get(A).error = "CONNECTION_FAILED"; return read(id, options); };
  const result = await f.wait(200);
  assert.ok(reads >= 3); assert.equal(result.reason, "timeout"); assert.deepEqual(result.unreadable, [{ thread_id: A, error: "CONNECTION_FAILED", reported: true }]);
});

test("a partial ordinary sync does not consume a change wait has not returned", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  assert.equal((await f.wait()).reason, "initial_sync"); assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.finishTurn(B);
  const partial = await f.sync();
  assert.equal(partial.complete, false); assert.ok(partial.works.find(work => work.thread_id === B).events.length > 0);
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed"); assert.deepEqual(changed.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: true }]);
  assert.equal((await f.wait(30)).reason, "timeout");
});

test("a wait whose publication loses to a concurrent sync fails the observation and keeps the change for the next wait", async t => {
  const f = await fixture(t); f.works.get(A).error = "PAYLOAD_TOO_LARGE";
  assert.equal((await f.wait()).reason, "initial_sync"); assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.finishTurn(B); let raced = false;
  const lost = await f.checked(await waitProject("P", { timeoutMs: 1000 }, { ...f.dependencies, read: async (id, options) => {
    if (id === B && !raced) { raced = true; assert.equal((await f.sync()).complete, false); }
    return f.dependencies.read(id, options);
  } }));
  assert.ok(raced); assert.equal(lost.sync.publication_conflict, "SYNC_CURSOR_CONFLICT");
  assert.equal(lost.reason, "observation_failed"); assert.equal(lost.changed, false); assert.equal(lost.timed_out, false);
  assert.ok(lost.sync.works.every(work => work.complete === false));
  assert.deepEqual(lost.unreadable, [{ thread_id: A, error: "PAYLOAD_TOO_LARGE", reported: true }], "only the member that could not be read is unreadable");
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
  assert.equal((await f.wait(1000)).reason, "observation_failed");
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
  const remaining = activeUnreadable ? [{ thread_id: D, error: "RPC_REJECTED", reported: true }] : [];
  const stopped = await f.wait(1000);
  assert.equal(stopped.reason, "observation_failed", "stopped but unsettled work is still read");
  assert.deepEqual(stopped.unreadable, [{ thread_id: B, error: "PAYLOAD_TOO_LARGE", reported: true }, ...remaining]);
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
  const failed = await f.wait(1000);
  assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false);
  assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "RPC_REJECTED", reported: true }]);
  assert.equal((await f.wait(30)).reason, "timeout");
  Object.assign(f.works.get(A), { error: null, attention: approval });
  assert.equal((await f.wait(1000)).reason, "work_changed", "the clear 0.23.0 observed still makes the approval new");
});

test("a member that fails only the wait probe is returned once, however many ordinary syncs follow", async t => {
  const f = await fixture(t, { count: 3 }); await f.sync();
  const unknown = { [B]: "PROJECT_WAIT_ATTENTION_UNKNOWN" };
  f.works.get(B).attention = undefined;
  const failed = await f.wait(1000);
  assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, [{ thread_id: B, error: unknown[B], reported: true }]);
  for (const round of [1, 2]) {
    assert.equal((await f.sync()).complete, true, "an ordinary sync reads the member in full");
    assert.deepEqual((await f.head()).wait_reported_failures, unknown, `complete sync ${round} keeps what wait reported`);
    const saved = await f.history(), quiet = await f.wait(30);
    assert.equal(quiet.reason, "timeout", `wait after sync ${round}`); assert.deepEqual(quiet.unreadable, [{ thread_id: B, error: unknown[B], reported: true }]);
    assert.equal(await f.history(), saved, `wait after sync ${round} saves nothing`);
  }
  f.works.get(A).error = "RPC_REJECTED";
  assert.equal((await f.sync()).complete, false);
  assert.deepEqual((await f.head()).wait_reported_failures, unknown, "a partial sync reports nothing to wait");
  assert.equal((await f.wait(1000)).reason, "observation_failed", "the failure the sync saw is still new to wait");
  assert.deepEqual((await f.head()).wait_reported_failures, { [A]: "RPC_REJECTED", ...unknown });
  await removeRecord("project-index", createHash("sha256").update(B).digest("hex").slice(0, 40), f.storage);
  await f.sync();
  assert.deepEqual((await f.head()).wait_reported_failures, { [A]: "RPC_REJECTED" }, "work no longer in the project is forgotten");
});

for (const restarted of [false, true]) test(`members that fail one poll at a time, at different times, are never returned as a failure (${restarted ? "restarted waits" : "one wait"})`, async t => {
  const f = await fixture(t, { count: 5, grace: 10, hold: 30 }); await f.sync();
  const codes = ["TIMEOUT", "RPC_REJECTED", "CONNECTION_FAILED", "TIMEOUT", "RPC_REJECTED"], failing = [[3, 12], [4], [5], [9], [14]];
  const before = await f.saved(); let quiet;
  // Each failing read outlasts the grace. A turn that ends at poll 17 is the first thing worth returning.
  f.script = async poll => {
    failing.forEach((polls, n) => { f.works.get(uuid(n + 1)).error = polls.includes(poll) ? codes[n] : null; });
    if (poll === 17) { quiet = await f.saved(); f.finishTurn(B); }
  };
  const result = await f.until(restarted);
  assert.equal(result.reason, "work_changed"); assert.equal(f.polls(), 17); assert.deepEqual(result.unreadable, []);
  assert.deepEqual(f.failed, failing.flatMap((polls, n) => polls.map(poll => ({ poll, thread_id: uuid(n + 1), error: codes[n] }))).sort((a, b) => a.poll - b.poll), "every scripted failure was read");
  assert.deepEqual(quiet, before, "the failed polls saved nothing");
});

test("a member that fails every poll is returned once, after two failed polls and the grace", async t => {
  const f = await fixture(t, { count: 3, grace: 60 }); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  const started = Date.now(), failed = await f.wait(10000);
  assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false); assert.equal(failed.timed_out, false); assert.equal(failed.sync.complete, false);
  assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: true }]);
  assert.ok(Date.now() - started >= 60, "not before the grace"); assert.ok(f.failed.length >= 2, "after at least two failed polls");
  const saved = await f.saved(), quiet = await f.wait(150);
  assert.equal(quiet.reason, "timeout", "the member is returned once"); assert.deepEqual(quiet.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: true }]);
  assert.deepEqual(await f.saved(), saved, "the quiet wait saves nothing");
});

test("a member that fails every poll is returned by a restarted wait, two failed polls and one minute after its first failure", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  const first = await f.wait();
  assert.equal(first.reason, "timeout", "one failed poll"); assert.deepEqual(first.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: false }]);
  at(59999); assert.equal((await f.wait()).reason, "timeout", "two failed polls inside the grace");
  at(60000); const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: true }]);
  assert.equal((await f.wait()).reason, "timeout");
  at(3600000); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
  const record = await readRecord("project-wait-attention", key("P"), f.storage);
  at(7200000); assert.equal((await f.wait()).reason, "timeout");
  assert.deepEqual(await readRecord("project-wait-attention", key("P"), f.storage), record, "a wait that stays quiet stops rewriting its record");
});

for (const change of ["turn end", "approval"]) test(`${change === "approval" ? "an" : "a"} ${change} during a member's one failed poll is returned by the next poll`, async t => {
  const f = await fixture(t, { count: 3, grace: null }); await f.sync();
  f.script = poll => {
    f.works.get(A).error = poll === 1 ? "TIMEOUT" : null;
    if (poll !== 1) return;
    if (change === "turn end") f.finishTurn(A); else Object.assign(f.works.get(A), { status: "active", turn: "asking", turnStatus: "inProgress", attention: approval });
  };
  const result = await f.until(false);
  assert.equal(result.reason, "work_changed"); assert.equal(f.polls(), 2); assert.deepEqual(result.unreadable, []);
  assert.deepEqual(f.failed, [{ poll: 1, thread_id: A, error: "TIMEOUT" }]);
  if (change === "turn end") assert.ok(result.sync.works.find(work => work.thread_id === A).events.some(event => event.event_id === "next-1"));
});

for (const restarted of [false, true]) test(`a reported member that fails with another code, or reads fine for some polls and fails again, is not returned again (${restarted ? "restarted waits" : "one wait"})`, async t => {
  const f = await fixture(t, { count: 3 }); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.until(restarted)).reason, "observation_failed");
  const from = f.polls(); assert.equal(from, 2, "with no grace the failure is returned by the second failed poll, never the first");
  // Two polls with another code, three readable, then failing again. A turn that ends at the tenth poll is the next thing worth returning.
  f.script = poll => {
    f.works.get(A).error = poll - from < 3 ? "RPC_REJECTED" : poll - from < 6 ? null : "CONNECTION_FAILED";
    if (poll - from === 10) f.finishTurn(B);
  };
  const result = await f.until(restarted);
  assert.equal(result.reason, "work_changed"); assert.equal(f.polls(), from + 10);
  assert.deepEqual(result.unreadable, [{ thread_id: A, error: "CONNECTION_FAILED", reported: true }]);
});

for (const shown of ["wait return", "complete sync"]) test(`after a ${shown} showed a reported member readable, a new failure is returned once it lasts`, async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout"); at(60000); assert.equal((await f.wait()).reason, "observation_failed");
  f.works.get(A).error = null;
  if (shown === "complete sync") assert.equal((await f.sync()).complete, true);
  else { f.finishTurn(B); const changed = await f.wait(); assert.equal(changed.reason, "work_changed"); assert.deepEqual(changed.unreadable, []); }
  f.works.get(A).error = "TIMEOUT";
  at(70000); assert.equal((await f.wait()).reason, "timeout", "the first failed poll after the member was shown readable");
  at(129999); assert.equal((await f.wait()).reason, "timeout");
  at(130000); const again = await f.wait();
  assert.equal(again.reason, "observation_failed"); assert.deepEqual(again.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: true }]);
  at(3600000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "the new failure is returned once");
});

test("a change in a readable member is returned while another member has not failed long enough, lists that member as unreadable, and leaves it to be returned once it stays unread", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  const quiet = await f.wait(30);
  assert.equal(quiet.reason, "timeout"); assert.deepEqual(quiet.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: false }]);
  f.finishTurn(B);
  const changed = await f.wait(1000);
  assert.equal(changed.reason, "work_changed"); assert.equal(changed.changed, true); assert.equal(changed.sync.complete, false);
  assert.deepEqual(changed.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: false }]);
  assert.ok(changed.sync.works.find(work => work.thread_id === B).events.some(event => event.event_id === "next-1"));
  assert.equal((await f.wait()).reason, "timeout", "two failed polls inside the grace");
  at(59999); assert.equal((await f.wait()).reason, "timeout");
  at(60000); const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed", "listing the member once did not report it"); assert.deepEqual(failed.unreadable, [{ thread_id: A, error: "TIMEOUT", reported: true }]);
  at(3600000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
});

// Each wait below makes one poll, so the poll that returns is the one that fails.
for (const reason of ["initial_sync", "membership_changed", "work_changed"]) {
  const returned = async (f, expected) => {
    if (reason === "work_changed") f.finishTurn(C);
    if (reason === "membership_changed") await f.join(f.works.size + 1);
    const result = await f.wait();
    assert.equal(result.reason, reason); assert.equal(result.changed, true); assert.deepEqual(result.unreadable, expected);
  };
  const start = async t => { const f = await fixture(t, { count: 3, grace: null }), at = clock(t); if (reason !== "initial_sync") await f.sync(); return { f, at }; };

  test(`a member whose one failed poll falls on ${reason === "initial_sync" ? "an" : "a"} ${reason} return is returned once when it then fails every poll`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT"; await returned(f, unread(A));
    assert.equal((await f.wait()).reason, "timeout", "one failed poll after the return");
    at(59999); assert.equal((await f.wait()).reason, "timeout", "inside the grace");
    at(60000); const failed = await f.wait();
    assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false); assert.deepEqual(failed.unreadable, reported(A));
    at(3600000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
  });

  test(`a member whose one failed poll falls on ${reason === "initial_sync" ? "an" : "a"} ${reason} return, and that reads fine before it fails for good, is still returned once`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT"; await returned(f, unread(A));
    f.works.get(A).error = null;
    // A member the first return could not read is new once it is read.
    const readable = await f.wait(); assert.equal(readable.reason, reason === "initial_sync" ? "work_changed" : "timeout"); assert.deepEqual(readable.unreadable, []);
    at(3600000); assert.equal((await f.wait()).reason, "timeout");
    f.works.get(A).error = "TIMEOUT";
    assert.equal((await f.wait()).reason, "timeout", "one failed poll");
    at(3659999); assert.equal((await f.wait()).reason, "timeout", "inside the grace");
    at(3660000); const failed = await f.wait();
    assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, reported(A));
    at(7200000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
  });

  test(`a member whose one failed poll falls on ${reason === "initial_sync" ? "an" : "a"} ${reason} return and that then reads fine is never returned as a failure`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT"; await returned(f, unread(A));
    f.works.get(A).error = null;
    const reasons = [];
    for (const ms of [0, 60000, 3600000, 7200000]) { at(ms); const result = await f.wait(); reasons.push(result.reason); assert.deepEqual(result.unreadable, []); }
    assert.deepEqual(reasons, [reason === "initial_sync" ? "work_changed" : "timeout", "timeout", "timeout", "timeout"]);
  });

  // The first failure of a member that fails at an initial_sync return is that return.
  if (reason !== "initial_sync") test(`a member that keeps failing after ${reason === "initial_sync" ? "an" : "a"} ${reason} return is returned one minute after its first failure, not after the return`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT";
    assert.equal((await f.wait()).reason, "timeout", "the first failed poll");
    at(30000); await returned(f, unread(A));
    at(59999); assert.equal((await f.wait()).reason, "timeout", "inside the grace");
    at(60000); const failed = await f.wait();
    assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, reported(A));
    at(3600000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
  });

  if (reason !== "initial_sync") for (const first of ["that return", "observation_failed"]) test(`a member that never reads again while the wait returns for ${reason} more often than the grace is reported one minute after its first failure, first by ${first}`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT";
    for (const ms of [0, 20000, 40000]) { at(ms); await returned(f, unread(A)); }
    at(60000);
    if (first === "observation_failed") { const failed = await f.wait(); assert.equal(failed.reason, "observation_failed"); assert.equal(failed.changed, false); assert.deepEqual(failed.unreadable, reported(A)); }
    for (const ms of [60000, 80000, 100000]) { at(ms); await returned(f, reported(A)); }
    for (const ms of [3600000, 7200000]) { at(ms); const quiet = await f.wait(); assert.equal(quiet.reason, "timeout", "a reported member is not returned as a failure"); assert.deepEqual(quiet.unreadable, reported(A)); }
  });

  // Nothing is reported before the first return.
  if (reason !== "initial_sync") test(`a reported member still failing at a ${reason} return stays reported and is not returned again`, async t => {
    const { f, at } = await start(t);
    f.works.get(A).error = "TIMEOUT";
    assert.equal((await f.wait()).reason, "timeout"); at(60000); assert.equal((await f.wait()).reason, "observation_failed");
    await returned(f, reported(A));
    for (const ms of [60000, 120000, 3600000]) { at(ms); const quiet = await f.wait(); assert.equal(quiet.reason, "timeout"); assert.deepEqual(quiet.unreadable, reported(A)); }
  });
}

test("a member whose one failed poll falls on another member's failure return is returned once when it then fails every poll", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout");
  f.works.get(B).error = "TIMEOUT";
  at(60000); const first = await f.wait();
  assert.equal(first.reason, "observation_failed"); assert.deepEqual(first.unreadable, [...reported(A), ...unread(B)]);
  assert.equal((await f.wait()).reason, "timeout", "the second member has failed two polls, inside the grace");
  at(119999); assert.equal((await f.wait()).reason, "timeout");
  at(120000); const second = await f.wait();
  assert.equal(second.reason, "observation_failed"); assert.deepEqual(second.unreadable, reported(A, B));
  at(3600000); assert.equal((await f.wait()).reason, "timeout"); assert.equal((await f.wait()).reason, "timeout", "each member is returned once");
});

test("after a complete sync showed a reported member readable, one more failed poll is not returned, however long the member had failed before", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout"); at(60000); assert.equal((await f.wait()).reason, "observation_failed");
  at(120000); assert.equal((await f.wait()).reason, "timeout"); at(180000); assert.equal((await f.wait()).reason, "timeout");
  f.works.get(A).error = null;
  assert.equal((await f.sync()).complete, true);
  f.works.get(A).error = "TIMEOUT";
  at(240000); const one = await f.wait();
  assert.equal(one.reason, "timeout", "the first failed poll after the member was shown readable"); assert.deepEqual(one.unreadable, unread(A));
  at(299999); assert.equal((await f.wait()).reason, "timeout");
  at(300000); assert.equal((await f.wait()).reason, "observation_failed");
  at(3600000); assert.equal((await f.wait()).reason, "timeout", "the new failure is returned once");
});

test("a wall clock that moved backwards delays the return by one grace, not until the old time comes back", async t => {
  const f = await fixture(t, { grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout");
  at(-3600000); assert.equal((await f.wait()).reason, "timeout");
  at(-3600000 + 59999); assert.equal((await f.wait()).reason, "timeout");
  at(-3600000 + 60000); assert.equal((await f.wait()).reason, "observation_failed");
});

test("a wait record that an earlier version saved with an observed recovery loads, and that recovery no longer returns the failure", async t => {
  const f = await fixture(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait(10000)).reason, "observation_failed");
  const head = await f.head();
  await writeRecord("project-wait-attention", key("P"), { schema: 1, project_id: "P", baseline: head.wait_baseline.sync_token, flags: {},
    recovered: { [A]: { error: "TIMEOUT", wait_sync_token: head.wait_sync_token } } }, f.storage);
  assert.equal((await f.wait(60)).reason, "timeout");
  assert.equal((await readRecord("project-wait-attention", key("P"), f.storage)).recovered, undefined, "the unused field is dropped");
});

test("a member that failed one poll before a return that read it in full starts again from one poll", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout");
  f.works.get(A).error = null; f.finishTurn(B);
  const changed = await f.wait();
  assert.equal(changed.reason, "work_changed"); assert.deepEqual(changed.unreadable, []);
  f.works.get(A).error = "TIMEOUT";
  at(60000); const one = await f.wait();
  assert.equal(one.reason, "timeout", "the full read ended the earlier streak"); assert.deepEqual(one.unreadable, unread(A));
  at(119999); assert.equal((await f.wait()).reason, "timeout");
  at(120000); assert.equal((await f.wait()).reason, "observation_failed");
});

test("a failure whose publication loses to a concurrent sync is not reported by that return and is returned by the next wait", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout");
  at(60000); let raced = false;
  const lost = await f.checked(await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read: async (id, options) => {
    if (id === B && !raced) { raced = true; assert.equal((await f.sync()).complete, false); }
    return f.dependencies.read(id, options);
  } }));
  assert.ok(raced); assert.equal(lost.reason, "observation_failed"); assert.equal(lost.sync.publication_conflict, "SYNC_CURSOR_CONFLICT");
  assert.deepEqual(lost.unreadable, unread(A), "nothing was published, so the member is not reported");
  const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed"); assert.equal(failed.sync.publication_conflict, undefined); assert.deepEqual(failed.unreadable, reported(A));
  at(3600000); assert.equal((await f.wait()).reason, "timeout", "the member is returned once");
});

test("a return whose publication loses to a sync that read a reported member in full lists that member as not reported", async t => {
  const f = await fixture(t, { count: 3 }); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.finishTurn(B); let raced = false;
  // The wait's own read of the member fails; the sync that wins reads it in full.
  const lost = await f.checked(await waitProject("P", { timeoutMs: 1000 }, { ...f.dependencies, read: async (id, options) => {
    if (id === B && !raced) { raced = true; f.works.get(A).error = null; assert.equal((await f.sync()).complete, true); }
    return f.dependencies.read(id, options);
  } }));
  assert.ok(raced); assert.equal(lost.reason, "observation_failed"); assert.equal(lost.sync.publication_conflict, "SYNC_CURSOR_CONFLICT");
  assert.equal((await f.head()).wait_reported_failures, undefined);
  assert.deepEqual(lost.unreadable, unread(A));
});

test("a streak that an earlier version saved with the wait publication it started under still counts", async t => {
  const f = await fixture(t, { count: 3, grace: null }), at = clock(t); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  await writeRecord("project-wait-attention", key("P"), { schema: 1, project_id: "P", baseline: (await f.head()).wait_baseline.sync_token, flags: {},
    unread: { [A]: { since: Date.now(), polls: 1, wait_sync_token: "an-earlier-wait-publication" } } }, f.storage);
  at(59999); assert.equal((await f.wait()).reason, "timeout", "inside the grace");
  at(60000); const failed = await f.wait();
  assert.equal(failed.reason, "observation_failed"); assert.deepEqual(failed.unreadable, reported(A));
});

test("an approval that cleared during a poll whose publication lost, and was raised again, is returned", async t => {
  const f = await fixture(t, { count: 3 });
  Object.assign(f.works.get(A), { status: "active", turnStatus: "inProgress", attention: approval });
  await f.sync();
  f.works.get(C).error = "TIMEOUT";
  assert.equal((await f.wait()).reason, "timeout", "one failed poll");
  f.works.get(A).attention = []; let raced = false;
  // The poll sees the clear and reports the lasting failure, then loses to a partial sync.
  const lost = await f.checked(await waitProject("P", { timeoutMs: 0 }, { ...f.dependencies, read: async (id, options) => {
    if (id === B && !raced) { raced = true; assert.equal((await f.sync()).complete, false); }
    return f.dependencies.read(id, options);
  } }));
  assert.ok(raced); assert.equal(lost.reason, "observation_failed"); assert.equal(lost.sync.publication_conflict, "SYNC_CURSOR_CONFLICT");
  f.works.get(C).error = null; f.works.get(A).attention = approval;
  const renewed = await f.wait();
  assert.equal(renewed.reason, "work_changed", "the clear the lost poll saw makes the approval new"); assert.deepEqual(renewed.unreadable, []);
  assert.equal((await f.wait(30)).reason, "timeout", "the approval is returned once");
});

test("a wait whose owner exited lists the members its last poll could not read and says which are reported", async t => {
  const f = await fixture(t, { count: 3 }); await f.sync();
  f.works.get(A).error = "TIMEOUT";
  assert.equal((await f.wait(1000)).reason, "observation_failed");
  f.works.get(B).error = "TIMEOUT";
  const from = f.polls(), identity = f.dependencies.processIdentity;
  // The owner is gone when the wait checks it before its second poll.
  const orphan = await f.checked(await waitProject("P", { timeoutMs: 10000 }, { ...f.dependencies,
    processIdentity: async pid => { const start = await identity(pid); return pid === 123 && f.polls() - from > 1 ? "another-start" : start; } }));
  assert.equal(orphan.reason, "owner_exited"); assert.equal(orphan.changed, false); assert.equal(orphan.sync, null);
  assert.deepEqual(orphan.unreadable, [...reported(A), ...unread(B)]);
});
