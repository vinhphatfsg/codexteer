import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, chmod } from "node:fs/promises";
import { sendTrackedMessage, getMessage, listMessages, reconcileMessages, markMessage } from "../src/journal.mjs";
import { readRecord, writeRecord, withStoreLock, storePath } from "../src/store.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
async function fixture(t) { const home = await mkdtemp("/private/tmp/cs-journal-"); t.after(() => rm(home, { recursive: true, force: true })); return { home }; }
const accepted = async (threadId, text, options) => ({ thread_id: threadId, turn_id: "turn", client_message_id: options.clientMessageId, sent: true, delivery_status: "accepted" });

test("journal is written before sending; plain wire text and receipt ID are preserved", async t => {
  const storage = await fixture(t);
  const r = await sendTrackedMessage(ID, "private body", {}, { ...storage, send: async (id, body, options) => {
    assert.equal(body, "private body");
    const entry = await readRecord("messages", options.clientMessageId, storage);
    assert.equal(entry.attempt_state, "prepared"); assert.equal(entry.sent, null);
    return accepted(id, body, options);
  } });
  assert.equal(r.message_id, r.client_message_id);
  assert.equal((await getMessage(ID, r.message_id, storage)).body, "private body");
  assert.equal(JSON.stringify(await listMessages(ID, storage)).includes("private body"), false);
  assert.equal((await stat(storePath("messages", r.message_id, storage.home))).mode & 0o777, 0o600);
  assert.equal((await stat(storePath("messages", null, storage.home))).mode & 0o777, 0o700);
});

test("unknown delivery retains ID and is reconciled by ID and body without resending", async t => {
  const storage = await fixture(t); let count = 0, error;
  await assert.rejects(sendTrackedMessage(ID, "line1\nline2", {}, { ...storage, send: async () => { count++; throw Object.assign(new Error("unknown"), { sent: null, delivery_status: "unknown" }); } }), e => { error = e; return true; });
  assert.equal((await getMessage(ID, error.message_id, storage)).sent, null);
  let closed = false;
  const transport = { discover: async () => ({ paths: { socket: "unused" } }), connect: async () => ({ close() { closed = true; }, request: async method => {
    assert.equal(method, "thread/read"); return { thread: { id: ID, turns: [{ id: "turn", items: [{ type: "userMessage", id: "item", clientId: error.client_message_id, content: [{ type: "text", text: "line1\nline2" }] }] }] } };
  } }) };
  const entries = await reconcileMessages(ID, error.message_id, storage, transport);
  assert.equal(entries[0].verification.status, "stored"); assert.equal(entries[0].delivery_status, "accepted"); assert.equal(entries[0].response.status, "unreported");
  assert.equal(count, 1); assert.equal(closed, true);
});

test("duplicate or mismatched history is conflict; absence never becomes proof of non-delivery", async t => {
  const storage = await fixture(t); const r = await sendTrackedMessage(ID, "original", {}, { ...storage, send: accepted });
  for (const texts of [[], ["different"], ["original", "original"]]) {
    const entries = await reconcileMessages(ID, r.message_id, storage, { discover: async () => ({ paths: { socket: "x" } }), connect: async () => ({ close() {}, request: async () => ({ thread: { id: ID, turns: [{ id: "t", items: texts.map((text, i) => ({ id: String(i), type: "userMessage", clientId: r.client_message_id, content: [{ type: "text", text }] })) }] } }) }) });
    assert.equal(entries[0].verification.status, texts.length ? "conflict" : "not_observed"); assert.equal(entries[0].delivery_status, "accepted");
  }
});

test("reported application requires evidence, keeps reports and is distinct from delivery", async t => {
  const storage = await fixture(t); const r = await sendTrackedMessage(ID, "test", {}, { ...storage, send: accepted });
  await assert.rejects(markMessage(ID, r.message_id, { ...storage, status: "applied", note: "done" }), /evidence/);
  await markMessage(ID, r.message_id, { ...storage, status: "acknowledged", note: "will check", by: "worker" });
  const marked = await markMessage(ID, r.message_id, { ...storage, status: "applied", note: "regression passed", evidence: ["results.xml"], by: "reviewer" });
  assert.equal(marked.reports.length, 2); assert.equal(marked.response.basis, "explicit_report");
  assert.equal((await listMessages(ID, { ...storage, pending: true })).length, 0);
  await assert.rejects(getMessage("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", r.message_id, storage), /not found/);
});

test("dry-run has no journal; state rejects symlinks and unsafe permissions", async t => {
  const storage = await fixture(t);
  await sendTrackedMessage(ID, "test", { dryRun: true }, { ...storage, send: async () => ({ sent: false }) });
  assert.deepEqual(await listMessages(ID, storage), []);
  await writeRecord("messages", "safe", { ok: true }, storage);
  await symlink(storePath("messages", "safe", storage.home), storePath("messages", "alias", storage.home));
  await assert.rejects(readRecord("messages", "alias", storage), /Unsafe/);
  await assert.rejects(writeRecord("messages", "alias", {}, storage), /Unsafe/);
  await chmod(storePath("messages", "safe", storage.home), 0o644);
  await assert.rejects(readRecord("messages", "safe", storage), /Unsafe/);
  assert.throws(() => storePath("messages", "../escape", storage.home), /identifier/);
});

test("message operations serialize and release locks after failure", async t => {
  const storage = await fixture(t);
  await withStoreLock("example", async () => {
    await assert.rejects(withStoreLock("example", async () => assert.fail("concurrent"), storage), { code: "RECORD_BUSY" });
  }, storage);
  await assert.rejects(withStoreLock("example", async () => { throw new Error("failed"); }, storage), /failed/);
  assert.equal(await withStoreLock("example", async () => 42, storage), 42);
});

test("post-acceptance journal failure preserves the accepted receipt", async t => {
  const storage = await fixture(t);
  const receipt = await sendTrackedMessage(ID, "test", {}, { ...storage, send: async (...args) => {
    await chmod(storePath("messages", null, storage.home), 0o777);
    return accepted(...args);
  } });
  assert.equal(receipt.delivery_status, "accepted"); assert.equal(receipt.journal_update_required, true);
  await chmod(storePath("messages", null, storage.home), 0o700);
  assert.equal((await getMessage(ID, receipt.message_id, storage)).attempt_state, "prepared");
});
