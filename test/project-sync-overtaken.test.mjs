import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { tellWork } from "../src/work-tell.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { writeRecord } from "../src/store.mjs";

const id = "11111111-1111-4111-8111-000000000001", other = "22222222-2222-4222-8222-000000000002", policy = "Keep scope.\n";
const question = { id: "question", type: "agentMessage", text: "Which?", questions: ["Which?"] };
const answer = { id: "answer", type: "userMessage", content: [{ type: "text", text: "This one." }] };

async function fixture(t, { withOther = false } = {}) {
  const home = await mkdtemp(tempPrefix("ct-overtaken-")), root = await mkdtemp(tempPrefix("ct-overtaken-root-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const storage = { home }, thread = { id, status: { type: "idle", activeFlags: [] }, turns: [{ id: "turn-0", status: "completed", items: [{ id: "start", type: "agentMessage", text: "start" }] }] };
  await registerManagedThread(id, { projectId: "P", connection: "shared", syncCursor: readSnapshot(thread).cursor, policySha256: createHash("sha256").update(policy).digest("hex") }, storage);
  await writeFile(`${root}/CODEXTEER.md`, policy);
  await registerSupervisor(id, "33333333-3333-4333-8333-000000000003", { ...storage, owner: "fixture", connection: "shared" });
  await writeRecord("work-starts", "fixture", { schema: 1, project_id: "P", thread_id: id, root, created_at: new Date().toISOString() }, storage);
  // A second member, readable until `broken`, keeps every later ordinary sync partial.
  const second = { id: other, status: { type: "idle", activeFlags: [] }, turns: [{ id: "turn-0", status: "completed", items: [{ id: "start", type: "agentMessage", text: "start" }] }] };
  if (withOther) await registerManagedThread(other, { projectId: "P", connection: "shared", syncCursor: readSnapshot(second).cursor }, storage);
  const f = { storage, thread, second, broken: false, flagsUnknown: false };
  const read = async (target, options) => {
    if (target === other) { if (f.broken) throw Object.assign(new Error("rejected"), { code: "RPC_REJECTED" }); return readSnapshot(second, options); }
    const page = readSnapshot(thread, options);
    return f.flagsUnknown ? { ...page, attention: null } : page;
  };
  let sent = 0;
  const tell = () => tellWork(id, "next", {}, { storage, read, send: async (_id, _wire, options) => {
    await options.beforeSend(thread); sent++; return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-2" };
  } });
  return Object.assign(f, { read, tell, sent: () => sent, sync: (dependencies = {}) => syncProject("P", {}, { storage, read, ...dependencies }),
    wait: () => waitProject("P", { timeoutMs: 0 }, { storage, read, processIdentity: async () => "same", orchestratorIdentity: async () => null, parentPid: () => 1 }) });
}

// Holds the next read of a membership record that a project sync or wait
// publication makes (`listManagedThreads` in `syncProject`), after it was read, until `release`.
function holdMembershipRead(t) {
  const readFile = fs.promises.readFile; let release, held;
  const reached = new Promise(resolve => { held = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let armed = true;
  fs.promises.readFile = async (...args) => {
    const content = await readFile(...args);
    if (armed && String(args[0]).includes("project-index") && new Error().stack.includes("syncProject")) { armed = false; held(); await gate; }
    return content;
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.readFile = readFile; syncBuiltinESMExports(); });
  return { reached, release: () => release() };
}

test("a sync overtaken by another publication does not reopen a question that publication saw answered", async t => {
  const f = await fixture(t);
  await f.sync();
  f.thread.turns.push({ id: "turn-1", status: "completed", items: [question, answer, { id: "done", type: "agentMessage", text: "done" }] });
  const hold = holdMembershipRead(t), slow = f.sync();
  await hold.reached;
  const fast = await f.sync();
  assert.notEqual(fast.works[0].attention, "human", "the faster sync read the question with its answer");
  hold.release();
  assert.notEqual((await slow).works[0].attention, "human", "the slower sync does not reopen it");
  assert.notEqual((await f.sync()).works[0].attention, "human", "the answered question stays answered");
  await f.tell();
  assert.equal(f.sent(), 1);
});

test("a wait whose member was read again at the same cursor returns its change once and does not reopen a question a partial sync saw answered", async t => {
  const f = await fixture(t, { withOther: true }), row = result => result.works.find(work => work.thread_id === id);
  assert.equal((await f.wait()).reason, "initial_sync");
  f.broken = true;
  f.thread.turns.push({ id: "turn-1", status: "completed", items: [question, answer, { id: "done", type: "agentMessage", text: "done" }] });
  assert.notEqual(row(await f.sync()).attention, "human", "a partial sync read the question with its answer");
  const hold = holdMembershipRead(t), waiting = f.wait();
  await hold.reached;
  assert.equal(row(await f.sync()).complete, true, "a sync that reads nothing new publishes meanwhile");
  hold.release();
  assert.equal((await waiting).reason, "work_changed", "the wait returns the turn from its baseline");
  assert.equal((await f.wait()).reason, "timeout", "the next wait does not return the same change again");
  assert.notEqual(row(await f.sync()).attention, "human", "the answered question stays answered");
  await f.tell();
  assert.equal(f.sent(), 1);
});

test("a wait read from a baseline behind the stored cursor, with unknown flags, does not reopen a question a partial sync saw answered", async t => {
  const f = await fixture(t, { withOther: true }), row = result => result.works.find(work => work.thread_id === id);
  assert.equal((await f.wait()).reason, "initial_sync");
  f.broken = true;
  f.thread.turns.push({ id: "turn-1", status: "completed", items: [question, answer, { id: "done", type: "agentMessage", text: "done" }] });
  assert.notEqual(row(await f.sync()).attention, "human", "a partial sync read the question with its answer");
  f.broken = false; f.flagsUnknown = true;
  f.second.turns.push({ id: "turn-1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "report" }] });
  const waited = await f.wait();
  assert.equal(row(waited.sync).error, "PROJECT_WAIT_ATTENTION_UNKNOWN", "the wait could not establish the member's flags");
  f.flagsUnknown = false;
  assert.notEqual(row(await f.sync()).attention, "human", "the answered question stays answered");
  await f.tell();
  assert.equal(f.sent(), 1);
});

// A real sync in a child process that pauses after its pending head and dies
// before its final head, between the cursor update and the result it owes.
async function dyingSync(t, f) {
  const file = `${f.storage.home}/thread.json`;
  await writeFile(file, JSON.stringify(f.thread));
  const code = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const rename = fs.promises.rename; let heads = 0;
    fs.promises.rename = async (source, target) => {
      if (!target.includes("/project-sync-heads/")) return rename(source, target);
      if (++heads === 2) { process.send({ dying: true }); await new Promise(() => setInterval(() => {}, 1000)); }
      await rename(source, target);
      process.send({ pending: true }); await new Promise(resolve => process.once("message", resolve));
    };
    syncBuiltinESMExports();
    const { syncProject } = await import(${JSON.stringify(new URL("../src/project-sync.mjs", import.meta.url).href)});
    const { readSnapshot } = await import(${JSON.stringify(new URL("../src/observe.mjs", import.meta.url).href)});
    const thread = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
    await syncProject("P", {}, { storage: { home: ${JSON.stringify(f.storage.home)} }, read: async (_id, options) => readSnapshot(thread, options) });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  const next = expected => Promise.race([once(child, "message").then(([message]) => assert.ok(message[expected], JSON.stringify(message))),
    once(child, "exit").then(([status, signal]) => assert.fail(`the child sync exited: ${status}/${signal}`))]);
  await next("pending");
  return { async die() { const dying = next("dying"); child.send("go"); await dying; child.kill("SIGKILL"); await once(child, "exit"); } };
}

test("a sync that dies after moving a backlog member's cursor leaves a head the next syncs complete", async t => {
  const f = await fixture(t);
  await f.sync();
  f.thread.turns.push({ id: "turn-1", status: "completed", items: [question, answer,
    ...Array.from({ length: 20 }, (_, n) => ({ id: `m-${n}`, type: "agentMessage", text: "x".repeat(1024 * 1024) }))] });
  const before = (await getManagedThread(id, f.storage)).sync_cursor, dying = await dyingSync(t, f);
  await dying.die();
  assert.notEqual((await getManagedThread(id, f.storage)).sync_cursor, before, "the dead sync moved the cursor past its batch");
  for (let n = 0; n < 4 && !(await f.sync()).works[0].complete; n++);
  await f.tell();
  assert.equal(f.sent(), 1);
});

test("a sync that read the head of a publication that died after moving the cursor does not reopen an answered question", async t => {
  const f = await fixture(t);
  await f.sync();
  f.thread.turns.push({ id: "turn-1", status: "completed", items: [question, answer, { id: "done", type: "agentMessage", text: "done" }] });
  const dying = await dyingSync(t, f);
  let release, reached; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  const slow = f.sync({ read: async (...args) => { reached(); await gate; return f.read(...args); } });
  await entered;
  await dying.die();
  release();
  await slow;
  assert.notEqual((await f.sync()).works[0].attention, "human", "the answered question stays answered");
  await f.tell();
  assert.equal(f.sent(), 1);
});
