import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { streamThread, writeObservationLine } from "../src/monitor.mjs";
import { readSnapshot } from "../src/observe.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const task = () => ({ id: ID, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [] }] });
const msg = (id, text = id) => ({ id, type: "agentMessage", text });
function server(thread, sleep) {
  const calls = []; let closed = false;
  return { calls, isClosed: () => closed, deps: {
    discover: async () => ({ paths: { socket: "test" } }), sleep,
    connect: async () => ({ close() { closed = true; }, async request(method) { calls.push(method); return { thread: structuredClone(thread) }; } }),
  } };
}

test("Monitor stream is silent at baseline and unchanged states, emits new items and attention once", async () => {
  const controller = new AbortController(), thread = task(), lines = []; let polls = 0;
  const fake = server(thread, async () => {
    if (++polls === 2) thread.turns[0].items.push(msg("a", "日本語\nsecond line"));
    if (polls === 4) thread.status.activeFlags.push("waitingOnApproval");
    if (polls === 6) controller.abort();
  });
  await streamThread(ID, { signal: controller.signal }, async data => { lines.push(data); }, fake.deps);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].events[0].text, "日本語\nsecond line");
  assert.deepEqual(lines[1].events, []);
  assert.deepEqual(lines[1].attention, ["waitingOnApproval"]);
  assert.equal(fake.isClosed(), true);
  assert.ok(fake.calls.every(method => method === "thread/read"));
});

test("Monitor resumes all cursor pages in order and awaits the consumer before reading again", async () => {
  const controller = new AbortController(), thread = task();
  const since = readSnapshot(thread).cursor;
  thread.turns[0].items.push(msg("a"), msg("b"), msg("c"));
  const seen = [], fake = server(thread, async () => controller.abort());
  await streamThread(ID, { since, limit: 1, signal: controller.signal }, async data => {
    const count = fake.calls.length;
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(fake.calls.length, count);
    seen.push(...data.events.map(e => e.id));
  }, fake.deps);
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("Monitor stops on stale history or a failed consumer without silently rebasing or reconnecting", async () => {
  const thread = task(); thread.turns[0].items.push(msg("a"), msg("b"));
  const since = readSnapshot(thread).cursor;
  thread.turns[0].items[0].text = "rewritten";
  const fake = server(thread, async () => assert.fail("must not poll after failure"));
  await assert.rejects(streamThread(ID, { since }, async () => assert.fail("no events"), fake.deps), { code: "STALE_CURSOR" });
  assert.equal(fake.isClosed(), true); assert.equal(fake.calls.length, 2); // Metadata, then the legacy full read; no retry.
  thread.turns[0].items[0].text = "a"; thread.turns[0].items.push(msg("c"));
  await assert.rejects(streamThread(ID, { since }, async () => { throw new Error("consumer failed"); }, fake.deps), /consumer failed/);
});

test("Monitor cancellation closes an in-flight read and cancellation during sleep is quiet", async () => {
  const controller = new AbortController(); let rejectRead, closed = false;
  const deps = { discover: async () => ({ paths: { socket: "test" } }), connect: async () => ({
    close() { closed = true; rejectRead?.(new Error("closed")); },
    request() { return new Promise((resolve, reject) => { rejectRead = reject; queueMicrotask(() => controller.abort()); }); },
  }) };
  await streamThread(ID, { signal: controller.signal }, async () => assert.fail("cancelled"), deps);
  assert.equal(closed, true);
  const sleeping = new AbortController(), fake = server(task(), undefined);
  const run = streamThread(ID, { pollMs: 10000, signal: sleeping.signal }, async () => assert.fail("no change"), fake.deps);
  setTimeout(() => sleeping.abort(), 10);
  await run;
  assert.equal(fake.isClosed(), true);
  await streamThread(ID, { signal: sleeping.signal }, async () => {}, { discover: async () => assert.fail("already cancelled") });
});

test("JSON Lines preserve multiline text and wait for slow output to flush", async () => {
  const chunks = []; let flush;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { chunks.push(chunk.toString()); flush = callback; } });
  const data = { events: [{ text: "日本語\nline 2" }], cursor: "cursor" };
  let finished = false;
  const writing = writeObservationLine(output, data).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  flush(); await writing;
  assert.equal(chunks.join("").split("\n").length, 2);
  assert.deepEqual(JSON.parse(chunks[0]), { ok: true, command: "watch", data });
});
