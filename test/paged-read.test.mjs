import test from "node:test";
import assert from "node:assert/strict";
import { readOnClient, readSnapshot, decodeCursor, observeThread } from "../src/observe.mjs";
import { verifyPagedFreshness } from "../src/paged-read.mjs";
import { streamThread } from "../src/monitor.mjs";
import { sendOnClient } from "../src/app-server.mjs";
import { prepareDirective } from "../src/directive.mjs";

const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";
const msg = (id, text = id) => ({ id, type: "agentMessage", text });
const user = (id, text = id) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const cmd = (id, status = "inProgress", output = "") => ({ id, type: "commandExecution", command: "test", status, aggregatedOutput: output });
const task = (items = [], status = "active") => ({ id: ID, historyMode: "paginated", status: { type: status, activeFlags: [] }, turns: [{ id: "t0", status: status === "active" ? "inProgress" : "completed", items }] });

function server(thread, beforeRequest = () => {}) {
  const calls = [];
  const key = x => x.item ? `${x.turnId}/${x.item.id}` : x.id;
  const client = { close() {}, async request(method, p) {
    await beforeRequest(method, p);
    calls.push({ method, ...p });
    assert.equal(p.threadId, ID);
    if (method === "thread/read") { assert.equal(p.includeTurns, false); return { thread: { ...structuredClone(thread), turns: [] } }; }
    assert.ok(["thread/items/list", "thread/turns/list"].includes(method));
    const scope = `${method}:${p.turnId ?? "all"}`;
    const rows = method === "thread/items/list" ? thread.turns.filter(t => !p.turnId || t.id === p.turnId).flatMap(t => t.items.map(item => ({ item, turnId: t.id }))) : thread.turns.map(t => {
      if (p.itemsView === "full") return t;
      assert.equal(p.itemsView, "notLoaded"); return { ...t, items: [], itemsView: "notLoaded" };
    });
    const sorted = p.sortDirection === "desc" ? [...rows].reverse() : rows;
    let start = 0;
    if (p.cursor) { const c = JSON.parse(p.cursor); assert.equal(c.scope, scope); start = sorted.findIndex(x => key(x) === c.id); if (start < 0) throw Object.assign(new Error("anchor missing"), { code: "STALE_CURSOR" }); if (!c.include) start++; }
    const data = sorted.slice(start, start + p.limit);
    const token = (row, include) => JSON.stringify({ scope, id: key(row), include });
    return structuredClone({ data, backwardsCursor: data.length ? token(data[0], true) : null, nextCursor: start + data.length < sorted.length ? token(data.at(-1), false) : null });
  } };
  return { client, calls, read: options => readOnClient(client, ID, options) };
}

test("digest drains v2 pages and its cursor replays compacted details without skipping events", async () => {
  const thread = task([user("u")]), fake = server(thread), baseline = await fake.read(), stop = new AbortController(), lines = [];
  thread.turns[0].items.push(...Array.from({ length: 8 }, (_, i) => ({ ...cmd(`read${i}`, "completed", `details ${i}`), command: "rg foo src", exitCode: 0 })), { ...msg("final"), phase: "final_answer" });
  await streamThread(ID, { since: baseline.cursor, limit: 2, includeOutput: true, signal: stop.signal }, data => lines.push(data), {
    discover: async () => ({ paths: { socket: "fake" } }), connect: async () => fake.client, sleep: async () => stop.abort(),
  });
  const notifications = lines.filter(line => line.type === "observation");
  assert.equal(notifications.length, 1);
  const data = notifications[0];
  assert.equal(data.has_more, false); assert.equal(decodeCursor(data.cursor, ID).pending, false);
  assert.deepEqual(data.events.map(event => event.id), [...Array.from({ length: 8 }, (_, i) => `read${i}`), "final"]);
  assert.ok(data.events.slice(0, 8).every(event => event.compacted && !("output" in event)));
  assert.equal(data.digest.from_cursor, baseline.cursor);
  const details = await fake.read({ since: data.digest.from_cursor, includeOutput: true });
  assert.equal(details.events[0].output, "details 0");
  assert.equal((await fake.read({ since: data.cursor })).changed, false);
});

test("paged initial tail matches full display while excluding large past payloads", async () => {
  const t = task([msg("old", "x".repeat(1000000))], "notLoaded");
  t.turns.push({ id: "latest", status: "completed", items: Array.from({ length: 250 }, (_, i) => i % 3 ? msg(`a${i}`) : { id: `r${i}`, type: "reasoning", text: "hidden" }) });
  const s = server(t), r = await s.read();
  assert.deepEqual(r.events, readSnapshot(t).events);
  assert.equal(r.omitted_older_events, null); assert.equal(decodeCursor(r.cursor, ID).v, 2);
  assert.ok(s.calls.filter(c => c.method === "thread/turns/list").every(c => c.itemsView === "notLoaded"));
  assert.ok(s.calls.filter(c => c.method === "thread/items/list").reduce((sum, c) => sum + c.limit, 0) < 150);
  s.calls.length = 0;
  const delta = await s.read({ since: r.cursor });
  assert.equal(delta.changed, false); assert.deepEqual(delta.events, []);
  assert.ok(s.calls.length <= 4); assert.equal(delta.history_scope, "tail-and-tracked-items");
});

test("paged send preserves v2 freshness checks without fetching full history", async () => {
  for (const stale of [false, true]) {
    const t = task([user("u"), msg("reply")]), s = server(t);
    const observed = await s.read();
    const directive = await prepareDirective(ID, "check", { basedOn: observed.cursor }, "id");
    t.turns[0].items.push(stale ? user("new-user") : msg("progress"));
    let writes = 0;
    const client = { async request(method, params) {
      if (method !== "turn/steer") return s.client.request(method, params);
      writes++; return { turnId: params.expectedTurnId };
    } };
    const send = sendOnClient(client, ID, directive.wireText, { beforeSend: directive.beforeSend });
    if (stale) await assert.rejects(send, { code: "STALE_OBSERVATION" });
    else assert.equal((await send).turn_id, "t0");
    assert.equal(writes, stale ? 0 : 1);
    assert.ok(s.calls.filter(call => call.method === "thread/turns/list").every(call => call.itemsView === "notLoaded"));
  }
});

test("v1 freshness checks never treat paged send summaries as full item history", async () => {
  for (const stale of [false, true]) {
    const t = task([user("u")]), observed = readSnapshot(t), s = server(t);
    const directive = await prepareDirective(ID, "check", { basedOn: observed.cursor }, "id");
    if (stale) t.turns[0].items.push(user("new-user"));
    let writes = 0;
    const client = { async request(method, params) {
      if (method !== "turn/steer") return s.client.request(method, params);
      writes++; return { turnId: params.expectedTurnId };
    } };
    const send = sendOnClient(client, ID, directive.wireText, { beforeSend: directive.beforeSend });
    if (stale) await assert.rejects(send, { code: "STALE_OBSERVATION" });
    else assert.equal((await send).turn_id, "t0");
    assert.equal(writes, stale ? 0 : 1);
    assert.ok(s.calls.some(call => call.method === "thread/turns/list" && call.itemsView === "full"), "v1 must still validate the full user-input history");
  }
});

test("paged reads deliver old running-command updates outside the visible tail without rescanning the turn", async () => {
  const t = task([user("u"), cmd("command"), ...Array.from({ length: 600 }, (_, i) => msg(`a${i}`))]);
  const s = server(t), a = await s.read({ limit: 2 });
  assert.ok(a.running_commands.some(e => e.id === "command"));
  t.turns[0].items[1].aggregatedOutput = "partial";
  s.calls.length = 0;
  const b = await s.read({ since: a.cursor, includeOutput: true });
  assert.equal(b.events.find(e => e.id === "command").output, "partial");
  assert.ok(s.calls.filter(c => c.method === "thread/items/list").length < 5);
  t.turns[0].items[1].status = "completed"; t.turns[0].items[1].exitCode = 0;
  const c = await s.read({ since: b.cursor });
  assert.equal(c.events.find(e => e.id === "command").change, "updated");
  assert.equal(c.running_commands.length, 0);
  assert.equal((await s.read({ since: c.cursor })).changed, false);
});

test("one-event pages preserve both pending updates and new items across multiple turns", async () => {
  const t = task([cmd("c1"), cmd("c2"), msg("last")]);
  const s = server(t); let cursor = (await s.read()).cursor;
  t.turns[0].items[0].status = "completed"; t.turns[0].items[1].status = "completed";
  t.turns[0].status = "completed";
  t.turns.push({ id: "empty", status: "completed", items: [] }, { id: "next", status: "inProgress", items: [user("new-user"), msg("answer")] });
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const page = await s.read({ since: cursor, limit: 1 }); seen.push(...page.events.map(e => e.id)); cursor = page.cursor;
    if (!page.has_more) break;
  }
  assert.deepEqual(seen, ["t0", "c1", "c2", "empty", "next", "new-user", "answer"]);
  assert.equal((await s.read({ since: cursor })).changed, false);
});

test("large backlog pages advance without duplication, including hidden-only pages", async () => {
  const t = task([msg("initial")]), s = server(t); let cursor = (await s.read()).cursor;
  t.turns[0].items.push(...Array.from({ length: 340 }, (_, i) => i < 180 ? { id: `r${i}`, type: "reasoning" } : msg(`a${i}`)));
  const seen = [];
  for (let i = 0; i < 30; i++) { const r = await s.read({ since: cursor, limit: 17 }); seen.push(...r.events.map(e => e.id)); cursor = r.cursor; if (!r.has_more) break; }
  assert.deepEqual(seen, Array.from({ length: 160 }, (_, i) => `a${i + 180}`));
  assert.equal((await s.read({ since: cursor })).changed, false);
});

test("hidden backlog has a bounded read budget and retains the next public change", async () => {
  const t = task([msg("initial")], "idle"), s = server(t), initial = await s.read();
  t.turns[0].items.push(...Array.from({ length: 1600 }, (_, i) => ({ id: `r${i}`, type: "reasoning" })), msg("after-hidden"));
  s.calls.length = 0;
  const first = await s.read({ since: initial.cursor });
  assert.equal(first.changed, false); assert.equal(first.has_more, true);
  assert.equal(first.running_commands_complete, false);
  assert.ok(s.calls.filter(c => c.method === "thread/items/list").length <= 14);
  let cursor = first.cursor; const seen = [];
  for (let i = 0; i < 10; i++) {
    const page = await s.read({ since: cursor }); cursor = page.cursor; seen.push(...page.events.map(e => e.id));
    if (!page.has_more) break;
  }
  assert.deepEqual(seen, ["after-hidden"]);
  assert.equal((await s.read({ since: cursor })).changed, false);
});

test("an append during the tail bookmark lookup is returned by the next read", async () => {
  const t = task([msg("initial")], "idle"); let append = false;
  const s = server(t, (method, p) => {
    if (append && method === "thread/items/list" && p.sortDirection === "desc" && p.limit === 1) {
      append = false; t.turns[0].items.push(msg("raced"));
    }
  });
  const initial = await s.read(); t.turns[0].items.push(msg("first")); append = true;
  const first = await s.read({ since: initial.cursor });
  assert.deepEqual(first.events.map(e => e.id), ["first"]);
  const next = await s.read({ since: first.cursor });
  assert.deepEqual(next.events.map(e => e.id), ["raced"]);
  assert.equal((await s.read({ since: next.cursor })).changed, false);
});

test("a turn starting between metadata and items retries once without resetting the cursor", async () => {
  const t = task([msg("initial")]); let startTurn = false;
  const s = server(t, method => {
    if (startTurn && method === "thread/items/list") {
      startTurn = false; t.turns[0].status = "completed";
      t.turns.push({ id: "next", status: "inProgress", items: [user("new-input")] });
    }
  });
  const initial = await s.read(); startTurn = true; s.calls.length = 0;
  const delta = await s.read({ since: initial.cursor });
  assert.deepEqual(delta.events.map(e => e.id), ["t0", "next", "new-input"]);
  assert.equal(s.calls.filter(c => c.method === "thread/read").length, 2);
  assert.equal((await s.read({ since: delta.cursor })).changed, false);
});

test("watch drains hidden-only pages without waiting or losing the next change", async () => {
  const t = task([msg("initial")], "idle"), s = server(t), initial = await s.read();
  t.turns[0].items.push(...Array.from({ length: 1600 }, (_, i) => ({ id: `r${i}`, type: "reasoning" })), msg("next-public"));
  const delta = await observeThread(ID, { watch: true, since: initial.cursor }, {
    discover: async () => ({ paths: { socket: "unused" } }), connect: async () => s.client,
    sleep: async () => assert.fail("Available pages must be read before polling"),
  });
  assert.deepEqual(delta.events.map(e => e.id), ["next-public"]); assert.equal(delta.reason, "change");
});

test("the latest public message remains mutable behind hidden raw items", async () => {
  const t = task([user("u"), msg("answer"), { id: "hidden", type: "reasoning" }], "idle"), s = server(t);
  const initial = await s.read(); t.turns[0].items[1].text = "finished answer";
  const next = await s.read({ since: initial.cursor });
  assert.deepEqual(next.events.map(e => [e.id, e.text, e.change]), [["answer", "finished answer", "updated"]]);
  assert.equal((await s.read({ since: next.cursor })).changed, false);
});

test("empty histories and empty turns still provide a cursor and report turn changes", async () => {
  const t = task([], "idle"), s = server(t); t.turns = [];
  const initial = await s.read(); assert.deepEqual(initial.events, []);
  t.turns.push({ id: "empty", status: "inProgress", items: [] }); t.status.type = "active";
  const started = await s.read({ since: initial.cursor }); assert.equal(started.events[0].id, "empty");
  t.turns[0].items.push(user("u"));
  const input = await s.read({ since: started.cursor }); assert.equal(input.events[0].id, "u");
  t.turns[0].status = "completed"; t.status.type = "idle";
  const done = await s.read({ since: input.cursor }); assert.equal(done.events[0].status, "completed");
});

test("rollback, missing tracked items, immutable turn changes and wrong-task cursors fail closed", async () => {
  for (const mutate of [t => t.turns.pop(), t => { t.turns[0].id = "replaced"; }, t => { t.turns[0].items.splice(1, 1); }]) {
    const t = task([user("u"), cmd("old"), ...Array.from({ length: 90 }, (_, i) => msg(`a${i}`))]);
    const s = server(t), a = await s.read({ limit: 2 }); mutate(t);
    await assert.rejects(s.read({ since: a.cursor }), { code: "STALE_CURSOR" });
  }
  const t = task([msg("last")], "idle"), s = server(t), a = await s.read(); t.turns[0].status = "failed";
  await assert.rejects(s.read({ since: a.cursor }), { code: "STALE_CURSOR" });
  assert.throws(() => decodeCursor(a.cursor, "other"), { code: "STALE_CURSOR" });
});

test("v2 freshness permits progress and detects new user input, turn changes and unread pages", async () => {
  const t = task([user("u"), msg("a")]), s = server(t), a = await s.read();
  t.turns[0].items.push(msg("progress")); await verifyPagedFreshness(s.client, ID, a.cursor);
  t.turns[0].items.push(user("u2"));
  await assert.rejects(verifyPagedFreshness(s.client, ID, a.cursor), { code: "STALE_OBSERVATION" });
  const partial = await s.read({ since: a.cursor, limit: 1 }); assert.equal(partial.has_more, true);
  await assert.rejects(verifyPagedFreshness(s.client, ID, partial.cursor), { code: "STALE_OBSERVATION" });
  const fresh = await s.read(); t.turns[0].status = "completed"; t.status.type = "idle";
  await assert.rejects(verifyPagedFreshness(s.client, ID, fresh.cursor), { code: "STALE_OBSERVATION" });
});

test("v2 freshness rejects an edited user message at the observed head", async () => {
  const t = task([user("u")]), s = server(t), a = await s.read();
  t.turns[0].items[0].content[0].text = "new decision";
  await assert.rejects(verifyPagedFreshness(s.client, ID, a.cursor), { code: "STALE_OBSERVATION" });
});

test("v1 is explicit full-history mode and fast mode never silently hydrates it", async () => {
  const t = task([msg("a")]), s = server(t), v1 = readSnapshot(t).cursor;
  await assert.rejects(s.read({ since: v1 }), { code: "CURSOR_UPGRADE_REQUIRED" });
  assert.ok(s.calls.every(c => c.itemsView !== "full"));
  assert.equal((await s.read({ since: v1, fullHistory: true })).changed, false);
  const v2 = (await s.read()).cursor;
  await assert.rejects(s.read({ since: v2, fullHistory: true }), /v2 cursor/);
});

test("Monitor uses paged reads and stays quiet after delivering changes", async () => {
  const t = task([msg("a")]), s = server(t), stop = new AbortController(), events = []; let n = 0;
  await streamThread(ID, { notify: "all", signal: stop.signal }, async r => { if (r.type === "observation") events.push(...r.events); }, { discover: async () => ({ paths: { socket: "fake" } }), connect: async () => s.client, sleep: async () => {
    if (++n === 1) t.turns[0].items.push(msg("b")); if (n === 3) stop.abort();
  } });
  assert.deepEqual(events.map(e => e.id), ["b"]);
  assert.ok(s.calls.every(c => c.includeTurns !== true && c.itemsView !== "full"));
});

test("Monitor retries a partial paged read from the last flushed v2 cursor", async () => {
  const t = task([msg("initial")]), stop = new AbortController();
  let cut = false, connections = 0;
  const s = server(t, method => {
    if (cut && method === "thread/items/list") { cut = false; throw Object.assign(new Error("cut mid-read"), { code: "CONNECTION_FAILED" }); }
  });
  const initial = await s.read(), output = [];
  t.turns[0].items.push(msg("a"), msg("b"));
  await streamThread(ID, { notify: "all", since: initial.cursor, limit: 1, signal: stop.signal }, async data => {
    output.push(data);
    if (data.type !== "observation") return;
    if (data.events.some(e => e.id === "a")) cut = true;
    if (data.events.some(e => e.id === "c")) stop.abort();
  }, {
    discover: async () => ({ paths: { socket: "fake" } }),
    connect: async () => { if (++connections === 2) t.turns[0].items.push(msg("c")); return s.client; },
    sleep: async () => {},
  });
  assert.deepEqual(output.filter(x => x.type === "observation").flatMap(x => x.events.map(e => e.id)), ["a", "b", "c"]);
  const resumed = output.find(x => x.state === "recovered");
  assert.ok(resumed); assert.equal(decodeCursor(resumed.resume_cursor, ID).v, 2);
  assert.equal(connections, 2);
});
