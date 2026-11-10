import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { getMessage } from "../src/journal.mjs";
import { getFinding } from "../src/findings.mjs";
import { readRecord, writeRecord } from "../src/store.mjs";

const THREAD = "11111111-1111-4111-8111-121212121212", OTHER = "11111111-1111-4111-8111-343434343434", SESSION = "22222222-2222-4222-8222-121212121212";
const policyHash = text => createHash("sha256").update(text).digest("hex");
const task = (items = [], flags = []) => ({ id: THREAD, name: "fixture", status: { type: "active", activeFlags: flags }, turns: [{ id: "turn-one", status: "inProgress", items: [{ id: "user-one", type: "userMessage", content: [{ type: "text", text: "original delegation" }] }, ...items] }] });

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-tell-home-")), root = await mkdtemp(tempPrefix("ct-tell-root-")), policy = "Keep changes focused.\n";
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  await writeFile(`${root}/CODEXTEER.md`, policy); let current = task();
  const initial = readSnapshot(current).cursor;
  await registerManagedThread(THREAD, { projectId: "project-tell", connection: "shared", syncCursor: initial, policySha256: policyHash(policy) }, { home });
  await registerSupervisor(THREAD, SESSION, { home, owner: "fixture", connection: "shared" });
  await writeRecord("work-starts", "fixture", { schema: 1, thread_id: THREAD, root, created_at: new Date().toISOString() }, { home });
  const read = async (_id, options) => readSnapshot(current, { since: options.since, limit: options.limit });
  await syncProject("project-tell", {}, { storage: { home }, read });
  return { home, root, read, get current() { return current; }, set current(value) { current = value; } };
}

async function pair(t, otherCursor) {
  const f = await fixture(t), other = { ...task(), id: OTHER };
  await registerManagedThread(OTHER, { projectId: "project-tell", connection: "shared", syncCursor: otherCursor ?? readSnapshot(other).cursor }, { home: f.home });
  f.other = other; f.readAll = async (id, options) => id === OTHER ? readSnapshot(f.other, { since: options.since, limit: options.limit }) : f.read(id, options);
  f.sync = (read = f.readAll) => syncProject("project-tell", {}, { storage: f, read });
  return f;
}
const accepted = options => ({ sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-one" });
const accept = f => async (_id, _wire, options) => { await options.beforeSend(f.current); return accepted(options); };
const targetFails = f => (id, options) => id === THREAD ? Promise.reject(Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED" })) : f.readAll(id, options);
const targetAsksThenFails = f => { let calls = 0; return async (id, options) => {
  if (id !== THREAD) return f.readAll(id, options);
  if (++calls > 1) throw Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED" });
  return { ...await f.read(id, options), cursor: "question-1", has_more: true, events: [{ id: "unanswered", type: "agentMessage", text: "Choose", questions: ["A or B?"] }] };
}; };

test("work tell creates internal finding and journal evidence without public supervision metadata", async t => {
  const f = await fixture(t); let dispatches = 0;
  const result = await tellWork(THREAD, "Review and fix the failing test.", {}, { storage: f, read: f.read, send: async (_id, wire, options) => {
    await options.beforeSend(f.current); dispatches++; assert.match(wire, /送信者: codexteer/); assert.match(wire, /種類: レビュー/);
    return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-one" };
  } });
  assert.equal(dispatches, 1); assert.equal(result.source, "codexteer"); assert.equal(result.kind, "review"); assert.equal(result.policy.changed, false);
  const message = await getMessage(THREAD, result.message_id, { home: f.home }), finding = await getFinding(THREAD, result.finding_id, { home: f.home });
  assert.equal(message.metadata.source, "codexteer"); assert.equal(message.metadata.kind, "review"); assert.equal(message.metadata.finding_id, finding.id); assert.equal(message.body, "Review and fix the failing test.");
  await assert.rejects(tellWork(THREAD, "Review and fix the failing test.", {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code: "DUPLICATE_INTERVENTION" });
  assert.equal(dispatches, 1);
});

test("stale events, new user input, and human attention all refuse delivery", async t => {
  for (const [name, change, code] of [
    ["event", () => task([{ id: "agent-new", type: "agentMessage", text: "new progress" }]), "WORK_TELL_STALE_SYNC"],
    ["user", () => task([{ id: "user-new", type: "userMessage", content: [{ type: "text", text: "changed request" }] }]), "WORK_TELL_STALE_SYNC"],
    ["approval", () => task([], ["waitingOnApproval"]), "WORK_TELL_HUMAN_REQUIRED"],
  ]) {
    const f = await fixture(t); f.current = change(); let dispatches = 0;
    await assert.rejects(tellWork(THREAD, `tell ${name}`, {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code });
    assert.equal(dispatches, 0);
  }
  const unknown = await fixture(t), observed = await unknown.read(THREAD, { since: (await getManagedThread(THREAD, unknown)).sync_cursor, limit: 1000 });
  await assert.rejects(tellWork(THREAD, "attention unknown", {}, { storage: unknown, read: async () => ({ ...observed, attention: undefined }) }), { code: "WORK_TELL_ATTENTION_UNKNOWN" });
});

test("incomplete sync, stale token, and competing bases refuse delivery", async t => {
  const f = await fixture(t); let dispatches = 0;
  await syncProject("project-tell", {}, { storage: f, read: async () => { throw Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED" }); } });
  await assert.rejects(tellWork(THREAD, "blocked", {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code: "WORK_TELL_SYNC_INCOMPLETE" });
  assert.equal(dispatches, 0);

  const fresh = await fixture(t), oldToken = "33333333-3333-4333-8333-121212121212";
  await assert.rejects(tellWork(THREAD, "stale token", { syncToken: oldToken }, { storage: fresh, read: fresh.read }), { code: "WORK_TELL_SYNC_CONFLICT" });
  const projectKey = createHash("sha256").update("project-tell").digest("hex").slice(0, 40), head = await readRecord("project-sync-heads", projectKey, fresh);
  await writeRecord("project-sync-heads", projectKey, { ...head, conflict_tokens: [oldToken, head.sync_token] }, fresh);
  await assert.rejects(tellWork(THREAD, "parallel sync", {}, { storage: fresh, read: fresh.read }), { code: "WORK_TELL_SYNC_TOKEN_REQUIRED" });
});

test("an unreadable member does not block work tell to a completely read member", async t => {
  const f = await pair(t, "broken"), sync = await f.sync();
  assert.equal(sync.complete, false); assert.equal(sync.works.find(work => work.thread_id === OTHER).complete, false);
  const receipt = await tellWork(THREAD, "continue the healthy work", {}, { storage: f, read: f.readAll, send: accept(f) });
  assert.equal(receipt.sent, true); assert.equal(receipt.sync_token, sync.sync_token);
  assert.deepEqual(receipt.other_work, { incomplete: [OTHER], human_attention: [], membership_changed: false });
  await assert.rejects(tellWork(OTHER, "unread target", {}, { storage: f, read: f.readAll, send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_SYNC_INCOMPLETE" });
});

test("the receipt reports other members that are unread, waiting for a human, or registered after the sync", async t => {
  const clean = await pair(t); await clean.sync();
  assert.deepEqual((await tellWork(THREAD, "clean project", {}, { storage: clean, read: clean.readAll, send: accept(clean) })).other_work, { incomplete: [], human_attention: [], membership_changed: false });
  const asking = await pair(t); asking.other = { ...task([], ["waitingOnApproval"]), id: OTHER }; await asking.sync();
  assert.deepEqual((await tellWork(THREAD, "other asks", {}, { storage: asking, read: asking.readAll, send: accept(asking) })).other_work, { incomplete: [], human_attention: [OTHER], membership_changed: false });
  const added = await fixture(t);
  await registerManagedThread(OTHER, { projectId: "project-tell", connection: "shared", syncCursor: readSnapshot({ ...task(), id: OTHER }).cursor }, { home: added.home });
  assert.deepEqual((await tellWork(THREAD, "member added", {}, { storage: added, read: added.read, send: accept(added) })).other_work, { incomplete: [OTHER], human_attention: [], membership_changed: true });
});

test("settled members are not reported as unread; an excluded member's open question still is", async t => {
  const idle = { id: OTHER, name: "other", status: { type: "idle" }, turns: [{ id: "turn-other", status: "completed", items: [] }] };
  const quiet = await pair(t, readSnapshot(idle).cursor); quiet.other = idle;
  await registerSupervisor(OTHER, SESSION.replace(/1212$/, "3434"), { home: quiet.home, owner: "fixture", connection: "shared" }); await controlSupervisor(OTHER, "stop", quiet);
  assert.equal((await quiet.sync()).works.find(work => work.thread_id === OTHER).settled.basis, "observed"); await quiet.sync();
  assert.deepEqual((await tellWork(THREAD, "observed settled", {}, { storage: quiet, read: quiet.readAll, send: accept(quiet) })).other_work, { incomplete: [], human_attention: [], membership_changed: false });

  const asking = await pair(t); asking.other = { ...task([], ["waitingOnApproval"]), id: OTHER }; await asking.sync();
  await registerSupervisor(OTHER, SESSION.replace(/1212$/, "3434"), { home: asking.home, owner: "fixture", connection: "shared" }); await controlSupervisor(OTHER, "stop", asking);
  const unreadable = (id, options) => id === OTHER ? Promise.reject(Object.assign(new Error("too large"), { code: "PAYLOAD_TOO_LARGE" })) : asking.readAll(id, options);
  const excluded = await syncProject("project-tell", { excludeUnreadable: OTHER, reason: "history exceeds the receive limit" }, { storage: asking, read: unreadable });
  assert.equal(excluded.exclude_unreadable.outcome, "excluded"); assert.equal(excluded.works.find(work => work.thread_id === OTHER).complete, false);
  assert.deepEqual((await tellWork(THREAD, "excluded settled", {}, { storage: asking, read: asking.readAll, send: accept(asking) })).other_work, { incomplete: [], human_attention: [OTHER], membership_changed: false });
  await asking.sync(unreadable);
  assert.deepEqual((await tellWork(THREAD, "excluded carried", {}, { storage: asking, read: asking.readAll, send: accept(asking) })).other_work, { incomplete: [], human_attention: [OTHER], membership_changed: false });
});

test("an older sync token stays a valid basis until the target is completely read again", async t => {
  const f = await pair(t), first = await f.sync(), second = await f.sync(targetFails(f));
  assert.equal(second.works.find(work => work.thread_id === THREAD).complete, false);
  await assert.rejects(tellWork(THREAD, "latest sync did not read the target", {}, { storage: f, read: f.readAll, send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_SYNC_INCOMPLETE" });
  const receipt = await tellWork(THREAD, "reviewed on the older sync", { syncToken: first.sync_token }, { storage: f, read: f.readAll, send: accept(f) });
  assert.equal(receipt.sent, true); assert.equal(receipt.sync_token, first.sync_token);
  const third = await f.sync(); assert.equal(third.complete, true);
  await assert.rejects(tellWork(THREAD, "target was read again", { syncToken: first.sync_token }, { storage: f, read: f.readAll, send: async () => assert.fail("dispatch") }),
    error => error.code === "WORK_TELL_SYNC_CONFLICT" && error.current_sync_token === third.sync_token);
});

test("a question seen by a newer incomplete read of the target refuses an older basis", async t => {
  const f = await pair(t), first = await f.sync(), second = await f.sync(targetAsksThenFails(f));
  assert.equal(second.works.find(work => work.thread_id === THREAD).complete, false);
  assert.equal((await getManagedThread(THREAD, f)).sync_revision, first.works.find(work => work.thread_id === THREAD).sync_revision);
  await assert.rejects(tellWork(THREAD, "choose A", { syncToken: first.sync_token }, { storage: f, read: f.readAll, send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_HUMAN_REQUIRED" });
});

test("a project sync published during delivery refuses only when it concerns the target", async t => {
  for (const [name, concurrent, code] of [["other member only", targetFails, null], ["question on target", targetAsksThenFails, "WORK_TELL_HUMAN_REQUIRED"], ["target read again", f => f.readAll, "WORK_TELL_SYNC_CONFLICT"]]) {
    const f = await pair(t), basis = await f.sync(); let dispatches = 0, replaced;
    const pending = tellWork(THREAD, `race: ${name}`, {}, { storage: f, read: f.readAll, send: async (_id, _wire, options) => {
      replaced = await f.sync(concurrent(f)); await options.beforeSend(f.current); dispatches++; return accepted(options);
    } });
    if (code) await assert.rejects(pending, { code }); else assert.equal((await pending).sync_token, basis.sync_token);
    assert.notEqual(replaced.sync_token, basis.sync_token); assert.equal(dispatches, code ? 0 : 1);
  }
});

test("pause and acknowledged stop prevent dispatch", async t => {
  for (const action of ["pause", "stop"]) {
    const f = await fixture(t); await controlSupervisor(THREAD, action, f); let dispatches = 0;
    await assert.rejects(tellWork(THREAD, `after ${action}`, {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code: action === "pause" ? "SUPERVISOR_PAUSED" : "SUPERVISOR_STOPPED" });
    assert.equal(dispatches, 0);
  }
});

test("work tell delivery receipt is linearized with pause and acknowledged stop", async t => {
  const f = await fixture(t); let enteredResolve, release, dispatches = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const pending = tellWork(THREAD, "first intent", {}, { storage: f, read: f.read, send: async (_id, _wire, options) => {
    await options.beforeSend(f.current); enteredResolve(); await gate; dispatches++; return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-one" };
  } });
  await entered; await assert.rejects(controlSupervisor(THREAD, "pause", f), { code: "RECORD_BUSY" });
  release(); await pending; assert.equal(dispatches, 1); assert.equal((await controlSupervisor(THREAD, "stop", f)).state, "stopped");
  await assert.rejects(tellWork(THREAD, "second intent", {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code: "SUPERVISOR_STOPPED" });
  assert.equal(dispatches, 1);
});

test("unknown delivery is reconciled read-only once and duplicate intent is never resent", async t => {
  const f = await fixture(t); let dispatches = 0, reconciles = 0;
  const deps = { storage: f, read: f.read, reconcile: async id => { reconciles++; return { message_id: id, status: "not_observed" }; }, send: async (_id, _wire, options) => {
    await options.beforeSend(f.current); dispatches++; throw Object.assign(new Error("lost receipt"), { uncertain: true });
  } };
  await assert.rejects(tellWork(THREAD, "same intent", {}, deps), error => error.delivery_status === "unknown" && error.reconciliation.status === "not_observed");
  assert.equal(dispatches, 1); assert.equal(reconciles, 1);
  await assert.rejects(tellWork(THREAD, "same intent", {}, deps), { code: "DUPLICATE_INTERVENTION" });
  assert.equal(dispatches, 1);
});

test("policy drift is reported but never injected into the existing task", async t => {
  const f = await fixture(t); await writeFile(`${f.root}/CODEXTEER.md`, "Changed policy; do not auto-send me.\n"); let wire;
  const result = await tellWork(THREAD, "ordinary reviewed instruction", {}, { storage: f, read: f.read, send: async (_id, text, options) => {
    await options.beforeSend(f.current); wire = text; return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-one" };
  } });
  assert.equal(result.policy.changed, true); assert.doesNotMatch(wire, /Changed policy/);
});

test("work tell rejects a cursor revision change after sync", async t => {
  const { updateManagedThreadCursor } = await import("../src/project-index.mjs");
  const f = await fixture(t), member = await getManagedThread(THREAD, f);
  await updateManagedThreadCursor(THREAD, member.sync_cursor, member.sync_cursor, f, member.sync_revision);
  await assert.rejects(tellWork(THREAD, "do not send", {}, { storage: f, read: f.read, send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_SYNC_CONFLICT" });
});

test("work tell cannot answer a retained question absent from the final sync page", async t => {
  const f = await fixture(t); let count = 0;
  await syncProject("project-tell", {}, { storage: f, read: async id => {
    const base = await f.read(id, { since: (await getManagedThread(id, f)).sync_cursor, limit: 1000 });
    return { ...base, cursor: `question-${Math.min(++count, 2)}`, has_more: count === 1,
      events: count === 1 ? [{ id: "unanswered", type: "agentMessage", text: "Choose", questions: ["A or B?"] }] : [] };
  } });
  await assert.rejects(tellWork(THREAD, "choose A", {}, { storage: f, read: f.read, send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_HUMAN_REQUIRED" });
});

test("work tell refuses human attention on any freshness page", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(tellWork(THREAD, "never answer approval", {}, { storage: f, read: async id => ({ thread_id: id,
    cursor: `fresh-${++calls}`, has_more: calls === 1, events: [], attention: calls === 1 ? ["waitingOnApproval"] : [], active_turn_id: "turn-one" }),
    send: async () => assert.fail("dispatch") }), { code: "WORK_TELL_HUMAN_REQUIRED" });
});
