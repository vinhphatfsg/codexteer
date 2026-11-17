import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { readRecord, writeRecord } from "../src/store.mjs";
import { fail } from "../src/cli.mjs";

const THREAD = "11111111-1111-4111-8111-787878787878", SESSION = "22222222-2222-4222-8222-787878787878";
const user = { id: "user-one", type: "userMessage", content: [{ type: "text", text: "original delegation" }] };
const task = (items = []) => ({ id: THREAD, name: "fixture", status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-one", status: "inProgress", items: [user, ...items] }] });

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-tell-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const f = { home, current: task() }; f.read = async (_id, options) => readSnapshot(f.current, { since: options.since, limit: options.limit });
  await registerManagedThread(THREAD, { projectId: "project-cli", connection: "shared", syncCursor: readSnapshot(f.current).cursor }, { home });
  await registerSupervisor(THREAD, SESSION, { home, owner: "fixture", connection: "shared" });
  await syncProject("project-cli", {}, { storage: { home }, read: f.read });
  return f;
}
const refusal = promise => promise.then(() => assert.fail("sent"), error => error);
function printed(error, json) {
  const lines = [], { log, error: err } = console, exitCode = process.exitCode;
  console.log = line => lines.push(line); console.error = line => lines.push(line);
  try { fail(error, json, ["work", "tell", THREAD, "fixture"]); } finally { Object.assign(console, { log, error: err }); process.exitCode = exitCode; }
  return json ? JSON.parse(lines.join("\n")).error : lines;
}

test("a refusal prints the events it refused on, bounded, in JSON and in text", async t => {
  const f = await fixture(t);
  f.current = task([...Array.from({ length: 25 }, (_, n) => ({ id: `agent-${n}`, type: "agentMessage", text: `${n}:` + "x".repeat(3000) })),
    { id: "ask", type: "agentMessage", text: "26: which one?", questions: ["A or B?"] }]);
  const error = await refusal(tellWork(THREAD, "fixture", {}, { storage: f, read: f.read }));
  assert.equal(error.code, "WORK_TELL_HUMAN_REQUIRED");
  const json = printed(error, true);
  assert.equal(json.code, "WORK_TELL_HUMAN_REQUIRED"); assert.equal(json.events.length, 20); assert.equal(json.events_omitted, error.events.length - 20);
  assert.match(json.events.at(-1).text, /^26:/, "the newest events are kept"); assert.ok(json.events.every(event => event.text.length <= 2000 + "\n[truncated]".length));
  assert.equal(json.delivery_action, undefined);
  const text = printed(error, false);
  assert.equal(text.filter(line => line.startsWith("event: ")).length, 20); assert.ok(text.includes(`events_omitted: ${error.events.length - 20}`));

  const other = await fixture(t);
  other.current = task([{ id: "agent-new", type: "agentMessage", text: "progress" }, { id: "user-new", type: "userMessage", content: [{ type: "text", text: "someone else's request" }] }]);
  const foreign = printed(await refusal(tellWork(THREAD, "fixture", {}, { storage: other, read: other.read })), true);
  assert.deepEqual([foreign.code, foreign.events.map(event => event.id), foreign.events_omitted], ["WORK_TELL_FOREIGN_INPUT", ["user-new"], 0], "the input that refused it, not the worker's progress");
  const plain = printed(Object.assign(new Error("changed"), { code: "STALE_OBSERVATION", events: [{ id: "user-new", type: "userMessage", text: "x".repeat(3000) }] }), true);
  assert.deepEqual([plain.events.length, plain.events[0].text.length], [1, 2000 + "\n[truncated]".length], "a plain send's refusal names the input too");
  const pasted = Object.assign(new Error("changed"), { code: "WORK_TELL_FOREIGN_INPUT", events: [{ id: "user-image", type: "userMessage", text: "see image", attachments: [{ url: `data:image/png;base64,${"A".repeat(50000)}` }], questions: ["Q".repeat(5000)] }] });
  const clipped = printed(pasted, true).events[0];
  assert.ok(clipped.attachments[0].url.length <= 2000 + "\n[truncated]".length && clipped.questions[0].length <= 2000 + "\n[truncated]".length, "every string in an event is clipped");
});

test("an error from another command prints none of work tell's fields", () => {
  const other = printed(Object.assign(new Error("other"), { code: "PROJECT_CONTROL_INVALID", reason: "internal", events: [{ id: "x" }], policy: { checked: true } }), true);
  assert.deepEqual([other.reason, other.events, other.policy], [undefined, undefined, undefined]);
});

test("competing bases, an incomplete basis and an unknown delivery print what the caller needs next", async t => {
  const f = await fixture(t), key = createHash("sha256").update("project-cli").digest("hex").slice(0, 40), head = await readRecord("project-sync-heads", key, f);
  const other = "33333333-3333-4333-8333-787878787878";
  await writeRecord("project-sync-heads", key, { ...head, conflict_tokens: [other, head.sync_token] }, f);
  const competing = printed(await refusal(tellWork(THREAD, "fixture", {}, { storage: f, read: f.read })), true);
  assert.deepEqual([competing.code, competing.sync_tokens, competing.current_sync_token], ["WORK_TELL_SYNC_TOKEN_REQUIRED", [other, head.sync_token], head.sync_token]);
  await writeRecord("project-sync-heads", key, head, f);

  await syncProject("project-cli", {}, { storage: f, read: async () => { throw Object.assign(new Error("slow"), { code: "TIMEOUT" }); } });
  const incomplete = printed(await refusal(tellWork(THREAD, "fixture", {}, { storage: f, read: f.read })), true);
  assert.deepEqual([incomplete.code, incomplete.reason, incomplete.target_error], ["WORK_TELL_SYNC_INCOMPLETE", "target_incomplete", "TIMEOUT"]);
  assert.match(incomplete.message, /project sync --project project-cli/);
  await syncProject("project-cli", {}, { storage: f, read: f.read });

  const lost = await refusal(tellWork(THREAD, "fixture", {}, { storage: f, read: f.read, reconcile: async id => ({ message_id: id, status: "not_observed" }),
    send: async (_id, _wire, options) => { await options.beforeSend(f.current); throw Object.assign(new Error("lost receipt"), { uncertain: true }); } }));
  const unknown = printed(lost, true);
  assert.deepEqual([unknown.delivery_status, unknown.reconciliation, unknown.delivery_action, unknown.delivery_action_source], ["unknown", { message_id: lost.message_id, status: "not_observed" }, "steer", "auto"]);
  assert.equal(unknown.finding_id, lost.finding_id); assert.equal(unknown.policy.checked, false);
  assert.ok(printed(lost, false).includes(`reconciliation: ${JSON.stringify({ message_id: lost.message_id, status: "not_observed" })}`));
});
