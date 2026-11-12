import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject, projectEvent, continueProjectSync } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { startWork } from "../src/work-start.mjs";
import { pruneProjectHistory, withHistoryReservation, HISTORY_LOCK_WAIT_MS } from "../src/project-history.mjs";
import { readRecord, writeRecord, storePath, withStoreLock } from "../src/store.mjs";

const P = "alpha", Q = "beta";
const message = size => ({ id: randomUUID(), type: "agentMessage", text: "x".repeat(size) });
const idle = (id, items = []) => ({ id, name: id, status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed", items }] });
const key = project => createHash("sha256").update(project).digest("hex").slice(0, 40);
const syncLock = project => `project-sync-${key(project)}`, historyLock = project => `project-history-${key(project)}`;
const tokens = page => page.works.flatMap(work => [work.detail_token, ...work.events.map(event => event.token)]).filter(Boolean);
// Every token a page names at any depth of its rows.
const named = (value, found = []) => {
  if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) {
    if (["token", "detail_token"].includes(name) && typeof child === "string") found.push(child); else named(child, found);
  }
  return found;
};
const outcome = promise => promise.then(page => page.publication_conflict ? `conflict:${page.publication_conflict}` : `published:${page.complete}`, error => `thrown:${error.code}`);

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-sync-busy-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, f = { home, storage, threads: new Map(), member: { [P]: randomUUID(), [Q]: randomUUID() } };
  await writeFile(path.join(home, "CODEXTEER.md"), "Keep scope.\n");
  for (const project of [P, Q]) {
    const id = f.member[project], thread = idle(id); f.threads.set(id, thread);
    await registerManagedThread(id, { projectId: project, connection: "shared", syncCursor: readSnapshot(thread).cursor }, storage);
    await registerSupervisor(id, randomUUID(), { home, owner: "fixture", connection: "shared" });
  }
  f.read = async (id, options) => { await f.onRead?.(id); return readSnapshot(f.threads.get(id), options); };
  f.dependencies = { storage, read: f.read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  f.add = (project, count = 1, size = 64) => f.threads.get(f.member[project]).turns[0].items.push(...Array.from({ length: count }, () => message(size)));
  // A turn that ended: the change a wait returns.
  f.turn = project => { const { turns } = f.threads.get(f.member[project]); turns.push({ id: `turn-${turns.length + 1}`, status: "completed", items: [message(64)] }); };
  f.sync = project => syncProject(project, {}, f.dependencies);
  f.wait = project => waitProject(project, { timeoutMs: 0 }, f.dependencies);
  f.start = (project, title, created = () => {}) => {
    const id = randomUUID(); f.threads.set(id, idle(id, [message(64)]));
    return startWork({ project, title, order: "inspect", root: home }, { storage, create: async () => { created(); return { thread_id: id }; }, read: f.read });
  };
  f.cursor = async project => (await getManagedThread(f.member[project], storage)).sync_cursor;
  f.head = project => readRecord("project-sync-heads", key(project), storage);
  // Superseded results and events, so that a prune has work to do.
  f.history = async (project, rounds) => { for (let i = 0; i < rounds; i++) { f.add(project, 4); await f.sync(project); } };
  return f;
}
const held = (f, name) => lstat(storePath("locks", name, f.home)).then(() => true, () => false);
// Holds the named locks, outermost first, until the returned function is called.
async function hold(f, names) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const holder = names.reduceRight((inner, name) => () => withStoreLock(name, inner, f.storage), async () => { enter(); await gate; })();
  await entered;
  return async () => { release(); await holder; };
}
// Starts a prune from inside the publication's last read and returns to the
// read once the prune holds the project's history lock.
function pruneDuringRead(f, project) {
  const overlap = { prune: null };
  f.onRead = async () => {
    f.onRead = null; overlap.prune = pruneProjectHistory(project, f.storage);
    while (!await held(f, historyLock(project))) await delay(1);
  };
  return overlap;
}

test("a sync whose publication meets one prune of its project waits for it and publishes", async t => {
  const f = await fixture(t); await f.history(P, 40);
  f.add(P); const before = await f.cursor(P), overlap = pruneDuringRead(f, P);
  const page = await f.sync(P), pruned = await overlap.prune;
  assert.equal(page.complete, true); assert.equal(page.publication_conflict, undefined); assert.equal(page.history_unsaved, undefined);
  assert.ok(pruned.deleted.results >= 39, "the prune ran in full");
  assert.notEqual(await f.cursor(P), before); assert.equal((await f.head(P)).sync_token, page.sync_token);
  for (const token of tokens(page)) assert.ok(await projectEvent(token, f.storage));
});

test("a wait whose publication meets one prune of its project returns the change", async t => {
  const f = await fixture(t); await f.wait(P); await f.history(P, 40);
  f.turn(P); const overlap = pruneDuringRead(f, P);
  const waited = await f.wait(P); await overlap.prune;
  assert.equal(waited.reason, "work_changed"); assert.equal(waited.changed, true);
  assert.equal(waited.sync.complete, true); assert.equal(waited.sync.publication_conflict, undefined);
  assert.equal((await f.head(P)).wait_sync_token, waited.sync.sync_token);
});

test("prunes running back to back never make a sync throw or lose its publication", async t => {
  const f = await fixture(t); await f.sync(P);
  // Prunes that follow each other without a pause leave the locks free for an
  // instant only; the bound is for one prune, so this takes it out of the way.
  f.storage.historyLockWaitMs = 300_000;
  let stop = false; const outcomes = {};
  const pruner = (async () => { while (!stop) await pruneProjectHistory(P, f.storage).catch(error => assert.equal(error.code, "RECORD_BUSY")); })();
  for (let i = 0; i < 12; i++) { f.add(P); const result = await outcome(f.sync(P)); outcomes[result] = (outcomes[result] ?? 0) + 1; }
  stop = true; await pruner;
  assert.deepEqual(outcomes, { "published:true": 12 });
});

test("a publication lock held past the bound leaves the conflict path, which saves its result as before", async t => {
  const f = await fixture(t); await f.sync(P); f.storage.historyLockWaitMs = 40;
  f.add(P); const before = await f.cursor(P), earlier = await f.head(P), release = await hold(f, [syncLock(P)]), started = performance.now();
  const page = await f.sync(P), elapsed = performance.now() - started; await release();
  assert.equal(page.publication_conflict, "RECORD_BUSY"); assert.equal(page.complete, false); assert.equal(page.history_unsaved, undefined);
  assert.ok(elapsed >= 40, `waited for the bound: ${elapsed}`);
  assert.ok(tokens(page).length); for (const token of tokens(page)) assert.ok(await projectEvent(token, f.storage));
  assert.ok(await continueProjectSync(page.sync_token, {}, f.storage));
  assert.equal(await f.cursor(P), before); assert.deepEqual(await f.head(P), earlier);
  assert.equal((await f.sync(P)).complete, true);
});

test("a history lock held past the bound returns an unsaved conflict that names no token, and the change stays owed", async t => {
  const f = await fixture(t); await f.wait(P); f.storage.historyLockWaitMs = 40;
  f.turn(P); const before = await f.cursor(P), earlier = await f.head(P), release = await hold(f, [historyLock(P)]), started = performance.now();
  const page = await f.sync(P), elapsed = performance.now() - started;
  assert.equal(page.publication_conflict, "RECORD_BUSY"); assert.equal(page.history_unsaved, true); assert.equal(page.complete, false);
  assert.equal(page.sync_token, null); assert.equal(page.continuation_token, null); assert.equal(page.continuation_command, null);
  assert.deepEqual(named(page), [], "nothing this result names was saved");
  assert.equal(page.works[0].complete, false); assert.equal(page.works[0].error, "PROJECT_SYNC_CONFLICT");
  assert.ok(elapsed >= 40 && elapsed < 5000, `one bound for both paths: ${elapsed}`);
  assert.equal(await f.cursor(P), before); assert.deepEqual(await f.head(P), earlier);

  const waited = await f.wait(P);
  assert.equal(waited.reason, "observation_failed"); assert.equal(waited.changed, false); assert.equal(waited.timed_out, false);
  assert.equal(waited.sync.publication_conflict, "RECORD_BUSY"); assert.equal(waited.sync.history_unsaved, true);
  assert.equal(await f.cursor(P), before); assert.deepEqual(await f.head(P), earlier);
  assert.equal(await readRecord("project-waits", key(P), f.storage), null, "the wait ended normally and released the project");

  await release();
  const next = await f.wait(P);
  assert.equal(next.reason, "work_changed"); assert.equal(next.sync.complete, true); assert.equal(next.sync.publication_conflict, undefined);
  assert.ok(next.sync.works[0].events.some(event => event.type === "turn"), "the change the busy lock held back");
});

test("an unsaved conflict still names the earlier question, whose record was saved before", async t => {
  const f = await fixture(t);
  f.threads.get(f.member[P]).turns[0].items.push({ ...message(64), questions: ["Which?"] });
  const question = (await f.sync(P)).works[0].events[0].token;
  f.add(P); f.storage.historyLockWaitMs = 20;
  const release = await hold(f, [historyLock(P)]), page = await f.sync(P); await release();
  assert.equal(page.history_unsaved, true); assert.deepEqual([...new Set(named(page))], [question]);
  assert.equal(page.sync_token, null); assert.equal(page.continuation_token, null);
  assert.equal((await projectEvent(question, f.storage)).event.questions[0], "Which?");
});

test("two syncs of one project publishing together: one publishes, the other waits and reports the newer head", async t => {
  const f = await fixture(t); await f.sync(P);
  for (let round = 0; round < 10; round++) {
    f.add(P);
    const outcomes = await Promise.all([outcome(f.sync(P)), outcome(f.sync(P))]);
    assert.deepEqual(outcomes.sort(), ["conflict:SYNC_CURSOR_CONFLICT", "published:true"]);
  }
});

test("a dead owner's history and publication locks are recovered at once, not waited for", async t => {
  const f = await fixture(t); await f.sync(P);
  for (const name of [syncLock(P), historyLock(P)]) await writeRecord("locks", name, { token: randomUUID(), pid: spawnSync(process.execPath, ["-e", ""]).pid }, f.storage);
  f.add(P); const started = performance.now(), page = await f.sync(P);
  assert.equal(page.complete, true); assert.equal(page.publication_conflict, undefined);
  assert.ok(performance.now() - started < HISTORY_LOCK_WAIT_MS / 2);
});

test("another project's locks and the previous version's shared history lock never delay a publication", async t => {
  const f = await fixture(t); await f.sync(P); await f.wait(P);
  const release = await hold(f, [syncLock(Q), historyLock(Q), "project-history"]);
  f.add(P); const started = performance.now();
  const page = await f.sync(P);
  assert.equal(page.complete, true); assert.equal(page.publication_conflict, undefined);
  f.turn(P); const waited = await f.wait(P);
  assert.equal(waited.reason, "work_changed"); assert.equal(waited.sync.publication_conflict, undefined);
  assert.ok(performance.now() - started < HISTORY_LOCK_WAIT_MS / 2, "no wait for a lock that is not this project's");
  await release();
});

test("a publication, a prune and a work start of one project, overlapping in every order, all end", async t => {
  const f = await fixture(t); await f.sync(P);
  const counts = {}, orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const prune = () => pruneProjectHistory(P, f.storage).then(result => result.publication_in_progress ? "deferred" : "pruned", error => `thrown:${error.code}`);
  const start = (round, created) => f.start(P, `work ${round}`, created).then(() => "started", error => `thrown:${error.code}`);
  for (let round = 0; round < 24; round++) {
    f.add(P);
    const [first, second, third] = orders[round % 6], after = (turn, run) => delay(turn * (1 + round % 4)).then(run);
    let synced, pruned = null, started;
    // Every third round the publication begins between two saves of the work start.
    if (round % 3 === 2) { started = await start(round, () => { synced = outcome(f.sync(P)); }); synced = await synced; }
    else [synced, pruned, started] = await Promise.all([after(first, () => outcome(f.sync(P))), after(second, prune), after(third, () => start(round))]);
    assert.match(synced, /^published:/, "complete or not, as the work start's new member was read or not");
    assert.ok([null, "pruned", "deferred", "thrown:RECORD_BUSY"].includes(pruned), pruned);
    assert.ok(["started", "thrown:RECORD_BUSY"].includes(started), started);
    for (const result of [...(pruned ? [`prune ${pruned}`] : []), `start ${started}`]) counts[result] = (counts[result] ?? 0) + 1;
    await f.sync(P);
  }
  t.diagnostic(JSON.stringify(counts));
});
