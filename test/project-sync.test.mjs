import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { syncProject, continueProjectSync, projectEvent } from "../src/project-sync.mjs";

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
async function fixture(t, count = 16) {
  const home = await mkdtemp(tempPrefix("ct-sync-")); t.after(() => rm(home, { recursive: true, force: true }));
  for (let i = 1; i <= count; i++) await registerManagedThread(uuid(i), { projectId: "project-sync", connection: "shared", syncCursor: `c0-${i}` }, { home });
  return { home };
}

const page = (id, cursor, events = [], extra = {}) => ({ thread_id: id, cursor, events, status: "active", attention: [], title: id, has_more: false, ...extra });

test("round-robin first pages expose another work's question before draining an endless history", async t => {
  const f = await fixture(t), calls = [], counts = new Map();
  const result = await syncProject("project-sync", { maxPagesPerWork: 3 }, { storage: f, read: async (id, options) => {
    calls.push(id); const n = (counts.get(id) ?? 0) + 1; counts.set(id, n);
    if (id === uuid(1)) return page(id, `c-${n}`, [{ id: `e-${n}`, type: "agentMessage", text: "backlog" }], { has_more: true });
    if (id === uuid(16)) return page(id, `q-${n}`, [{ id: "question", type: "agentMessage", text: "Need human", questions: ["approve?"] }], { attention: ["waitingOnApproval"] });
    return page(id, `c-${id}-${n}`);
  }});
  assert.deepEqual(calls.slice(0, 16), Array.from({ length: 16 }, (_, i) => uuid(i + 1)));
  assert.equal(result.works[0].thread_id, uuid(16)); assert.equal(result.works[0].group, "対応が必要");
  assert.equal(result.works.find(w => w.thread_id === uuid(1)).complete, false);
  assert.equal((await getManagedThread(uuid(1), f)).sync_cursor, "c0-1", "incomplete cursor does not advance");
});

test("attention survives byte budgeting, repeats until resolved, and full long text is retrievable", async t => {
  const f = await fixture(t, 3), long = "長".repeat(30000), reads = new Map();
  const read = async id => { const n = (reads.get(id) ?? 0) + 1; reads.set(id, n); return id === uuid(2)
    ? page(id, `q-${n}`, [{ id: "long", type: "agentMessage", text: long, questions: ["answer"] }], { attention: ["waitingOnApproval"] })
    : page(id, `c-${id}-${n}`, [{ id: `normal-${n}`, type: "agentMessage", text: "ordinary progress".repeat(100) }]); };
  const first = await syncProject("project-sync", { byteBudget: 4096 }, { storage: f, read });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 4096); assert.equal(first.works[0].thread_id, uuid(2)); assert.equal(first.works[0].group, "対応が必要");
  const token = first.works[0].events[0].token, full = await projectEvent(token, f); assert.equal(full.event.text, long);
  if (first.continuation_token) { const continuation = await continueProjectSync(first.continuation_token, { byteBudget: 4096 }, f); assert.ok(continuation.works.length); assert.ok(Buffer.byteLength(JSON.stringify(continuation)) <= 4096); }
  const second = await syncProject("project-sync", { byteBudget: 4096 }, { storage: f, read });
  assert.equal(second.works.find(w => w.thread_id === uuid(2)).attention_repeated, true);
  const resolved = await syncProject("project-sync", {}, { storage: f, read: async id => page(id, `resolved-${id}`, []) });
  assert.equal(resolved.works.find(w => w.thread_id === uuid(2)).attention, "none");
});

test("429 and stale cursors preserve other results and report unavailable/history_gap without retry", async t => {
  const f = await fixture(t, 3), attempts = new Map();
  const result = await syncProject("project-sync", {}, { storage: f, read: async id => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (id === uuid(1)) throw Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED", retry_after_ms: 9000, http_status: 429 });
    if (id === uuid(2)) throw Object.assign(new Error("stale"), { code: "STALE_CURSOR" });
    return page(id, "done", [{ id: "done", type: "agentMessage", text: "finished" }], { status: "completed" });
  }});
  assert.equal(attempts.get(uuid(1)), 1); assert.equal(result.complete, false);
  assert.equal(result.works.find(w => w.thread_id === uuid(1)).retry_after_ms, 9000);
  assert.equal(result.works.find(w => w.thread_id === uuid(2)).history_gap, true);
  assert.equal(result.works.find(w => w.thread_id === uuid(3)).group, "検収待ち");
});

test("a head change during sync is consumed or marks the work incomplete", async t => {
  const f = await fixture(t, 1); let calls = 0;
  const result = await syncProject("project-sync", {}, { storage: f, read: async id => {
    calls++; if (calls === 1) return page(id, "c1");
    return page(id, "c2", [{ id: "late", type: "agentMessage", text: "arrived during sync" }], { has_more: true });
  }});
  assert.equal(result.complete, false); assert.equal(result.works[0].complete, false); assert.equal(result.works[0].events[0].event_id, "late");
});

test("membership digest pins the starting set when a work is added during sync", async t => {
  const f = await fixture(t, 2); let added = false;
  const result = await syncProject("project-sync", {}, { storage: f, read: async id => {
    if (!added) { added = true; await registerManagedThread(uuid(3), { projectId: "project-sync", connection: "shared", syncCursor: "late" }, f); }
    return page(id, `done-${id}`);
  }});
  assert.equal(result.membership_count, 2); assert.equal(result.works.some(work => work.thread_id === uuid(3)), false);
  const next = await syncProject("project-sync", {}, { storage: f, read: async id => page(id, `next-${id}`) });
  assert.equal(next.membership_count, 3); assert.notEqual(next.membership_digest, result.membership_digest);
});

test("a separate process catches up completion, failure, question, and approval from the same CODEX_HOME", async t => {
  const f = await fixture(t, 4), root = new URL("../", import.meta.url).pathname;
  const script = `import {syncProject} from ${JSON.stringify(new URL("../src/project-sync.mjs", import.meta.url).href)};
const uuid=n=>\`11111111-1111-4111-8111-\${String(n).padStart(12,"0")}\`;
const result=await syncProject("project-sync",{}, {read:async id=>{const n=Number(id.slice(-12)); return {thread_id:id,cursor:"restart-"+n,has_more:false,title:id,status:n===1?"completed":n===2?"failed":"active",attention:n===3?["question"]:n===4?["waitingOnApproval"]:[],events:n===2?[{id:"failed",type:"commandExecution",status:"failed",exit_code:1}]:n>=3?[{id:"human",type:"agentMessage",questions:["respond"]}]:[]};}}); console.log(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.works.find(w => w.thread_id === uuid(1)).group, "検収待ち");
  assert.equal(result.works.find(w => w.thread_id === uuid(2)).attention, "failure");
  assert.equal(result.works.find(w => w.thread_id === uuid(3)).attention, "human");
  assert.equal(result.works.find(w => w.thread_id === uuid(4)).attention, "human");
});
