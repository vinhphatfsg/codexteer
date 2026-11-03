import test from "node:test";
import assert from "node:assert/strict";
import { readOnClient, readSnapshot, observeThread } from "../src/observe.mjs";
import { parseCursor } from "../src/cursor.mjs";
import { verifyPagedFreshness } from "../src/paged-read.mjs";
import { streamThread } from "../src/monitor.mjs";
import { sendOnClient } from "../src/app-server.mjs";
import { prepareDirective } from "../src/directive.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
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
  assert.equal(data.has_more, false); assert.equal(parseCursor(data.cursor, ID).pending, false);
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
  assert.equal(r.omitted_older_events, null); assert.equal(parseCursor(r.cursor, ID).v, 2);
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

test("orphan steering preserves observations and pins the latest turn for both cursor formats", async () => {
  for (const version of [1, 2]) {
    for (const change of ["progress", "new-empty-turn", "new-user", ...(version === 1 ? ["legacy-cursor"] : [])]) {
      const t = task([user("old-input"), msg("old-output")]);
      t.turns.push({ id: "current", status: "inProgress", items: [msg("current-output")] });
      const s = server(t), observed = version === 1 ? readSnapshot(t) : await s.read();
      assert.equal(observed.active_turn_id, null, "observation must not claim a verified runtime ID");
      assert.deepEqual(observed.events.filter(e => e.type === "turn").map(e => [e.id, e.status]), [["t0", "inProgress"], ["current", "inProgress"]]);
      let cursor = observed.cursor;
      if (change === "legacy-cursor") {
        // Cursors from before latest_turn_id existed are base64url JSON without it.
        const { latest_turn_id, ...value } = parseCursor(cursor, ID);
        cursor = Buffer.from(JSON.stringify({ ...value, thread_id: ID })).toString("base64url");
      }
      const directive = await prepareDirective(ID, "check", { basedOn: cursor }, "id");
      if (change === "new-empty-turn") {
        t.turns.at(-1).status = "completed";
        t.turns.push({ id: "next", status: "inProgress", items: [] });
        assert.equal(readSnapshot(t).active_turn_id, null, "null alone would miss this turn change");
      } else t.turns.at(-1).items.push(change === "new-user" ? user("new-user") : msg("progress"));
      let writes = 0;
      const client = { async request(method, params) {
        if (method !== "turn/steer") return s.client.request(method, params);
        writes++; assert.equal(params.expectedTurnId, "current"); return { turnId: "current" };
      } };
      const send = sendOnClient(client, ID, directive.wireText, { beforeSend: directive.beforeSend });
      if (change === "progress") assert.equal((await send).turn_id, "current");
      else await assert.rejects(send, { code: "STALE_OBSERVATION" });
      assert.equal(writes, change === "progress" ? 1 : 0);
    }
  }
});

test("earlier v1 cursors reject malformed optional latest-turn identities", () => {
  const original = { ...parseCursor(readSnapshot(task()).cursor, ID), thread_id: ID };
  const legacy = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.equal(parseCursor(legacy(original), ID).v, 1);
  for (const latest_turn_id of [123, {}, ""]) assert.throws(() => parseCursor(legacy({ ...original, latest_turn_id }), ID), { code: "STALE_CURSOR" });
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
  assert.throws(() => parseCursor(a.cursor, "other"), { code: "STALE_CURSOR" });
});

test("a reordered turn list fails closed", async () => {
  const t = task([msg("current")]); t.turns.unshift({ id: "earlier", status: "completed", items: [msg("old")] });
  const s = server(t), a = await s.read(); t.turns.reverse();
  await assert.rejects(s.read({ since: a.cursor }), { code: "STALE_CURSOR" });
});

test("the cursor keeps its size as the task grows from 10 to 200 turns", async () => {
  const lengths = {}, pad = n => String(n).padStart(4, "0");
  for (const count of [10, 200]) {
    const t = task();
    t.turns = Array.from({ length: count }, (_, n) => ({ id: `turn-${pad(n)}`, status: n === count - 1 ? "inProgress" : "completed", items: [user(`u${pad(n)}`), msg(`a${pad(n)}`)] }));
    const s = server(t), first = await s.read();
    t.turns.at(-1).items.push(msg("next"));
    const next = await s.read({ since: first.cursor });
    assert.deepEqual(next.events.map(e => [e.id, e.change]), [["next", "added"]]);
    lengths[count] = [first.cursor.length, next.cursor.length];
  }
  for (const phase of [0, 1]) assert.ok(Math.abs(lengths[200][phase] - lengths[10][phase]) <= 8, JSON.stringify(lengths));
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
  await assert.rejects(s.read({ since: v2, fullHistory: true }));
});

// 0.19.0 wrote these base64url JSON cursors for observed() below. Agents, findings and older launchers hold
// cursors like them, so every later CLI must keep reading them with the same result.
const LEGACY_V2 = "eyJ2IjoyLCJ0aHJlYWRfaWQiOiJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS0wMDAwMDAwMDAwMDEiLCJ0dXJucyI6W3siaWQiOiJ0MCIsInN0YXR1cyI6ImNvbXBsZXRlZCJ9LHsiaWQiOiJ0MSIsInN0YXR1cyI6ImluUHJvZ3Jlc3MifV0sImhlYWQiOnsiY3Vyc29yIjoie1wic2NvcGVcIjpcInRocmVhZC9pdGVtcy9saXN0OmFsbFwiLFwiaWRcIjpcInQxL2ExXCIsXCJpbmNsdWRlXCI6dHJ1ZX0iLCJpZCI6ImExIiwidHVybl9pZCI6InQxIiwiaGFzaCI6ImJjYTdkOGMzNDVmNWQ0OWFlNGY1YzA3YTNkYjU5ZGQxYzEyYzY2MjlmODBlNzQwMTY2ZDRjMjRlNjUyODdjMDcifSwiZ3JvdXBzIjpbeyJjdXJzb3IiOm51bGwsInR1cm5faWQiOiJ0MSIsImNvdW50IjozLCJpdGVtcyI6W3siaW5kZXgiOjEsImlkIjoiYzEiLCJ0dXJuX2lkIjoidDEiLCJoYXNoIjoiN2FlZDJiOWM1NmNjYWFkMDQ3ODZjNTlmOGUyMWU0ZTgyOTQ3YWYzZTQwYjc4MmRkZTNmMDc4YTM5NGJkZTYyZSIsIm1vZGUiOiJydW5uaW5nIn0seyJpbmRleCI6MiwiaWQiOiJhMSIsInR1cm5faWQiOiJ0MSIsImhhc2giOiJiY2E3ZDhjMzQ1ZjVkNDlhZTRmNWMwN2EzZGI1OWRkMWMxMmM2NjI5ZjgwZTc0MDE2NmQ0YzI0ZTY1Mjg3YzA3IiwibW9kZSI6InRhaWwifV19XSwibGFzdF9wdWJsaWMiOiJhMSIsInN0YXRlIjoiN2U1YzU1MTFlNDE4ZjNjNmM2MWVhODQxYzk3OTEzODE3ZDAxMTExNThkMWUxZmQ0Y2NiZTc1ZGZjYjhiMjI2NiIsImFjdGl2ZV90dXJuX2lkIjoidDEiLCJwZW5kaW5nIjpmYWxzZX0";
const LEGACY_V1 = "eyJ2IjoxLCJ0aHJlYWRfaWQiOiJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS0wMDAwMDAwMDAwMDEiLCJjb3VudCI6Nywib3BlbiI6W3siaW5kZXgiOjMsImhhc2giOiIyMDIzMTc5Zjc5Zjk3MmRjZTM4YTFlMDQ5ZTM0ZjczOTg1M2Y3MGU1NTI3MWRjNGI2ZWEzNTBkMTI1ODdlZWEyIn0seyJpbmRleCI6NSwiaGFzaCI6IjdhZWQyYjljNTZjY2FhZDA0Nzg2YzU5ZjhlMjFlNGU4Mjk0N2FmM2U0MGI3ODJkZGUzZjA3OGEzOTRiZGU2MmUifSx7ImluZGV4Ijo2LCJoYXNoIjoiYmNhN2Q4YzM0NWY1ZDQ5YWU0ZjVjMDdhM2RiNTlkZDFjMTJjNjYyOWY4MGU3NDAxNjZkNGMyNGU2NTI4N2MwNyJ9XSwicHJlZml4IjoiY2JlZGZkOWMyMTljYTI5YTY0Y2ZjZjEwZDExMTBlOTMyMjhiOGZhYTFjZmIwNGJkYTkwMDE4YzVhMmUyNTIwNyIsInN0YXRlIjoiN2U1YzU1MTFlNDE4ZjNjNmM2MWVhODQxYzk3OTEzODE3ZDAxMTExNThkMWUxZmQ0Y2NiZTc1ZGZjYjhiMjI2NiIsImFjdGl2ZV90dXJuX2lkIjoidDEiLCJsYXRlc3RfdHVybl9pZCI6InQxIiwidXNlcl9yZXZpc2lvbiI6Ijc1ZDQ4ZGU3YTQ4YWFjYTc2MWY4NTQ0MTVkZTU3YzUwMDNhZjE0MjVlY2ViNzdhMDcxNWQxZWZjZWIzZTY5NTQifQ";
const observed = () => ({ id: ID, historyMode: "paginated", status: { type: "active", activeFlags: [] }, turns: [
  { id: "t0", status: "completed", items: [user("u0"), msg("a0")] }, { id: "t1", status: "inProgress", items: [user("u1"), cmd("c1"), msg("a1", "working")] }] });
function advance(t) {
  Object.assign(t.turns[1].items[1], { status: "completed", aggregatedOutput: "ok", exitCode: 0 }); t.turns[1].items[2].text = "done";
  t.turns[1].items.push(msg("a2")); t.turns[1].status = "completed"; t.turns.push({ id: "t2", status: "inProgress", items: [user("u2")] });
}
const advanced = [
  { id: "t1", turn_id: "t1", type: "turn", status: "completed", change: "updated" },
  { id: "c1", turn_id: "t1", type: "commandExecution", command: "test", cwd: undefined, status: "completed", exit_code: 0, output: "ok", change: "updated" },
  { id: "a1", turn_id: "t1", type: "agentMessage", text: "done", phase: null, change: "updated" },
  { id: "a2", turn_id: "t1", type: "agentMessage", text: "a2", phase: null, change: "added" },
  { id: "t2", turn_id: "t2", type: "turn", status: "inProgress", change: "added" },
  { id: "u2", turn_id: "t2", type: "userMessage", client_message_id: null, text: "u2", attachments: [], change: "added" },
];

test("a 0.19.0 cursor continues a read with the same events and hands back a compact cursor", async () => {
  const t = observed(), s = server(t);
  assert.equal((await prepareDirective(ID, "check", { basedOn: LEGACY_V2 }, "id")).wireText, "[codexteer id]\n送信者: external\n種類: レビュー\n観測対象ターン: t1\n\ncheck");
  advance(t);
  const next = await s.read({ since: LEGACY_V2, includeOutput: true });
  assert.deepEqual(next.events, advanced);
  assert.match(next.cursor, /^c1[A-Za-z0-9_-]+$/); assert.ok(next.cursor.length < LEGACY_V2.length / 3);
  assert.match((await prepareDirective(ID, "check", { basedOn: next.cursor }, "id")).wireText, /^観測対象ターン: t2$/m);
  assert.equal((await s.read({ since: next.cursor })).changed, false);
});

test("a 0.19.0 full-history cursor continues through --full-history and hands back a compact cursor", async () => {
  const t = observed(), s = server(t);
  advance(t);
  await assert.rejects(s.read({ since: LEGACY_V1 }), { code: "CURSOR_UPGRADE_REQUIRED" });
  const next = await s.read({ since: LEGACY_V1, fullHistory: true, includeOutput: true });
  assert.deepEqual(next.events, advanced);
  assert.match(next.cursor, /^c1/); assert.equal(parseCursor(next.cursor, ID).v, 1);
  assert.equal((await s.read({ since: next.cursor, fullHistory: true })).changed, false);
  await assert.rejects(s.read({ since: next.cursor }), { code: "CURSOR_UPGRADE_REQUIRED" });
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
  assert.ok(resumed); assert.equal(parseCursor(resumed.resume_cursor, ID).v, 2);
  assert.equal(connections, 2);
});

test("paged Desktop metadata proves latest completed turn even when the display delta is empty", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises"), { tempPrefix } = await import("../test-support/temp.mjs");
  const { registerManagedThread } = await import("../src/project-index.mjs"), { syncProject } = await import("../src/project-sync.mjs");
  const home = await mkdtemp(tempPrefix("ct-paged-review-")); t.after(() => rm(home, { recursive: true, force: true }));
  const thread = task([user("u"), msg("result")], "idle"), s = server(thread), baseline = await s.read();
  await registerManagedThread(ID, { projectId: "paged-review", connection: "shared", syncCursor: baseline.cursor }, { home });
  const read = (_id, options) => s.read(options);
  for (let i = 0; i < 2; i++) {
    const result = await syncProject("paged-review", {}, { storage: { home }, read });
    assert.equal(result.complete, true); assert.equal(result.works[0].events.length, 0);
    assert.equal(result.works[0].group, "検収待ち"); assert.equal(result.works[0].reason.latest_turn_id, "t0");
    assert.equal(result.works[0].reason.latest_turn_status, "completed");
  }
});
