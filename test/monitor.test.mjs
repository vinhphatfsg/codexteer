import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { streamThread, writeObservationLine } from "../src/monitor.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { RpcFailure } from "../src/rpc.mjs";
import { RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerSupervisor, supervisorStatus } from "../src/supervision.mjs";

const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";
const task = () => ({ id: ID, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [] }] });
const msg = (id, text = id) => ({ id, type: "agentMessage", text });
function server(thread, sleep) {
  const calls = []; let closed = false;
  return { calls, isClosed: () => closed, deps: {
    discover: async () => ({ paths: { socket: "test" } }), sleep,
    connect: async () => ({ close() { closed = true; }, async request(method) { calls.push(method); return { thread: structuredClone(thread) }; } }),
  } };
}

test("Monitor announces observation once and stays quiet when unchanged", async () => {
  const controller = new AbortController(), thread = task(), lines = []; let polls = 0;
  const fake = server(thread, async () => {
    if (++polls === 2) thread.turns[0].items.push(msg("a", "日本語\nsecond line"));
    if (polls === 4) thread.status.activeFlags.push("waitingOnApproval");
    if (polls === 6) controller.abort();
  });
  const connections = [];
  await streamThread(ID, { notify: "all", signal: controller.signal }, async data => { (data.type === "connection" ? connections : lines).push(data); }, fake.deps);
  assert.deepEqual(connections.map(x => x.state), ["watching"]);
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
  await streamThread(ID, { notify: "all", since, limit: 1, signal: controller.signal }, async data => {
    if (data.type === "connection") return;
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
  await assert.rejects(streamThread(ID, { notify: "all", since }, async () => assert.fail("no events"), fake.deps), { code: "STALE_CURSOR" });
  assert.equal(fake.isClosed(), true); assert.equal(fake.calls.length, 2); // Metadata, then the legacy full read; no retry.
  thread.turns[0].items[0].text = "a"; thread.turns[0].items.push(msg("c"));
  await assert.rejects(streamThread(ID, { notify: "all", since }, async () => { throw new Error("consumer failed"); }, fake.deps), /consumer failed/);
});

test("Monitor cancellation closes an in-flight read and cancellation during sleep is quiet", async () => {
  const controller = new AbortController(); let rejectRead, closed = false;
  const deps = { discover: async () => ({ paths: { socket: "test" } }), connect: async () => ({
    close() { closed = true; rejectRead?.(new Error("closed")); },
    request() { return new Promise((resolve, reject) => { rejectRead = reject; queueMicrotask(() => controller.abort()); }); },
  }) };
  await streamThread(ID, { notify: "all", signal: controller.signal }, async () => assert.fail("cancelled"), deps);
  assert.equal(closed, true);
  const sleeping = new AbortController(), fake = server(task(), undefined);
  const run = streamThread(ID, { notify: "all", pollMs: 10000, signal: sleeping.signal }, async data => assert.equal(data.type, "connection"), fake.deps);
  setTimeout(() => sleeping.abort(), 10);
  await run;
  assert.equal(fake.isClosed(), true);
  await streamThread(ID, { notify: "all", signal: sleeping.signal }, async () => {}, { discover: async () => assert.fail("already cancelled") });
});

test("a cut between pages rediscovers the runtime and resumes after flushed events", async () => {
  const controller = new AbortController(), thread = task(), since = readSnapshot(thread).cursor;
  thread.turns[0].items.push(msg("a"), msg("b"), msg("c"));
  const output = [], sockets = [], homes = []; let connections = 0, reads = 0;
  await streamThread(ID, { notify: "all", since, limit: 1, signal: controller.signal }, async data => {
    output.push(data);
    if (data.type === "observation") {
      const count = reads;
      await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(reads, count, "No reads advance while output is pending");
      if (data.events.some(e => e.id === "d")) controller.abort();
    }
  }, {
    discover: async home => { homes.push(home); return { paths: { socket: `socket-${homes.length}` } }; },
    connect: async socket => {
      sockets.push(socket); const generation = ++connections;
      if (generation === 2) thread.turns[0].items.push(msg("d"));
      return { close() {}, async request(method, params) {
        assert.equal(method, "thread/read"); assert.equal(params.threadId, ID);
        if (generation === 1 && reads >= 2) throw new RpcFailure("disconnected");
        reads++; return { thread: structuredClone(thread) };
      } };
    }, sleep: async ms => assert.equal(ms, 1000),
  });
  const observations = output.filter(x => x.type === "observation"), states = output.filter(x => x.type === "connection");
  assert.deepEqual(observations.flatMap(x => x.events.map(e => e.id)), ["a", "b", "c", "d"]);
  assert.deepEqual(states.map(x => x.state), ["watching", "reconnecting", "recovered"]);
  assert.equal(states[1].resume_cursor, observations[0].cursor);
  assert.deepEqual(sockets, ["socket-1", "socket-2"]);
  assert.equal(new Set(homes).size, 1);
});

test("reconnect accepts different compatible releases and stops before an incompatible runtime", async () => {
  for (const incompatible of [false, true]) {
    const stop = new AbortController(), states = []; let connections = 0, discoveries = 0, reads = 0;
    const run = streamThread(ID, { notify: "all", signal: stop.signal }, async data => {
      if (data.type === "connection") states.push(data.state);
      if (data.state === "recovered") stop.abort();
    }, {
      discover: async () => ({ paths: { socket: "same" }, state: {
        codex_steer_version: ++discoveries === 1 ? "0.13.0" : "99.0.0", codex_steer_protocol: 1,
        codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, thread_read: incompatible && discoveries > 1 ? [2] : [1] },
      } }),
      connect: async () => {
        const generation = ++connections;
        return { close() {}, async request(method) {
          assert.equal(method, "thread/read");
          if (generation === 1 && ++reads > 2) throw new RpcFailure("disconnected");
          return { thread: task() };
        } };
      }, sleep: async () => {},
    });
    if (incompatible) {
      await assert.rejects(run, error => error.code === "CAPABILITY_UNSUPPORTED" && error.watch.state === "failed");
      assert.equal(connections, 1);
      assert.deepEqual(states, ["watching", "reconnecting"]);
    } else {
      await run;
      assert.equal(connections, 2);
      assert.deepEqual(states, ["watching", "reconnecting", "recovered"]);
    }
  }
});

test("reconnect backoff is capped and the complete outage has a finite deadline", async () => {
  let elapsed = 0, discoveries = 0, reads = 0;
  const waits = [], states = [];
  await assert.rejects(streamThread(ID, { notify: "all",}, async data => states.push(data), {
    now: () => elapsed,
    discover: async () => {
      if (++discoveries > 1) throw Object.assign(new Error("offline"), { code: "RUNTIME_UNAVAILABLE" });
      return { paths: { socket: "first" } };
    },
    connect: async () => ({ close() {}, async request() {
      if (++reads > 2) throw new RpcFailure("read timed out", { code: "TIMEOUT" });
      return { thread: task() };
    } }),
    sleep: async ms => { waits.push(ms); elapsed += ms; },
  }), error => {
    assert.equal(error.code, "WATCH_RECONNECT_TIMEOUT");
    assert.equal(error.watch.state, "failed");
    assert.equal(error.watch.resume_cursor, states[0].resume_cursor);
    assert.equal(error.watch.cause_code, "RUNTIME_UNAVAILABLE");
    return true;
  });
  assert.deepEqual(waits.slice(1), [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 5000]);
  assert.equal(elapsed, 61000); // One ordinary poll, then 60 seconds of recovery.
  assert.deepEqual(states.map(x => x.state), ["watching", "reconnecting"]);
});

test("permissions, protocol failures, unsupported APIs and stale history do not reconnect", async () => {
  for (const code of ["PERMISSION_DENIED", "PROTOCOL_ERROR", "PAYLOAD_TOO_LARGE", "RPC_REJECTED", "RUNTIME_UNSAFE", "RUNTIME_INVALID", "STALE_CURSOR", "CURSOR_UPGRADE_REQUIRED"]) {
    let failed = false, connections = 0;
    await assert.rejects(streamThread(ID, { notify: "all",}, async () => {}, {
      discover: async () => ({ paths: { socket: "fake" } }),
      connect: async () => { connections++; return { close() {}, async request() {
        if (failed) throw new RpcFailure("fatal", { code });
        return { thread: task() };
      } }; },
      sleep: async () => { failed = true; },
    }), error => error.code === code && error.watch.state === (code.includes("CURSOR") ? "needs_review" : "failed"));
    assert.equal(connections, 1);
  }
});

test("consumer failures are never retried even when their code resembles a transport failure", async () => {
  const thread = task(); let connections = 0;
  await assert.rejects(streamThread(ID, { notify: "all",}, async data => {
    if (data.type === "observation") throw new RpcFailure("consumer timeout", { code: "TIMEOUT" });
  }, {
    discover: async () => ({ paths: { socket: "fake" } }),
    connect: async () => { connections++; return { close() {}, async request() { return { thread: structuredClone(thread) }; } }; },
    sleep: async () => { thread.turns[0].items.push(msg("a")); },
  }), /consumer timeout/);
  assert.equal(connections, 1);
});

test("reconnect deadline and user cancellation interrupt pending initialization", { timeout: 3000 }, async () => {
  for (const cancelByUser of [false, true]) {
    const stop = new AbortController(); let connections = 0, reads = 0, aborted = false;
    const run = streamThread(ID, { notify: "all", signal: stop.signal, reconnectTimeoutMs: 30 }, async () => {}, {
      discover: async () => ({ paths: { socket: "fake" } }), sleep: async () => {},
      connect: async (_socket, { signal }) => {
        if (++connections === 1) return { close() {}, async request() {
          if (++reads > 2) throw new RpcFailure("disconnected");
          return { thread: task() };
        } };
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(new RpcFailure("cancelled", { code: "CANCELLED" })); }, { once: true });
          if (cancelByUser) queueMicrotask(() => stop.abort());
        });
      },
    });
    if (cancelByUser) await run;
    else await assert.rejects(run, { code: "WATCH_RECONNECT_TIMEOUT" });
    assert.equal(aborted, true);
    assert.equal(connections, 2);
  }
});

test("startup failure is immediate and cancellation during backoff does not reconnect", async () => {
  await assert.rejects(streamThread(ID, { notify: "all",}, async () => assert.fail("no observation established"), {
    discover: async () => { throw Object.assign(new Error("offline"), { code: "RUNTIME_UNAVAILABLE" }); },
    sleep: async () => assert.fail("no startup retry"),
  }), error => error.code === "RUNTIME_UNAVAILABLE" && error.watch.state === "failed" && error.watch.resume_cursor === null);
  const stop = new AbortController(); let reads = 0, connections = 0, waits = 0;
  await streamThread(ID, { notify: "all", signal: stop.signal }, async () => {}, {
    discover: async () => ({ paths: { socket: "fake" } }),
    connect: async () => { connections++; return { close() {}, async request() {
      if (++reads > 2) throw new RpcFailure("cut");
      return { thread: task() };
    } }; },
    sleep: async () => { if (++waits === 2) stop.abort(); },
  });
  assert.equal(connections, 1);
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

async function replay({ options = {}, at = [], end = 5000, initial = [], onLine } = {}) {
  const thread = task(), stop = new AbortController(), output = [];
  thread.turns[0].items.push(...initial);
  const since = readSnapshot(thread).cursor;
  let elapsed = 0, index = 0;
  const fake = server(thread, async ms => {
    elapsed += ms;
    while (index < at.length && at[index][0] <= elapsed) at[index++][1](thread);
    if (elapsed >= end) stop.abort();
  });
  await streamThread(ID, { since, pollMs: 1000, ...options, signal: stop.signal }, async data => {
    output.push({ ...data, at: elapsed }); await onLine?.(data, elapsed);
  }, { ...fake.deps, now: () => elapsed });
  return { output, observations: output.filter(x => x.type === "observation"), thread, since };
}
const command = (id, executable, status = "completed", exitCode = 0) => ({ id, type: "commandExecution", command: executable, status, exitCode, aggregatedOutput: "tool output" });

test("digest is the default; all explicitly preserves each immediate observation", async () => {
  const at = [[1000, t => t.turns[0].items.push(msg("a"))], [2000, t => t.turns[0].items.push(msg("b"))]];
  const all = await replay({ options: { notify: "all" }, at });
  assert.deepEqual(all.observations.map(x => [x.at, x.events.map(e => e.id)]), [[1000, ["a"]], [2000, ["b"]]]);
  assert.ok(all.output.every(x => !Object.hasOwn(x, "digest")));
  const digest = await replay({ options: { settleMs: 1000 }, at });
  assert.equal(digest.observations.length, 1);
  assert.deepEqual(digest.observations[0].events.map(e => e.id), ["a", "b"]);
  assert.equal(digest.observations[0].at, 3000);
  assert.equal(digest.observations[0].digest.reason, "settle");
  assert.equal(digest.observations[0].digest.from_cursor, digest.since);
  assert.equal(readSnapshot(digest.thread, { since: digest.observations[0].cursor }).changed, false);
});

test("digest and all establish a silent initial baseline without --since", async () => {
  for (const notify of ["all", "digest"]) {
    const thread = task(), stop = new AbortController(), output = [];
    thread.turns[0].items.push({ id: "user", type: "userMessage", content: [{ type: "text", text: "old request" }] }, msg("old"));
    const fake = server(thread, async () => stop.abort());
    await streamThread(ID, { notify, signal: stop.signal }, data => output.push(data), fake.deps);
    assert.deepEqual(output.map(x => x.type), ["connection"]);
    assert.equal(output[0].resume_cursor, readSnapshot(thread).cursor);
  }
});

test("wake immediately includes held events, including failed read-only commands", async () => {
  const result = await replay({ at: [
    [1000, t => t.turns[0].items.push(command("read", "rg missing src", "failed", 1))],
    [2000, t => t.turns[0].items.push({ id: "user", type: "userMessage", content: [{ type: "text", text: "stop" }] })],
  ] });
  assert.equal(result.observations.length, 1);
  const data = result.observations[0];
  assert.equal(data.at, 2000); assert.equal(data.digest.reason, "wake:userMessage");
  assert.deepEqual(data.events.map(e => e.id), ["read", "user"]);
  assert.equal(data.events[0].compacted, true); assert.equal(data.has_more, false);
});

test("quiet updates do not postpone settle, and output-only progress does not starve file changes", async () => {
  const result = await replay({ options: { settleMs: 2000, includeOutput: true }, initial: [command("test", "npm test", "inProgress", null)], at: [
    [1000, t => t.turns[0].items.push({ id: "edit", type: "fileChange", status: "completed", changes: [{ path: "a", diff: "keep diff" }] })],
    ...[2000, 3000, 4000].map(time => [time, t => { t.turns[0].items[0].aggregatedOutput = `progress ${time}`; }]),
  ] });
  const data = result.observations[0];
  assert.equal(data.at, 3000); assert.equal(data.digest.reason, "settle");
  assert.deepEqual(data.events.map(e => e.id), ["edit", "test"]);
  assert.equal(data.events[0].changes[0].diff, "keep diff");
  assert.equal(data.events[1].compacted, true);
  assert.equal("output" in data.running_commands[0], false);
});

test("max-hold flushes quiet traffic and continuous normal traffic from the oldest event", async () => {
  for (const quiet of [true, false]) {
    const result = await replay({ options: { maxHoldMs: 10000, settleMs: 2000 }, end: 12000,
      at: Array.from({ length: 10 }, (_, i) => [(i + 1) * 1000, t => t.turns[0].items.push(quiet ? command(`c${i}`, "cat a") : msg(`m${i}`))]),
    });
    assert.equal(result.observations[0].at, 11000);
    assert.equal(result.observations[0].digest.reason, "max-hold");
    assert.equal(result.observations[0].events.length, 10);
  }
});

test("state-only attention and status changes wake and release held events", async () => {
  const result = await replay({ at: [
    [1000, t => t.turns[0].items.push(command("read", "cat a"))],
    [2000, t => { t.status.activeFlags = ["waitingOnApproval"]; }],
    [3000, t => { t.status.activeFlags = []; }],
    [4000, t => { t.status.type = "idle"; }],
  ], end: 5000 });
  assert.deepEqual(result.observations.map(x => [x.at, x.digest.reason]), [[2000, "wake:attention"], [3000, "wake:attention"], [4000, "wake:status"]]);
  assert.deepEqual(result.observations[0].events.map(e => e.id), ["read"]);
  assert.deepEqual(result.observations[1].events, []);
});

test("resuming with an existing cursor wakes a simultaneous status change and quiet event", async () => {
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), output = [];
  thread.status.type = "idle";
  thread.turns[0].items.push(command("read", "cat a"));
  const fake = server(thread, async () => stop.abort());
  await streamThread(ID, { since, signal: stop.signal }, data => output.push(data), fake.deps);
  assert.equal(output[0].digest.reason, "wake:state");
  assert.deepEqual(output[0].events.map(e => e.id), ["read"]);
});

test("unchanged attention does not emit repeated wake notifications", async () => {
  const result = await replay({ at: [[1000, t => { t.status.activeFlags = ["waitingOnApproval"]; }]], end: 5000 });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].at, 1000);
});

test("digest drains pages without polling and emits their final cursor after a capacity boundary", async () => {
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), lines = [];
  thread.turns[0].items.push(...Array.from({ length: 205 }, (_, i) => command(`c${i}`, "cat a")));
  const fake = server(thread, async () => stop.abort());
  await streamThread(ID, { since, limit: 50, signal: stop.signal }, data => lines.push(data), fake.deps);
  const observations = lines.filter(x => x.type === "observation");
  assert.equal(observations.length, 1); assert.equal(observations[0].events.length, 205);
  assert.equal(observations[0].has_more, false); assert.equal(observations[0].digest.reason, "capacity");
  assert.equal(readSnapshot(thread, { since: observations[0].cursor }).changed, false);
  assert.equal(lines[0].state, "watching"); assert.equal(lines[0].resume_cursor, since, "Connection cursor must not acknowledge buffered pages");
});

test("digest flushes a partial page before reconnecting and resumes the remaining events", async () => {
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), output = [];
  thread.turns[0].items.push(command("a", "cat a"), command("b", "cat b"), msg("final"));
  thread.turns[0].items[2].phase = "final_answer";
  let generation = 0, reads = 0;
  await streamThread(ID, { since, limit: 1, signal: stop.signal }, data => output.push(data), {
    discover: async () => ({ paths: { socket: "fake" } }),
    connect: async () => {
      const current = ++generation;
      return { close() {}, async request() {
        if (current === 1 && ++reads > 2) throw new RpcFailure("cut");
        return { thread: structuredClone(thread) };
      } };
    }, sleep: async () => { if (generation > 1) stop.abort(); },
  });
  const partialIndex = output.findIndex(x => x.digest?.reason === "reconnecting"), partial = output[partialIndex];
  assert.equal(partial.has_more, true); assert.deepEqual(partial.events.map(e => e.id), ["a"]);
  assert.equal(output[partialIndex + 1].state, "reconnecting");
  assert.equal(output[partialIndex + 1].resume_cursor, partial.cursor);
  const last = output.find(x => x.digest?.reason === "wake:agentMessage");
  assert.equal(last.has_more, false); assert.deepEqual(last.events.map(e => e.id), ["b", "final"]);
  assert.equal(last.digest.from_cursor, partial.cursor);
});

test("digest flushes on cancellation, including between pages", async () => {
  const result = await replay({ at: [[1000, t => t.turns[0].items.push(command("read", "cat a"))]], end: 2000 });
  assert.equal(result.observations[0].digest.reason, "stopped");
  assert.deepEqual(result.observations[0].events.map(e => e.id), ["read"]);
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), output = [];
  thread.turns[0].items.push(command("a", "cat a"), command("b", "cat b"));
  const fake = server(thread, async () => assert.fail("must not poll between pages"));
  await streamThread(ID, { since, limit: 1, signal: stop.signal }, data => { output.push(data); if (data.type === "connection") stop.abort(); }, fake.deps);
  assert.equal(output.at(-1).has_more, true);
  assert.equal(output.at(-1).digest.reason, "stopped");
  assert.deepEqual(output.at(-1).events.map(e => e.id), ["a"]);
  assert.deepEqual(readSnapshot(thread, { since: output.at(-1).cursor }).events.map(e => e.id), ["b"]);
});

test("output failure makes one best-effort pending flush without reconnecting or acknowledging it", async () => {
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), output = [];
  thread.turns[0].items.push(command("a", "cat a"));
  const fake = server(thread, async () => assert.fail("must stop"));
  const error = Object.assign(new Error("output failed"), { code: "EPIPE" });
  await assert.rejects(streamThread(ID, { since, signal: stop.signal }, data => { output.push(data); throw error; }, fake.deps), e => {
    assert.equal(e, error); assert.equal(e.watch.resume_cursor, since); return true;
  });
  assert.deepEqual(output.map(x => x.type), ["connection", "observation"]);
  assert.equal(output[1].digest.reason, "failed");
  assert.deepEqual(output[1].events.map(e => e.id), ["a"]);
});

test("supervisor observation timestamps advance while digest notifications are held", async t => {
  const home = await mkdtemp("/private/tmp/ct-digest-"), previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; await rm(home, { recursive: true, force: true }); });
  const session = "22222222-2222-4222-8222-222222222222";
  await registerSupervisor(ID, session, { home });
  const thread = task(), since = readSnapshot(thread).cursor, stop = new AbortController(), lines = [];
  let sleeps = 0;
  const fake = server(thread, async () => {
    const status = await supervisorStatus(ID, { home });
    assert.ok(status.observation.last_observed_at);
    if (++sleeps === 1) thread.turns[0].items.push(command("read", "cat a"));
    else { assert.equal(lines.filter(x => x.type === "observation").length, 0); stop.abort(); }
  });
  await streamThread(ID, { since, supervisor: session, signal: stop.signal }, data => lines.push(data), fake.deps);
  assert.equal(lines.at(-1).digest.reason, "stopped");
});
