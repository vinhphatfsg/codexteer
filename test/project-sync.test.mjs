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
  const resolved = await syncProject("project-sync", {}, { storage: f, read: async (id, options) => page(id, `resolved-${id}`, options.since === `resolved-${id}` ? [] : [{ id: "human-answer", type: "userMessage", text: "answer" }]) });
  assert.equal(resolved.works.find(w => w.thread_id === uuid(2)).attention, "none");
});

test("429 and stale cursors preserve other results and report unavailable/history_gap without retry", async t => {
  const f = await fixture(t, 3), attempts = new Map();
  const result = await syncProject("project-sync", {}, { storage: f, read: async (id, options) => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (id === uuid(1)) throw Object.assign(new Error("rate"), { code: "CLOUD_RATE_LIMITED", retry_after_ms: 9000, http_status: 429 });
    if (id === uuid(2)) throw Object.assign(new Error("stale"), { code: "STALE_CURSOR" });
    return page(id, "done", options.since === "done" ? [] : [{ id: "done", type: "agentMessage", text: "finished" }], { status: "completed" });
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
const result=await syncProject("project-sync",{}, {read:async (id,options)=>{const n=Number(id.slice(-12)); return {thread_id:id,cursor:"restart-"+n,has_more:false,title:id,status:n===1?"completed":n===2?"failed":"active",attention:n===3?["question"]:n===4?["waitingOnApproval"]:[],events:options.since==="restart-"+n?[]:n===2?[{id:"failed",type:"commandExecution",status:"failed",exit_code:1}]:n>=3?[{id:"human",type:"agentMessage",questions:["respond"]}]:[]};}}); console.log(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout); assert.equal(result.complete, true);
  assert.equal(result.works.find(w => w.thread_id === uuid(1)).group, "検収待ち");
  assert.equal(result.works.find(w => w.thread_id === uuid(2)).attention, "failure");
  assert.equal(result.works.find(w => w.thread_id === uuid(3)).attention, "human");
  assert.equal(result.works.find(w => w.thread_id === uuid(4)).attention, "human");
});

const barrier = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const keyFor = async () => (await import("node:crypto")).createHash("sha256").update("project-sync").digest("hex").slice(0, 40);

test("concurrent sync cannot roll cursor or unresolved attention back, including equal-cursor ABA", async t => {
  const { readRecord } = await import("../src/store.mjs");
  for (const same of [false, true]) {
    const f = await fixture(t, 1), entered = barrier(), release = barrier(); let calls = 0;
    const slow = syncProject("project-sync", {}, { storage: f, read: async id => {
      if (++calls === 1) { entered.release(); await release.promise; }
      return page(id, same ? "c0-1" : "c5");
    } });
    await entered.promise;
    let first = true;
    const fast = await syncProject("project-sync", {}, { storage: f, read: async id => {
      const events = first && !same ? [{ id: "question", type: "agentMessage", questions: ["review?"], text: "Question" }] : [];
      first = false; return page(id, same ? "c0-1" : "c10", events, { attention: ["waitingOnApproval"] });
    } });
    release.release(); const old = await slow;
    assert.equal((await getManagedThread(uuid(1), f)).sync_cursor, same ? "c0-1" : "c10");
    assert.equal(old.complete, false); assert.equal(old.works[0].error, "SYNC_CURSOR_CONFLICT");
    const head = await readRecord("project-sync-heads", await keyFor(), f);
    assert.equal(head.sync_token, fast.sync_token); assert.equal(head.unresolved_attention[uuid(1)].attention, "human");
  }
});

test("questions accumulate across pages and repeat their evidence on rate/page budget failures", async t => {
  const f = await fixture(t, 1); let n = 0;
  const first = await syncProject("project-sync", {}, { storage: f, read: async id => {
    n++; return page(id, `q${Math.min(n, 2)}`, n === 1 ? [{ id: "question", type: "agentMessage", text: "Need a decision", questions: ["Which?"] }] : [], { has_more: n === 1 });
  } });
  assert.equal(first.works[0].group, "対応が必要"); const token = first.works[0].events[0].token;
  for (const kind of ["rate", "budget"]) {
    let count = 0;
    const next = await syncProject("project-sync", { maxPagesPerWork: kind === "rate" ? 3 : 1 }, { storage: f, read: async id => {
      if (kind === "rate" && count++) throw Object.assign(new Error("rate"), { http_status: 429 });
      return page(id, `${kind}-1`, [], { has_more: true });
    } });
    assert.equal(next.complete, false); assert.equal(next.works[0].attention, "human");
    assert.equal(next.works[0].resolution_unconfirmed, true); assert.equal(next.works[0].attention_repeated, true);
    assert.ok(next.works[0].events.some(e => e.token === token)); assert.ok(next.works[0].reason);
  }
  const absent = await syncProject("project-sync", {}, { storage: f, read: async id => page(id, "absent", []) });
  assert.equal(absent.works[0].attention, "human", "absence is not resolution");
  const resolved = await syncProject("project-sync", {}, { storage: f, read: async (id, options) => page(id, "resolved", options.since === "resolved" ? [] : [{ id: "human-answer", type: "userMessage", text: "answer" }]) });
  assert.equal(resolved.works[0].attention, "none");
});

test("malformed pages and stalled/cyclic cursors never commit membership", async t => {
  const malformed = [p => ({ ...p, thread_id: uuid(9) }), p => ({ ...p, cursor: null }), p => ({ ...p, has_more: "false" }),
    p => ({ ...p, events: {} }), p => ({ ...p, events: [null] }), p => ({ ...p, events: [{ id: "e", type: 4 }] }),
    p => ({ ...p, attention: {} }), p => ({ ...p, attention_snapshot: { complete: "yes", attention: [] } })];
  for (const change of malformed) {
    const f = await fixture(t, 1);
    const result = await syncProject("project-sync", {}, { storage: f, read: async id => change(page(id, "c1")) });
    assert.equal(result.complete, false); assert.equal(result.works[0].error, "PROJECT_SYNC_PAGE_INVALID");
    assert.equal((await getManagedThread(uuid(1), f)).sync_cursor, "c0-1");
  }
  for (const cursors of [["c0-1"], ["c1", "c2", "c1"]]) {
    const f = await fixture(t, 1); let n = 0;
    const result = await syncProject("project-sync", {}, { storage: f, read: async id => page(id, cursors[Math.min(n++, cursors.length - 1)], [], { has_more: true }) });
    assert.equal(result.works[0].error, "PROJECT_SYNC_CURSOR_STALLED"); assert.equal(result.complete, false);
  }
});

async function allPages(first, storage, byteBudget) {
  const result = [], tokens = []; let current = first;
  for (let i = 0; ; i++) {
    assert.ok(i < 3000, "continuation must make progress");
    assert.ok(Buffer.byteLength(JSON.stringify(current)) <= byteBudget);
    assert.equal(current.output_bytes, Buffer.byteLength(JSON.stringify(current)));
    result.push(...current.works); tokens.push(...current.works.flatMap(w => w.events.map(e => e.token)));
    if (!current.continuation_token) break;
    current = await continueProjectSync(current.continuation_token, { byteBudget, offset: current.next_offset, eventOffset: current.next_event_offset }, storage);
  }
  assert.equal(new Set(tokens).size, tokens.length, "no repeated event tokens");
  return { works: result, tokens };
}

test("100 attention works obey UTF-8 byte budgets with lossless continuation", async t => {
  const f = await fixture(t, 100);
  const result = await syncProject("project-sync", { byteBudget: 4096 }, { storage: f, read: async id => page(id, "c1", [], { title: "題".repeat(5000), attention: ["質問".repeat(3000)] }) });
  const all = await allPages(result, f, 4096);
  assert.equal(new Set(all.works.map(w => w.thread_id)).size, 100);
  assert.ok(all.works.every(w => w.attention === "human"));
  const details = await projectEvent(all.works[0].detail_token, f); assert.equal(details.event.work.title.length, 5000);
});

test("a single work with 1000 events splits inside the work without missing tokens", async t => {
  const f = await fixture(t, 1), events = Array.from({ length: 1000 }, (_, n) => ({ id: `e${n}`, type: "agentMessage", text: "本文".repeat(500) }));
  const result = await syncProject("project-sync", { byteBudget: 4096 }, { storage: f, read: async (id, options) => page(id, "c1", options.since === "c1" ? [] : events) });
  const all = await allPages(result, f, 4096); assert.equal(all.tokens.length, 1000);
  const again = await continueProjectSync(result.sync_token, { byteBudget: 4096 }, f);
  assert.ok(Buffer.byteLength(JSON.stringify(again)) <= 4096);
  const { readHistoryRecord } = await import("../src/project-history.mjs");
  const saved = await readHistoryRecord("project-sync-results", result.sync_token, "project-sync", f);
  assert.deepEqual(all.tokens, saved.works.flatMap(w => w.events.map(e => e.token)));
});

test("initial and continuation budgets share validation and oversized fixed envelopes fail", async t => {
  const f = await fixture(t, 1), good = await syncProject("project-sync", {}, { storage: f, read: async id => page(id, "c1") });
  for (const byteBudget of [4095, 0, -1, NaN, Infinity, 1024 * 1024 + 1]) {
    await assert.rejects(syncProject("project-sync", { byteBudget }, { storage: f, read: async () => assert.fail() }), { code: "PROJECT_SYNC_INVALID" });
    await assert.rejects(continueProjectSync(good.sync_token, { byteBudget }, f), { code: "PROJECT_SYNC_INVALID" });
  }
  await assert.rejects(syncProject("大".repeat(5000), { byteBudget: 4096 }, { storage: f, read: async () => assert.fail("must reject before observation") }), { code: "PROJECT_SYNC_BUDGET_TOO_SMALL" });
  const { writeRecord } = await import("../src/store.mjs"), { historyBucket } = await import("../src/project-history.mjs");
  await writeRecord(historyBucket("project-sync-results", "project-sync"), good.sync_token, { project_id: "大".repeat(5000), works: [], complete: true }, f);
  await assert.rejects(continueProjectSync(good.sync_token, { byteBudget: 4096 }, f), { code: "PROJECT_SYNC_BUDGET_TOO_SMALL" });
});

test("cursor API compares both expected cursor and revision under its membership lock", async t => {
  const { updateManagedThreadCursor, managedMembershipDigest } = await import("../src/project-index.mjs");
  const f = await fixture(t, 1), before = await getManagedThread(uuid(1), f);
  await updateManagedThreadCursor(uuid(1), before.sync_cursor, "new", f);
  await assert.rejects(updateManagedThreadCursor(uuid(1), before.sync_cursor, "old", f), { code: "SYNC_CURSOR_CONFLICT" });
  await assert.rejects(updateManagedThreadCursor(uuid(1), "new", "old", f, 0), { code: "SYNC_CURSOR_CONFLICT" });
  assert.equal((await getManagedThread(uuid(1), f)).sync_cursor, "new");
  const registration = await registerManagedThread(uuid(1), { projectId: "project-sync", connection: "shared", syncCursor: "c0-1" }, f);
  assert.equal(registration.sync_cursor, "new", "idempotent registration never resets observation progress");
  assert.equal(registration.sync_revision, 1);
  const digest = managedMembershipDigest([before]);
  for (const field of ["host_id", "remote_transport", "backend_project_id", "creation_attempt_id", "connection"]) assert.notEqual(managedMembershipDigest([{ ...before, [field]: "changed" }]), digest, field);
  assert.equal(managedMembershipDigest([{ ...before, sync_cursor: "ignored", sync_revision: 99 }]), digest);
});

test("mixed work/event continuation offsets progress at byte boundaries", async t => {
  const f = await fixture(t, 4);
  const first = await syncProject("project-sync", {}, { storage: f, read: async (id, options) => page(id, "c1", options.since === "c1" ? [] : Array.from({ length: Number(id.slice(-1)) * 17 }, (_, i) => ({ id: `${id}-${i}`, type: "agentMessage", text: "多字節".repeat(i * 10) }))) });
  for (const byteBudget of [4096, 4100, 8192, 16000, 1048576]) {
    const start = await continueProjectSync(first.sync_token, { byteBudget }, f), all = await allPages(start, f, byteBudget);
    assert.equal(all.tokens.length, 170);
    assert.equal(all.works.filter(w => w.events_complete).length, 4);
  }
});

test("a cursor CAS miss cannot resolve prior attention", async t => {
  const { updateManagedThreadCursor } = await import("../src/project-index.mjs");
  const f = await fixture(t, 1); let n = 0;
  await syncProject("project-sync", {}, { storage: f, read: async id => page(id, "q", n++ ? [] : [{ id: "q", type: "agentMessage", questions: ["answer"] }]) });
  let advanced = false;
  const result = await syncProject("project-sync", {}, { storage: f, read: async id => {
    if (!advanced) { advanced = true; const m = await getManagedThread(id, f); await updateManagedThreadCursor(id, m.sync_cursor, "other", f, m.sync_revision); }
    return page(id, "resolved", [], { attention_resolutions: ["q"] });
  } });
  assert.equal(result.complete, false); assert.equal(result.works[0].error, "SYNC_CURSOR_CONFLICT");
  assert.equal(result.works[0].attention, "human"); assert.equal(result.works[0].attention_repeated, true);
});
