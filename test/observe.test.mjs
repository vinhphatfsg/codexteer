import test from "node:test";
import assert from "node:assert/strict";
import { readSnapshot, observeThread, fetchThread, decodeCursor } from "../src/observe.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const thread = (items = [], status = "active") => ({ id: ID, status: { type: status, ...(status === "active" ? { activeFlags: [] } : {}) }, turns: [{ id: "turn", status: status === "active" ? "inProgress" : "completed", items }] });
const msg = (id, text = id) => ({ id, type: "agentMessage", text });

test("read redacts reasoning and outputs by default; an unfinished command update is delivered", () => {
  const first = thread([{ id: "secret", type: "reasoning", content: ["private reasoning"] }, { id: "cmd", type: "commandExecution", command: "test", status: "inProgress", aggregatedOutput: "private output" }]);
  const a = readSnapshot(first);
  assert.equal(JSON.stringify(a).includes("private"), false);
  const second = structuredClone(first); second.turns[0].items[1].status = "completed"; second.turns[0].items[1].exitCode = 0;
  const b = readSnapshot(second, { since: a.cursor, includeOutput: true });
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].change, "updated");
  assert.equal(b.events[0].output, "private output");
  assert.equal(readSnapshot(second, { since: b.cursor }).changed, false);
});

test("delta pagination never skips newly appended items or excess updates", () => {
  const initial = thread([{ id: "a", type: "commandExecution", command: "a", status: "inProgress" }, { id: "b", type: "commandExecution", command: "b", status: "inProgress" }]);
  let cursor = readSnapshot(initial).cursor;
  const next = structuredClone(initial); for (const item of next.turns[0].items) item.status = "completed";
  next.turns[0].items.push(msg("c"), msg("d"));
  const received = [];
  for (let i = 0; i < 4; i++) { const page = readSnapshot(next, { since: cursor, limit: 1 }); received.push(...page.events.map(e => e.id)); cursor = page.cursor; assert.equal(page.has_more, i !== 3); }
  assert.deepEqual(received, ["a", "b", "c", "d"]);
});

test("initial tail is bounded; cursors reject wrong targets, rollback, and rewritten immutable history", () => {
  const data = thread([msg("a"), msg("b"), msg("c")]);
  const a = readSnapshot(data, { limit: 1 });
  assert.deepEqual(a.events.map(x => x.id), ["c"]); assert.equal(a.omitted_older_events, 3);
  assert.throws(() => decodeCursor(a.cursor, "another"), { code: "STALE_CURSOR" });
  assert.throws(() => readSnapshot(thread([]), { since: a.cursor }), { code: "STALE_CURSOR" });
  data.turns[0].items[0].text = "rewritten";
  assert.throws(() => readSnapshot(data, { since: a.cursor }), { code: "STALE_CURSOR" });
  assert.throws(() => readSnapshot(data, { since: "not a cursor" }), { code: "STALE_CURSOR" });
});

test("watch waits for requested condition, returns unconsumed changes, never resumes or answers requests", async () => {
  let n = 0, closed = false, clock = 0; const methods = [];
  const initial = thread([msg("a")]); const since = readSnapshot(initial).cursor;
  const result = await observeThread(ID, { watch: true, since, until: "idle", pollMs: 250, timeoutMs: 1000 }, {
    discover: async () => ({ paths: { socket: "unused" } }), now: () => clock, sleep: async ms => { clock += ms; },
    connect: async () => ({ close() { closed = true; }, async request(method) { methods.push(method); return { thread: thread([msg("a"), ...n++ ? [msg("b")] : []], n >= 3 ? "idle" : "active") }; } }),
  });
  assert.equal(result.reason, "idle"); assert.equal(result.timed_out, false); assert.ok(result.events.some(x => x.id === "b"));
  assert.equal(closed, true); assert.ok(methods.every(x => x === "thread/read"));
});

test("watch times out quietly, surfaces approval flags, and closes on errors", async () => {
  let closed = 0, clock = 0;
  const options = { discover: async () => ({ paths: { socket: "x" } }), now: () => clock, sleep: async ms => { clock += ms; }, connect: async () => ({ close() { closed++; }, request: async () => ({ thread: thread([]) }) }) };
  const r = await observeThread(ID, { watch: true, timeoutMs: 500, pollMs: 250 }, options);
  assert.equal(r.timed_out, true); assert.equal(r.changed, false); assert.equal(closed, 1);
  const waiting = thread([]); waiting.status.activeFlags = ["waitingOnApproval"];
  const a = await observeThread(ID, { watch: true, until: "attention" }, { ...options, connect: async () => ({ close() { closed++; }, request: async () => ({ thread: waiting }) }) });
  assert.equal(a.reason, "attention");
  await assert.rejects(observeThread(ID, {}, { ...options, connect: async () => ({ close() { closed++; }, request: async () => { throw new Error("offline"); } }) }), /offline/);
  assert.equal(closed, 3);
});

test("watch timeout preserves unread changes without an additional history fetch", async () => {
  const initial = thread([msg("a")]), since = readSnapshot(initial).cursor;
  const current = thread([msg("a"), msg("b")]); let reads = 0;
  const result = await observeThread(ID, { watch: true, since, until: "idle", timeoutMs: 0 }, {
    discover: async () => ({ paths: { socket: "unused" } }),
    connect: async () => ({ close() {}, async request() { reads++; return { thread: current }; } }),
  });
  assert.equal(result.timed_out, true); assert.equal(result.changed, true);
  assert.deepEqual(result.events.map(e => e.id), ["b"]);
  assert.equal(reads, 2, "One metadata read and one legacy history read; no extra timeout read");
});

test("a read keeps its connection open until asynchronous history retrieval finishes", async () => {
  let closed = false;
  const result = await observeThread(ID, {}, {
    discover: async () => ({ paths: { socket: "unused" } }),
    connect: async () => ({ close() { closed = true; }, async request() {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false); return { thread: thread([msg("a")]) };
    } }),
  });
  assert.equal(closed, true); assert.ok(result.events.some(e => e.id === "a"));
});

test("paginated history is hydrated without subscription; incomplete pages fail closed", async () => {
  const base = { ...thread([]), historyMode: "paginated" };
  const methods = [];
  const client = { async request(method, p) { methods.push(method); if (method === "thread/read") { assert.equal(p.includeTurns, false); return { thread: base }; } return { data: [{ id: p.cursor ? "t2" : "t1", status: "completed", items: [], itemsView: "full" }], nextCursor: p.cursor ? null : "next" }; } };
  assert.equal((await fetchThread(client, ID)).turns.length, 2);
  assert.deepEqual(methods, ["thread/read", "thread/turns/list", "thread/turns/list"]);
  assert.throws(() => readSnapshot({ ...base, turns: [{ id: "t", itemsView: "summary", items: [] }] }), /Incomplete/);
});
