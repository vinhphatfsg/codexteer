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

const THREAD = "11111111-1111-4111-8111-121212121212", SESSION = "22222222-2222-4222-8222-121212121212";
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

test("incomplete sync, stale token, and membership generation conflict refuse delivery", async t => {
  const f = await fixture(t); let dispatches = 0;
  await syncProject("project-tell", {}, { storage: f, read: async () => { throw Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED" }); } });
  await assert.rejects(tellWork(THREAD, "blocked", {}, { storage: f, read: f.read, send: async () => { dispatches++; } }), { code: "WORK_TELL_SYNC_INCOMPLETE" });
  assert.equal(dispatches, 0);

  const fresh = await fixture(t), oldToken = "33333333-3333-4333-8333-121212121212";
  await assert.rejects(tellWork(THREAD, "stale token", { syncToken: oldToken }, { storage: fresh, read: fresh.read }), { code: "WORK_TELL_SYNC_CONFLICT" });
  const projectKey = createHash("sha256").update("project-tell").digest("hex").slice(0, 40), head = await readRecord("project-sync-heads", projectKey, fresh);
  await writeRecord("project-sync-heads", projectKey, { ...head, conflict_tokens: [oldToken, head.sync_token] }, fresh);
  await assert.rejects(tellWork(THREAD, "parallel sync", {}, { storage: fresh, read: fresh.read }), { code: "WORK_TELL_SYNC_TOKEN_REQUIRED" });
  const changed = await fixture(t);
  const other = "11111111-1111-4111-8111-343434343434", cursor = readSnapshot({ ...task(), id: other }).cursor;
  await registerManagedThread(other, { projectId: "project-tell", connection: "shared", syncCursor: cursor }, { home: changed.home });
  await assert.rejects(tellWork(THREAD, "membership changed", {}, { storage: changed, read: changed.read }), { code: "WORK_TELL_MEMBERSHIP_CHANGED" });
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
