import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { prepareDirective } from "../src/directive.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { sendOnClient } from "../src/app-server.mjs";
import { sendTrackedMessage, getMessage } from "../src/journal.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const state = () => ({ id: ID, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "do this" }] }] }] });

test("unannotated sends preserve exact text; annotated sends distinguish hypotheses and references", async t => {
  const home = await mkdtemp("/private/tmp/cs-directive-"); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(`${home}/result.txt`, "passed");
  assert.equal((await prepareDirective(ID, "raw\ntext", {}, "id")).wireText, "raw\ntext");
  const p = await prepareDirective(ID, "check", { source: "claude", kind: "hypothesis", evidence: [`${home}/result.txt`, "https://example.com/review"] }, "id");
  assert.match(p.wireText, /仮説（未確定）/); assert.match(p.wireText, /sha256:/); assert.equal(p.metadata.evidence[1].verification, "reference_only");
  await p.beforeSend(state());
  await writeFile(`${home}/result.txt`, "changed");
  await assert.rejects(p.beforeSend(state()), { code: "STALE_EVIDENCE" });
  await assert.rejects(prepareDirective(ID, "x", { kind: "approval" }, "id"), /kind/);
  await assert.rejects(prepareDirective(ID, "x", { source: "bad\nname" }, "id"), /source/);
});

test("based-on permits progress but rejects new user input or another active turn before mutation", async () => {
  const initial = state(), cursor = readSnapshot(initial).cursor;
  const p = await prepareDirective(ID, "check", { basedOn: cursor }, "id");
  const progress = state(); progress.turns[0].items.push({ id: "a", type: "agentMessage", text: "checking" });
  await p.beforeSend(progress);
  const changed = state(); changed.turns[0].items.push({ id: "new", type: "userMessage", content: [{ type: "text", text: "new intent" }] });
  let mutations = 0;
  await assert.rejects(sendOnClient({ request: async method => { if (method !== "thread/read") mutations++; return { thread: changed }; } }, ID, "test", { beforeSend: p.beforeSend }), { code: "STALE_OBSERVATION" });
  assert.equal(mutations, 0);
  const other = state(); other.turns[0].id = "new-turn";
  await assert.rejects(p.beforeSend(other), { code: "STALE_OBSERVATION" });
});

test("journal records the wire envelope used for receipt verification and dry-run remains unrecorded", async t => {
  const home = await mkdtemp("/private/tmp/cs-directive-"); t.after(() => rm(home, { recursive: true, force: true }));
  const receipt = await sendTrackedMessage(ID, "check it", { source: "reviewer", kind: "review" }, { home, send: async (threadId, text, options) => {
    await options.beforeSend(state()); assert.match(text, /送信者: reviewer/);
    return { delivery_status: "accepted", sent: true, client_message_id: options.clientMessageId, turn_id: "turn" };
  } });
  const record = await getMessage(ID, receipt.message_id, { home });
  assert.equal(record.body, "check it"); assert.match(record.wire_text, /レビュー/);
  assert.equal(record.metadata.source, "reviewer");
});
