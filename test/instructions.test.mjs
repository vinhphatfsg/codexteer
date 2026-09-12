import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { sendTrackedMessage, listInstructions, getMessage, instructionStates } from "../src/journal.mjs";
import { writeRecord } from "../src/store.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
async function setup(t) { const home = await mkdtemp("/private/tmp/cs-instructions-"); t.after(() => rm(home, { recursive: true, force: true })); return { home, send: async (threadId, text, o) => ({ sent: true, delivery_status: "accepted", client_message_id: o.clientMessageId, turn_id: "t" }) }; }

test("replacement and withdrawal preserve history and expose only the effective instruction", async t => {
  const deps = await setup(t);
  const a = await sendTrackedMessage(ID, "first", {}, deps);
  const b = await sendTrackedMessage(ID, "corrected", { supersedes: a.message_id }, deps);
  assert.deepEqual((await listInstructions(ID, deps)).instructions.map(e => e.id), [b.message_id]);
  assert.match((await getMessage(ID, b.message_id, deps)).wire_text, /置き換える指示/);
  const c = await sendTrackedMessage(ID, "not needed", { retracts: b.message_id }, deps);
  assert.equal((await listInstructions(ID, deps)).instructions.length, 0);
  const all = (await listInstructions(ID, { ...deps, all: true })).instructions;
  assert.equal(all.find(e => e.id === a.message_id).instruction_status, "superseded");
  assert.equal(all.find(e => e.id === b.message_id).instruction_status, "retracted");
  assert.match((await getMessage(ID, c.message_id, deps)).wire_text, /撤回する指示/);
});

test("uncertain replacement keeps old instruction active until delivery is reconciled", async t => {
  const deps = await setup(t); const a = await sendTrackedMessage(ID, "first", {}, deps); let error;
  await assert.rejects(sendTrackedMessage(ID, "corrected", { supersedes: a.message_id }, { ...deps, send: async () => { throw Object.assign(new Error("unknown"), { delivery_status: "unknown", sent: null }); } }), e => { error = e; return true; });
  let list = await listInstructions(ID, deps);
  assert.equal(list.instructions[0].id, a.message_id); assert.equal(list.pending_changes[0].id, error.message_id);
  await assert.rejects(sendTrackedMessage(ID, "again", { supersedes: a.message_id }, deps), /unresolved/);
  const entry = await getMessage(ID, error.message_id, deps);
  await writeRecord("messages", entry.id, { ...entry, delivery_status: "accepted", sent: true }, deps);
  list = await listInstructions(ID, deps);
  assert.equal(list.instructions.length, 1); assert.equal(list.instructions[0].id, entry.id);
});

test("wrong-task targets and stale targets are rejected; expiry is explicit", async t => {
  const deps = await setup(t); const a = await sendTrackedMessage(ID, "first", {}, deps);
  await assert.rejects(sendTrackedMessage("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", "wrong", { supersedes: a.message_id }, deps), /not found/);
  await assert.rejects(sendTrackedMessage(ID, "expired", { expiresAt: "2020-01-01T00:00:00Z" }, deps), /future ISO/);
  const expiry = new Date(Date.now() + 60000).toISOString();
  const b = await sendTrackedMessage(ID, "temporary", { expiresAt: expiry }, deps);
  const state = instructionStates([await getMessage(ID, b.message_id, deps)], Date.parse(expiry) + 1);
  assert.equal(state[0].instruction_status, "expired");
  await sendTrackedMessage(ID, "replacement", { supersedes: a.message_id }, deps);
  await assert.rejects(sendTrackedMessage(ID, "stale", { supersedes: a.message_id }, deps), /inactive/);
});
