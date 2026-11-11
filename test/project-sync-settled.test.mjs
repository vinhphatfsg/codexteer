import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tempPrefix } from "../test-support/temp.mjs";
import { legacyHead } from "../test-support/fixtures/project-sync-head-0.23.0.mjs";
import { registerManagedThread, getManagedThread, listManagedThreads, managedMembershipDigest, updateManagedThreadCursor } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject, continueProjectSync, projectEvent } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { pruneProjectHistory } from "../src/project-history.mjs";
import { readRecord, writeRecord, listRecords, removeRecord } from "../src/store.mjs";

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, session = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2), C = uuid(3);
const headKey = project => createHash("sha256").update(project).digest("hex").slice(0, 40);
const message = (id, extra = {}) => ({ id, type: "agentMessage", text: id, ...extra });
const row = (result, id) => result.works.find(work => work.thread_id === id);

// A scripted backend: each work's cursor is the number of its events already read.
async function fixture(t, { count = 2, project = "P" } = {}) {
  const home = await mkdtemp(tempPrefix("ct-settled-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, works = new Map(), calls = [];
  for (let n = 1; n <= count; n++) {
    await registerManagedThread(uuid(n), { projectId: project, connection: "shared", syncCursor: "c0" }, storage);
    await registerSupervisor(uuid(n), session(n), storage);
    works.set(uuid(n), { status: "idle", attention: [], turn: `turn-${n}`, turnStatus: "completed", events: [], error: null });
  }
  const read = async (id, options) => {
    calls.push(id); const work = works.get(id);
    if (work.error) throw Object.assign(new Error("unreadable"), work.error);
    return { thread_id: id, cursor: `c${work.events.length}`, events: work.events.slice(Number(options.since.slice(1))), has_more: false, title: `work ${id.slice(-1)}`,
      status: work.status, attention: work.attention, latest_turn_id: work.turn, latest_turn_status: work.turnStatus, active_turn_count: "activeTurns" in work ? work.activeTurns : work.status === "active" ? 1 : 0 };
  };
  const sync = (options = {}, dependencies = {}) => { calls.length = 0; return syncProject(project, options, { storage, read, ...dependencies }); };
  return { storage, works, calls, read, sync, stop: id => controlSupervisor(id, "stop", storage), head: () => readRecord("project-sync-heads", headKey(project), storage) };
}

test("a stopped work seen quiet is settled by the sync that read it and is not read again", async t => {
  const f = await fixture(t); f.works.get(A).events.push(message("report")); await f.stop(A);
  const first = await f.sync();
  assert.deepEqual([...new Set(f.calls)].sort(), [A, B], "the sync that first sees the stop still reads everyone");
  assert.equal(first.complete, true); assert.equal(row(first, A).observation, "current");
  assert.equal(row(first, A).events[0].event_id, "report", "the last delta is presented before the work is left alone");
  assert.equal(row(first, A).settled.basis, "observed"); assert.equal(row(first, B).settled, undefined);
  const savedEvents = async () => (await listRecords("project-sync-events", f.storage)).filter(record => record.thread_id === A).length;
  const saved = await savedEvents(), membership = await getManagedThread(A, f.storage);
  f.works.get(A).events.push(message("reactivated from Desktop")); f.works.get(A).status = "active";
  for (const attempt of [2, 3]) {
    const next = await f.sync(), settled = row(next, A);
    assert.ok(f.calls.length > 0 && f.calls.every(id => id === B), `sync ${attempt} reads only the unsettled work`);
    assert.equal(next.complete, true); assert.equal(next.membership_count, 2); assert.equal(next.membership_digest, first.membership_digest);
    assert.equal(settled.observation, "settled"); assert.deepEqual(settled.events, []); assert.equal(settled.detail_token, undefined);
    assert.equal(settled.settled.basis, "observed"); assert.equal(settled.title, "work 1"); assert.equal(settled.execution, "idle");
    assert.equal(next.works.at(-1).thread_id, A, "settled rows follow the works that were read");
    assert.equal(await savedEvents(), saved, "a settled work adds no saved history");
  }
  assert.deepEqual(await getManagedThread(A, f.storage), membership, "a settled work's cursor and revision stay put");
});

for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
  test(`a stopped work with a live ${flag} flag keeps being read until the flag clears`, async t => {
    const f = await fixture(t); f.works.get(A).events.push(message("question", { questions: ["Which?"] })); f.works.get(A).attention = [flag]; await f.stop(A);
    for (const attempt of [1, 2]) {
      const result = await f.sync();
      assert.ok(f.calls.includes(A), `sync ${attempt} reads the stopped work`);
      assert.equal(row(result, A).attention, "human"); assert.equal(row(result, A).settled, undefined); assert.equal((await f.head()).settled, undefined);
    }
    f.works.get(A).events.push({ id: "answer", type: "userMessage", text: "The first." }); f.works.get(A).attention = [];
    const answered = await f.sync();
    assert.equal(row(answered, A).settled.basis, "observed");
    assert.equal(row(answered, A).attention, "review", "a later user message resolves the question"); assert.equal((await f.head()).unresolved_attention[A], undefined);
    await f.sync(); assert.equal(f.calls.includes(A), false);
  });
}

test("a stopped work with a running turn is not settled until it is idle", async t => {
  const f = await fixture(t); Object.assign(f.works.get(A), { status: "active", turnStatus: "inProgress" }); await f.stop(A);
  for (const attempt of [1, 2]) {
    const result = await f.sync();
    assert.ok(f.calls.includes(A), `sync ${attempt} reads the stopped work`);
    assert.equal(row(result, A).execution, "active"); assert.equal(row(result, A).settled, undefined);
  }
  Object.assign(f.works.get(A), { status: "idle", turnStatus: "completed" });
  assert.equal(row(await f.sync(), A).settled.basis, "observed");
});

test("a stopped work whose flags are unknown is not settled until they are known", async t => {
  const f = await fixture(t); f.works.get(A).attention = null; await f.stop(A);
  for (const attempt of [1, 2]) {
    const result = await f.sync();
    assert.ok(f.calls.includes(A), `sync ${attempt} reads the stopped work`); assert.equal(row(result, A).settled, undefined);
  }
  f.works.get(A).attention = [];
  assert.equal(row(await f.sync(), A).settled.basis, "observed");
});

for (const [status, activeTurns] of [["idle", 1], ["notLoaded", 1], ["idle", null]]) {
  test(`a stopped work reported ${status} with ${activeTurns === null ? "unprovable" : "running"} turns is not settled`, async t => {
    const f = await fixture(t); Object.assign(f.works.get(A), { status, turnStatus: activeTurns ? "inProgress" : "completed", activeTurns }); await f.stop(A);
    for (const attempt of [1, 2]) {
      const result = await f.sync();
      assert.ok(f.calls.includes(A), `sync ${attempt} reads the stopped work`); assert.equal(row(result, A).settled, undefined);
    }
    Object.assign(f.works.get(A), { status: "idle", turnStatus: "completed", activeTurns: 0 });
    assert.equal(row(await f.sync(), A).settled.basis, "observed");
  });
}

test("work that is not stopped is read on every sync, paused work included", async t => {
  const f = await fixture(t); await controlSupervisor(B, "pause", f.storage);
  for (const attempt of [1, 2]) {
    const result = await f.sync();
    assert.deepEqual([...new Set(f.calls)].sort(), [A, B], `sync ${attempt}`);
    assert.ok(result.works.every(work => work.settled === undefined && work.observation === "current"));
  }
  assert.equal((await f.head()).settled, undefined);
});

test("excluding is rejected before any read unless the work is a stopped member and a reason is given", async t => {
  const f = await fixture(t); f.works.get(A).error = { code: "PAYLOAD_TOO_LARGE" }; await f.stop(B);
  for (const [options, code] of [[{ excludeUnreadable: A, reason: "too large" }, "PROJECT_SYNC_EXCLUDE_NOT_STOPPED"],
    [{ excludeUnreadable: uuid(9), reason: "too large" }, "PROJECT_SYNC_EXCLUDE_UNMANAGED"],
    [{ excludeUnreadable: B }, "PROJECT_SYNC_INVALID"], [{ excludeUnreadable: B, reason: "  " }, "PROJECT_SYNC_INVALID"], [{ reason: "too large" }, "PROJECT_SYNC_INVALID"]]) {
    await assert.rejects(f.sync(options), { code });
    assert.deepEqual(f.calls, [], code); assert.equal(await f.head(), null, code);
  }
});

test("an excluded unreadable work keeps its unresolved attention through later syncs and prune", async t => {
  const f = await fixture(t); f.works.get(A).events.push(message("question", { questions: ["Which?"] }));
  const token = row(await f.sync(), A).events[0].token;
  await f.stop(A); f.works.get(A).error = { code: "PAYLOAD_TOO_LARGE" };
  const stuck = await f.sync();
  assert.equal(stuck.complete, false); assert.equal(row(stuck, A).error, "PAYLOAD_TOO_LARGE"); assert.equal(stuck.exclude_unreadable, undefined);
  const attention = (await f.head()).unresolved_attention[A];
  const excluded = await f.sync({ excludeUnreadable: A, reason: " history exceeds the receive limit " });
  assert.ok(f.calls.includes(A), "the work is read once more before it is excluded");
  assert.deepEqual(excluded.exclude_unreadable, { thread_id: A, outcome: "excluded", error: "PAYLOAD_TOO_LARGE" });
  assert.equal(excluded.complete, true, "an excluded work no longer holds the project incomplete");
  assert.deepEqual(row(excluded, A).settled, { basis: "excluded", reason: "history exceeds the receive limit", error: "PAYLOAD_TOO_LARGE", settled_at: excluded.created_at });
  for (const attempt of [1, 2]) {
    const next = await f.sync(), carried = row(next, A);
    assert.equal(f.calls.includes(A), false, `sync ${attempt} after exclusion`); assert.equal(next.complete, true);
    assert.equal(carried.observation, "settled"); assert.equal(carried.complete, false);
    assert.equal(carried.attention, "human"); assert.equal(carried.group, "対応が必要"); assert.equal(carried.attention_repeated, true);
    assert.equal(carried.settled.reason, "history exceeds the receive limit"); assert.equal(carried.settled.error, "PAYLOAD_TOO_LARGE");
    assert.equal(next.works.at(-1).thread_id, A, "a settled row follows the rows still being read, unresolved attention or not");
    assert.deepEqual(carried.events.map(event => event.token), [token], "the carried row still cites the unresolved question");
    assert.deepEqual((await f.head()).unresolved_attention[A], attention);
    await pruneProjectHistory("P", f.storage);
    assert.equal((await projectEvent(token, f.storage)).event.id, "question", "prune keeps the evidence the head still cites");
    assert.equal((await continueProjectSync(next.sync_token, {}, f.storage)).works.length, 2, "the latest result still pages after prune");
  }
  const again = await f.sync({ excludeUnreadable: A, reason: "again" });
  assert.deepEqual(again.exclude_unreadable, { thread_id: A, outcome: "already_settled" }); assert.equal(f.calls.includes(A), false);
  assert.equal(row(again, A).settled.reason, "history exceeds the receive limit");
});

test("the exclusion flag does not settle throttled, endless or readable work", async t => {
  const f = await fixture(t); await f.stop(A);
  f.works.get(A).error = { code: "CLOUD_RATE_LIMITED", retry_after_ms: 9000 };
  const throttled = await f.sync({ excludeUnreadable: A, reason: "stuck" });
  assert.deepEqual(throttled.exclude_unreadable, { thread_id: A, outcome: "not_applied", error: "CLOUD_RATE_LIMITED" });
  assert.equal(throttled.complete, false); assert.equal(row(throttled, A).settled, undefined); assert.equal((await f.head()).settled, undefined);
  f.works.get(A).error = { code: "CONNECTION_FAILED", cause_code: "CLOUD_RATE_LIMITED", retry_after_ms: 9000 };
  const mapped = await f.sync({ excludeUnreadable: A, reason: "stuck" });
  assert.deepEqual(mapped.exclude_unreadable, { thread_id: A, outcome: "not_applied", error: "CONNECTION_FAILED" }, "Web Cloud throttling keeps its cause");
  assert.equal(row(mapped, A).retry_after_ms, 9000); assert.equal((await f.head()).settled, undefined);
  f.works.get(A).error = { code: "OBSERVATION_CHANGED" };
  const racing = await f.sync({ excludeUnreadable: A, reason: "stuck" });
  assert.deepEqual(racing.exclude_unreadable, { thread_id: A, outcome: "not_applied", error: "OBSERVATION_CHANGED" }, "a turn starting during the read is not unreadable");
  assert.equal((await f.head()).settled, undefined);
  f.works.get(A).error = null;
  const endless = await f.sync({ excludeUnreadable: A, reason: "stuck", maxPagesPerWork: 2 }, { read: async (id, options) => id !== A ? f.read(id, options)
    : { ...(await f.read(id, options)), cursor: `more-${options.since}`, events: [message(`more-${options.since}`)], has_more: true } });
  assert.deepEqual(endless.exclude_unreadable, { thread_id: A, outcome: "not_applied", error: "PAGE_BUDGET_EXHAUSTED" });
  assert.equal((await f.head()).settled, undefined);
  const readable = await f.sync({ excludeUnreadable: A, reason: "stuck" });
  assert.deepEqual(readable.exclude_unreadable, { thread_id: A, outcome: "unnecessary" });
  assert.equal(row(readable, A).settled.basis, "observed", "a readable stopped work settles by the normal rule");
});

test("a head published by 0.23.0 is honored as written and gains no new field while nothing is stopped", async t => {
  const f = await fixture(t, { project: "legacy" });
  for (const id of [A, B]) await updateManagedThreadCursor(id, "c0", "c1", f.storage);
  f.works.get(A).events.push(message("done")); f.works.get(B).events.push(message("q", { questions: ["Which?"] }));
  await writeRecord("project-sync-heads", headKey("legacy"), legacyHead(managedMembershipDigest(await listManagedThreads("legacy", f.storage))), f.storage);
  const legacy = await f.head();
  const waited = await waitProject("legacy", { timeoutMs: 0 }, { storage: f.storage, read: f.read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) });
  assert.equal(waited.reason, "timeout", "the 0.23.0 wait baseline is still the baseline");
  const result = await f.sync();
  assert.deepEqual([...new Set(f.calls)].sort(), [A, B]); assert.equal(result.complete, true);
  assert.ok(result.works.every(work => work.settled === undefined && work.observation === "current" && work.detail_token));
  assert.equal(row(result, B).attention, "human"); assert.equal(row(result, B).attention_repeated, true);
  assert.equal(row(result, B).events[0].token, legacy.unresolved_attention[B].events[0].token, "the 0.23.0 evidence is repeated, not re-created");
  assert.deepEqual(Object.keys(await f.head()).sort(), Object.keys(legacy).sort());
  assert.equal(result.exclude_unreadable, undefined);
});

test("the first sync on a 0.23.0 head still reads a work that was stopped earlier, then leaves it alone", async t => {
  const f = await fixture(t, { project: "legacy" });
  for (const id of [A, B]) await updateManagedThreadCursor(id, "c0", "c1", f.storage);
  f.works.get(A).events.push(message("done")); f.works.get(B).events.push(message("q", { questions: ["Which?"] }));
  await writeRecord("project-sync-heads", headKey("legacy"), legacyHead(managedMembershipDigest(await listManagedThreads("legacy", f.storage))), f.storage);
  await f.stop(A); await f.stop(B);
  const upgraded = await f.sync();
  assert.deepEqual([...new Set(f.calls)].sort(), [A, B]);
  assert.equal(row(upgraded, A).settled.basis, "observed"); assert.equal(row(upgraded, B).settled.basis, "observed");
  assert.equal(row(upgraded, B).attention, "human"); assert.equal(row(upgraded, B).attention_repeated, true);
  const question = (await f.head()).unresolved_attention[B].events[0].token;
  assert.ok(row(upgraded, B).events.some(event => event.token === question), "the 0.23.0 question is shown by the sync that settles its work");
  const next = await f.sync(); assert.deepEqual(f.calls, []);
  assert.equal(row(next, B).attention, "human"); assert.deepEqual(row(next, B).events.map(event => event.token), [question]);
});

test("a sync that loses the publication race settles nothing and the newer head keeps settled work and its attention", async t => {
  const f = await fixture(t, { count: 3 });
  f.works.get(A).events.push(message("question", { questions: ["Which?"] })); await f.sync();
  await f.stop(A); f.works.get(A).error = { code: "PAYLOAD_TOO_LARGE" }; await f.sync({ excludeUnreadable: A, reason: "too large" });
  const attention = (await f.head()).unresolved_attention[A];
  await f.stop(B); let raced = false;
  // The racing sync sees B mid-turn, so it publishes a head that does not settle B.
  const lost = await f.sync({}, { read: async (id, options) => {
    if (id === C && !raced) { raced = true; f.works.get(B).status = "active"; await syncProject("P", {}, { storage: f.storage, read: f.read }); f.works.get(B).status = "idle"; }
    return f.read(id, options);
  } });
  assert.equal(lost.complete, false); assert.equal(lost.publication_conflict, "SYNC_CURSOR_CONFLICT");
  assert.equal(row(lost, B).error, "SYNC_CURSOR_CONFLICT"); assert.equal(row(lost, B).settled, undefined);
  assert.equal(row(lost, A).observation, "settled"); assert.equal(row(lost, A).settled.basis, "excluded"); assert.equal(row(lost, A).attention, "human");
  const head = await f.head();
  assert.deepEqual(Object.keys(head.settled), [A]); assert.deepEqual(head.unresolved_attention[A], attention);
  const next = await f.sync();
  assert.equal(next.publication_conflict, undefined); assert.equal(row(next, B).settled.basis, "observed"); assert.equal(f.calls.includes(A), false);
  assert.deepEqual((await f.head()).unresolved_attention[A], attention);
});

test("a cursor that moved during the read leaves a stopped work unsettled and is not grounds for exclusion", async t => {
  const f = await fixture(t); await f.stop(A); let moved = false;
  const result = await f.sync({ excludeUnreadable: A, reason: "stuck" }, { read: async (id, options) => {
    if (id === A && !moved) { moved = true; await updateManagedThreadCursor(A, "c0", "c0", f.storage); }
    return f.read(id, options);
  } });
  assert.deepEqual(result.exclude_unreadable, { thread_id: A, outcome: "not_applied", error: "SYNC_CURSOR_CONFLICT" });
  assert.equal(result.complete, false); assert.equal(row(result, A).settled, undefined); assert.equal((await f.head()).settled, undefined);
  assert.equal(row(await f.sync(), A).settled.basis, "observed");
});

test("a settled row with a long reason pages at the smallest budget and is returned in full at a larger one", async t => {
  const f = await fixture(t), reason = "理由".repeat(3000);
  await f.stop(A); f.works.get(A).error = { code: "PAYLOAD_TOO_LARGE" }; await f.sync({ excludeUnreadable: A, reason });
  const small = await f.sync({ byteBudget: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 4096);
  assert.deepEqual(small.works.map(work => work.thread_id), [B], "a settled row that does not fit opens the next page instead of being cut");
  assert.equal(small.continuation_token, small.sync_token); assert.equal(small.next_offset, 1);
  const compact = await continueProjectSync(small.sync_token, { byteBudget: 4096, offset: 1 }, f.storage);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 4096); assert.equal(compact.continuation_token, null);
  assert.equal(compact.works[0].details_omitted, true); assert.equal(compact.works[0].observation, "settled");
  assert.deepEqual(compact.works[0].settled, { basis: "excluded", settled_at: row(await f.sync({ byteBudget: 64000 }), A).settled.settled_at });
  const full = await continueProjectSync(small.sync_token, { byteBudget: 64000, offset: 1 }, f.storage);
  assert.equal(full.works[0].settled.reason, reason); assert.equal(full.works[0].details_omitted, undefined);
});

test("project wait does not read settled work and treats neither settling nor exclusion as a change", async t => {
  const f = await fixture(t, { count: 3 });
  const wait = () => { f.calls.length = 0; return waitProject("P", { timeoutMs: 0 }, { storage: f.storage, read: f.read, pollMs: 5,
    processIdentity: async pid => pid === 123 ? "owner-start" : "same-start", orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) }); };
  await f.sync(); await f.stop(A);
  assert.equal((await wait()).reason, "timeout", "stopping alone is not a change"); assert.ok(f.calls.includes(A));
  Object.assign(f.works.get(C), { turn: "turn-next" }); f.works.get(C).events.push({ id: "turn-next", type: "turn", status: "completed" });
  const changed = await wait();
  assert.equal(changed.reason, "work_changed"); assert.equal(row(changed.sync, A).settled.basis, "observed");
  assert.equal((await wait()).reason, "timeout", "a baseline entry for work settled since is not a membership change");
  assert.equal(f.calls.includes(A), false);
  await f.stop(B); f.works.get(B).error = { code: "PAYLOAD_TOO_LARGE" };
  assert.equal((await f.sync({ excludeUnreadable: B, reason: "too large" })).complete, true);
  assert.equal((await wait()).reason, "timeout", "an excluded work does not fail the observation");
  assert.deepEqual([...new Set(f.calls)], [C]);
});

const wait = (f, timeoutMs = 0) => { f.calls.length = 0; return waitProject("P", { timeoutMs }, { storage: f.storage, read: f.read, pollMs: 5,
  processIdentity: async pid => pid === 123 ? "owner-start" : "same-start", orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) }); };
const endTurn = (f, id, turn) => {
  Object.assign(f.works.get(id), { status: "idle", turn, turnStatus: "completed", activeTurns: 0 }); f.works.get(id).events.push({ id: turn, type: "turn", status: "completed" });
};
const unreadable = { code: "PAYLOAD_TOO_LARGE" };

test("a turn that ends after a stop is returned by the next wait, not settled by a partial sync", async t => {
  const f = await fixture(t); f.works.get(B).error = unreadable;
  Object.assign(f.works.get(A), { status: "idle", turnStatus: "inProgress", activeTurns: 1 }); await f.stop(A);
  const running = await wait(f);
  assert.equal(running.reason, "initial_sync"); assert.equal(row(running.sync, A).settled, undefined);
  endTurn(f, A, "turn-final");
  for (const attempt of [1, 2]) {
    const partial = await f.sync();
    assert.equal(partial.complete, false); assert.ok(f.calls.includes(A));
    assert.equal(row(partial, A).settled, undefined, `partial sync ${attempt} leaves the turn end to wait`);
  }
  const returned = await wait(f, 1000);
  assert.equal(returned.reason, "work_changed");
  assert.ok(row(returned.sync, A).events.some(event => event.event_id === "turn-final"), "wait returns the turn end");
  assert.equal(row(returned.sync, A).settled.basis, "observed", "the wait that returns it settles the work");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
});

const ends = [["a question", "question", "human", f => { f.works.get(A).events.push(message("question", { questions: ["Which?"] })); endTurn(f, A, "turn-final"); }],
  ["a failure", "turn-final", "failure", f => { Object.assign(f.works.get(A), { status: "idle", turn: "turn-final", turnStatus: "failed", activeTurns: 0 }); f.works.get(A).events.push({ id: "turn-final", type: "turn", status: "failed" }); }]];
const cites = (work, eventId) => work.events.some(event => event.event_id === eventId);

for (const [what, evidence, attention, end] of ends) {
  test(`a turn that ends with ${what} after a stop is returned by the next wait, which settles the work with it`, async t => {
    const f = await fixture(t); f.works.get(B).error = unreadable;
    Object.assign(f.works.get(A), { status: "idle", turnStatus: "inProgress", activeTurns: 1 }); await f.stop(A);
    assert.equal((await wait(f)).reason, "initial_sync");
    end(f);
    for (const attempt of [1, 2]) {
      const partial = await f.sync();
      assert.equal(partial.complete, false); assert.ok(f.calls.includes(A));
      assert.equal(row(partial, A).attention, attention); assert.ok(cites(row(partial, A), evidence));
      assert.equal(row(partial, A).settled, undefined, `partial sync ${attempt} leaves the turn end to wait`);
    }
    const returned = await wait(f, 1000), settling = row(returned.sync, A);
    assert.equal(returned.reason, "work_changed"); assert.ok(cites(settling, evidence), "wait returns it");
    assert.equal(settling.attention, attention); assert.equal(settling.group, "対応が必要");
    assert.equal(settling.settled.basis, "observed", "the wait that returns it settles the work");
    assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
    const carried = row(await f.sync(), A);
    assert.equal(f.calls.includes(A), false); assert.equal(carried.observation, "settled");
    assert.equal(carried.attention, attention); assert.ok(cites(carried, evidence), "the settled row still cites it");
  });

  test(`a project that never ran wait settles a stopped work whose last turn ended with ${what} in the sync that shows it`, async t => {
    const f = await fixture(t); f.works.get(B).error = unreadable; end(f); await f.stop(A);
    const partial = await f.sync(), settling = row(partial, A);
    assert.equal(partial.complete, false); assert.ok(cites(settling, evidence)); assert.equal(settling.attention, attention);
    assert.equal(settling.settled.basis, "observed");
    const first = await wait(f);
    assert.equal(first.reason, "initial_sync"); assert.equal(f.calls.includes(A), false);
    assert.equal(row(first.sync, A).observation, "settled"); assert.equal(row(first.sync, A).attention, attention); assert.ok(cites(row(first.sync, A), evidence));
  });
}

test("a question a complete sync showed stays on the row of its stopped work, which settles and is not read again", async t => {
  const f = await fixture(t, { count: 3 });
  for (const id of [A, C]) f.works.get(id).events.push(message(`question-${id.slice(-1)}`, { questions: ["Which?"] }));
  const shown = await f.sync(), token = row(shown, A).events[0].token;
  assert.equal(shown.complete, true); assert.equal(row(shown, A).attention, "human");
  await f.stop(A);
  const settling = row(await f.sync(), A);
  assert.ok(f.calls.includes(A)); assert.equal(settling.settled.basis, "observed");
  assert.equal(settling.attention, "human"); assert.equal(settling.group, "対応が必要"); assert.deepEqual(settling.events.map(event => event.token), [token]);
  const attention = (await f.head()).unresolved_attention[A];
  for (const attempt of [1, 2]) {
    const next = await f.sync({ byteBudget: 4096 }), carried = row(next, A);
    assert.equal(f.calls.includes(A), false, `sync ${attempt} after settling`); assert.equal(next.complete, true);
    assert.deepEqual(next.works.map(work => work.thread_id), [C, B, A], "the settled row follows every row still being read");
    assert.equal(carried.observation, "settled"); assert.equal(carried.attention, "human"); assert.equal(carried.group, "対応が必要");
    assert.equal(carried.attention_repeated, true); assert.deepEqual(carried.events.map(event => event.token), [token]);
    assert.deepEqual((await f.head()).unresolved_attention[A], attention);
    await pruneProjectHistory("P", f.storage);
    assert.equal((await projectEvent(token, f.storage)).event.id, "question-1", "prune keeps the evidence the head still cites");
  }
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
  const paged = await f.sync({ byteBudget: 4096 }, { read: async (id, options) => ({ ...(await f.read(id, options)), title: "題".repeat(700) }) });
  assert.deepEqual(paged.works.map(work => work.thread_id), [C, B], "a settled row that needs attention does not take the first page from the rows still being read");
  const rest = await continueProjectSync(paged.sync_token, { byteBudget: 4096, offset: paged.next_offset }, f.storage);
  assert.deepEqual(rest.works.map(work => work.thread_id), [A]); assert.equal(rest.works[0].attention, "human"); assert.equal(rest.continuation_token, null);
});

test("a stopped work with nothing new since the last wait return settles in a partial sync", async t => {
  const f = await fixture(t); f.works.get(B).error = unreadable;
  assert.equal((await wait(f)).reason, "initial_sync");
  endTurn(f, A, "turn-done");
  assert.equal((await wait(f, 1000)).reason, "work_changed");
  assert.equal((await f.sync()).complete, false, "an unchanged read before the stop");
  await f.stop(A);
  const partial = await f.sync();
  assert.equal(partial.complete, false); assert.equal(row(partial, A).settled.basis, "observed");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
});

test("a stopped work whose cursor moved without anything new since the last wait return settles in a partial sync", async t => {
  const f = await fixture(t); f.works.get(B).error = unreadable;
  assert.equal((await wait(f)).reason, "initial_sync");
  // A real cursor also encodes status and title, so a reload moves it without an event.
  f.works.get(A).status = "notLoaded";
  const read = async (id, options) => { const page = await f.read(id, options); return id === A ? { ...page, cursor: `${page.cursor}0` } : page; };
  assert.equal((await f.sync({}, { read })).complete, false);
  assert.notEqual((await getManagedThread(A, f.storage)).sync_cursor, (await f.head()).wait_baseline.works[A].cursor);
  await f.stop(A);
  const partial = await f.sync({}, { read });
  assert.equal(partial.complete, false); assert.deepEqual(row(partial, A).events, []);
  assert.equal(row(partial, A).settled.basis, "observed");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
});

test("an exclusion that completes the sync settles a stopped work whose turn end wait has not returned", async t => {
  const f = await fixture(t); f.works.get(B).error = unreadable; await f.stop(B);
  Object.assign(f.works.get(A), { status: "idle", turnStatus: "inProgress", activeTurns: 1 }); await f.stop(A);
  assert.equal((await wait(f)).reason, "initial_sync");
  endTurn(f, A, "turn-final");
  const excluded = await f.sync({ excludeUnreadable: B, reason: "history exceeds the receive limit" });
  assert.equal(excluded.complete, true); assert.ok(row(excluded, A).events.some(event => event.event_id === "turn-final"));
  assert.equal(row(excluded, A).settled.basis, "observed", "a sync the exclusion completes is a review");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.deepEqual(f.calls, []);
});

test("a complete sync settles a stopped work even when wait has not returned its turn end", async t => {
  const f = await fixture(t);
  Object.assign(f.works.get(A), { status: "idle", turnStatus: "inProgress", activeTurns: 1 }); await f.stop(A);
  assert.equal((await wait(f)).reason, "initial_sync");
  endTurn(f, A, "turn-final");
  const complete = await f.sync();
  assert.equal(complete.complete, true); assert.ok(row(complete, A).events.some(event => event.event_id === "turn-final"));
  assert.equal(row(complete, A).settled.basis, "observed", "a complete sync is a review");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
});

test("a partial sync settles a stopped work when no wait has published a baseline", async t => {
  const f = await fixture(t); f.works.get(B).error = unreadable; await f.stop(A); endTurn(f, A, "turn-final");
  const partial = await f.sync();
  assert.equal(partial.complete, false); assert.equal(row(partial, A).settled.basis, "observed");
  const first = await wait(f);
  assert.equal(first.reason, "initial_sync"); assert.equal(row(first.sync, A).observation, "settled"); assert.equal(f.calls.includes(A), false);
});

test("a stopped work the last wait return could not read is returned by wait before it settles", async t => {
  const f = await fixture(t, { count: 3 }); f.works.get(A).error = unreadable; f.works.get(B).error = unreadable;
  assert.equal((await wait(f)).reason, "initial_sync");
  f.works.get(A).error = null; await f.stop(A);
  const partial = await f.sync();
  assert.equal(partial.complete, false); assert.equal(row(partial, A).complete, true);
  assert.equal(row(partial, A).settled, undefined, "work the wait never read in full is new to it");
  const returned = await wait(f, 1000);
  assert.equal(returned.reason, "work_changed"); assert.equal(row(returned.sync, A).settled.basis, "observed");
  assert.equal((await wait(f, 30)).reason, "timeout"); assert.equal(f.calls.includes(A), false);
});

test("settled work whose stop can no longer be confirmed is read again", async t => {
  const f = await fixture(t); await f.stop(A); await f.sync(); await f.sync(); assert.equal(f.calls.includes(A), false);
  await writeRecord("supervisors", A, { schema: 1, thread_id: A, state: "broken" }, f.storage);
  const invalid = await f.sync();
  assert.ok(f.calls.includes(A), "an invalid supervisor record neither hides the work nor fails the sync");
  assert.equal(invalid.complete, true); assert.equal(row(invalid, A).settled, undefined); assert.equal((await f.head()).settled, undefined);
  await removeRecord("supervisors", A, f.storage); await f.sync();
  assert.ok(f.calls.includes(A), "a missing binding is not a stop");
});

test("both CLIs reject excluding supervised work and combining the flag with --continue, without a backend", async t => {
  const f = await fixture(t);
  for (const connection of [[], ["--connection", "desktop-cloud"]]) {
    const run = (...args) => spawnSync(process.execPath, ["bin/codexteer.mjs", ...connection, "project", "sync", ...args, "--json"],
      { cwd: new URL("../", import.meta.url), env: { ...process.env, CODEX_HOME: f.storage.home }, encoding: "utf8" });
    const supervised = run("--project", "P", "--exclude-unreadable", A, "--reason", "too large");
    assert.notEqual(supervised.status, 0); assert.equal(JSON.parse(supervised.stdout).error.code, "PROJECT_SYNC_EXCLUDE_NOT_STOPPED");
    const unpaired = run("--project", "P", "--exclude-unreadable", A);
    assert.notEqual(unpaired.status, 0); assert.equal(JSON.parse(unpaired.stdout).error.code, "PROJECT_SYNC_INVALID");
    const continued = run("--continue", uuid(9), "--exclude-unreadable", A, "--reason", "too large");
    assert.notEqual(continued.status, 0); assert.match(JSON.parse(continued.stdout).error.code, /OPTIONS_INVALID$/);
    assert.equal(await f.head(), null);
  }
});
