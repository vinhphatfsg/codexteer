import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { observationServer } from "../test-support/observation-server.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";

const ID = "11111111-1111-4111-8111-000000000002", SESSION = "22222222-2222-4222-8222-000000000002";
async function fixture(t, mode = "aggregate") {
  const home = await mkdtemp(tempPrefix("ct-progress-")); t.after(() => rm(home, { recursive: true, force: true }));
  const cloud = mode === "cloud", id = cloud ? `durable_${ID}` : ID;
  const thread = { id, historyMode: "aggregate", status: { type: "active", activeFlags: [] },
    ...(cloud ? { environments: [{ environmentId: "env", environmentConfigId: "config" }] } : {}),
    turns: [{ id: "t1", status: "inProgress", items: [{ id: "ask", type: "userMessage", content: [{ type: "text", text: "Build it" }] }] }] };
  const server = observationServer(thread), read = (id, options) => observeThread(id, options, {
    discover: async () => ({ paths: { socket: "fixture" } }), connect: async () => server.client,
  });
  const storage = { home }, connection = cloud ? "desktop-cloud" : "shared";
  await registerManagedThread(id, { projectId: "P", connection, ...(cloud ? { environmentConfigId: "config" } : {}) }, storage);
  await registerSupervisor(id, SESSION, { ...storage, connection });
  const dependencies = { storage, read, pollMs: 5, unreadGraceMs: 0, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  await syncProject("P", {}, dependencies);
  const say = text => thread.turns.at(-1).items.push({ id: `m${thread.turns.at(-1).items.length}`, type: "agentMessage", phase: "commentary", text });
  return { id, thread, storage, dependencies, say };
}

test("a running worker's words wake the orchestrator once the spacing since the last review has passed", async t => {
  const f = await fixture(t);
  f.say("Rewriting the parser instead of fixing the test");
  const early = await waitProject("P", { timeoutMs: 30, progressMs: 60000 }, f.dependencies);
  assert.equal(early.timed_out, true, "a review moments ago keeps the words for later");
  const woke = await waitProject("P", { timeoutMs: 2000, progressMs: 0 }, f.dependencies);
  assert.equal(woke.reason, "work_progress"); assert.equal(woke.changed, true);
  assert.deepEqual(woke.progress, [{ thread_id: f.id, turn_id: "t1", messages: 1, latest: "Rewriting the parser instead of fixing the test" }]);
  assert.ok(woke.sync.works[0].events.some(event => event.type === "agentMessage"), "the words are in the published delta");
  assert.equal((await waitProject("P", { timeoutMs: 30, progressMs: 0 }, f.dependencies)).timed_out, true, "words already returned do not wake again");
});

test("bounded waits shorter than the spacing still come due, because the spacing runs from the last review", async t => {
  const f = await fixture(t);
  f.say("Started on the wrong module");
  const started = Date.now();
  let result;
  do result = await waitProject("P", { timeoutMs: 40, progressMs: 300 }, f.dependencies);
  while (result.timed_out && Date.now() - started < 3000);
  assert.equal(result.reason, "work_progress");
  assert.ok(Date.now() - started >= 250, "not before the spacing");
});

test("words that keep coming wake at most once per spacing", async t => {
  const f = await fixture(t);
  f.say("one");
  assert.equal((await waitProject("P", { timeoutMs: 2000, progressMs: 0 }, f.dependencies)).reason, "work_progress");
  f.say("two");
  const held = await waitProject("P", { timeoutMs: 100, progressMs: 60000 }, f.dependencies);
  assert.equal(held.timed_out, true, "the review the last wake made restarts the spacing");
});

test("a turn's end is returned at once, whatever the spacing", async t => {
  const f = await fixture(t);
  f.say("almost done");
  const waiting = waitProject("P", { timeoutMs: 2000, progressMs: 60000 }, f.dependencies);
  await delay(20);
  f.thread.turns[0].status = "completed"; f.thread.status = { type: "idle" };
  f.thread.turns[0].items.push({ id: "final", type: "agentMessage", phase: "final_answer", text: "Done" });
  const result = await waiting;
  assert.equal(result.reason, "work_changed");
  assert.equal(result.progress[0].messages, 1, "the digest still names the words said before the end");
});

test("an ordinary complete sync is a review: the spacing restarts and the words it showed do not wake", async t => {
  const f = await fixture(t);
  f.say("seen by sync");
  await syncProject("P", {}, f.dependencies);
  assert.equal((await waitProject("P", { timeoutMs: 30, progressMs: 0 }, f.dependencies)).timed_out, true);
});

test("a Desktop Cloud turn that cannot be read while it runs is reported once per turn", async t => {
  const f = await fixture(t, "cloud");
  assert.equal((await waitProject("P", { timeoutMs: 30, progressMs: 0 }, f.dependencies)).timed_out, true, "the sync that started the watch already showed this turn as unobserved");
  f.thread.turns[0].status = "completed"; f.thread.status = { type: "idle" };
  assert.equal((await waitProject("P", { timeoutMs: 2000, progressMs: 0 }, f.dependencies)).reason, "work_changed");
  f.thread.turns.push({ id: "t2", status: "inProgress", items: [{ id: "next", type: "userMessage", content: [{ type: "text", text: "Next" }] }] });
  f.thread.status = { type: "active", activeFlags: [] };
  const blind = await waitProject("P", { timeoutMs: 2000, progressMs: 0 }, f.dependencies);
  assert.equal(blind.reason, "work_unobserved");
  assert.equal(blind.attention_unobserved[0].thread_id, f.id);
  assert.equal((await waitProject("P", { timeoutMs: 30, progressMs: 0 }, f.dependencies)).timed_out, true, "the same turn is not reported twice");
});

test("a newly unobserved turn waits for the spacing too", async t => {
  const f = await fixture(t, "cloud");
  f.thread.turns[0].status = "completed"; f.thread.status = { type: "idle" };
  assert.equal((await waitProject("P", { timeoutMs: 2000, progressMs: 60000 }, f.dependencies)).reason, "work_changed");
  f.thread.turns.push({ id: "t2", status: "inProgress", items: [] });
  f.thread.status = { type: "active", activeFlags: [] };
  assert.equal((await waitProject("P", { timeoutMs: 60, progressMs: 60000 }, f.dependencies)).timed_out, true);
});

test("project wait refuses a progress spacing that is not a nonnegative integer", async t => {
  const f = await fixture(t);
  await assert.rejects(waitProject("P", { progressMs: -1 }, f.dependencies), /--progress-ms/);
});
