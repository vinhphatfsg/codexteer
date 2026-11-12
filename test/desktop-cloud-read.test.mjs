import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { desktopCloudService } from "../test-support/desktop-cloud-service.mjs";
import { DesktopCloudClient } from "../src/desktop-cloud-api.mjs";
import { observeThread, readSnapshot, fetchThread } from "../src/observe.mjs";
import { parseCursor } from "../src/cursor.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject, projectEvent } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1", ID = `durable_${UUID}`, ENV = "fixture~asenvcfg_read", SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c2";
let serial = 0;
const next = () => `item-${++serial}`;
const user = text => ({ id: next(), type: "userMessage", clientId: null, content: [{ type: "text", text }] });
const agent = text => ({ id: next(), type: "agentMessage", text });
const command = output => ({ id: next(), type: "commandExecution", command: "make test", cwd: "/workspace", status: "completed", exitCode: 0, aggregatedOutput: output });
const work = n => [user(`order ${n}`), command("x".repeat(2000)), agent(`report ${n}`)];

function cloud(options) {
  const service = desktopCloudService(UUID, { environment: ENV, ...options }), connect = async () => new DesktopCloudClient(service.rpc);
  // What 0.24.x and earlier read: the whole history on every read.
  const fullRead = async (id, options) => readSnapshot(await fetchThread(await connect(), id), options);
  return { ...service, connect, fullRead, read: (id, options) => observeThread(id, options, { connect }) };
}

async function member(t, history = 0, { read = "tail", ...options } = {}) {
  const home = await mkdtemp(tempPrefix("ct-dc-read-")); t.after(() => rm(home, { recursive: true, force: true }));
  const c = cloud(options), storage = { home };
  for (let n = 0; n < history; n++) c.append(work(n));
  await registerManagedThread(ID, { projectId: "P", connection: "desktop-cloud", environmentConfigId: ENV }, storage);
  await registerSupervisor(ID, SESSION, { ...storage, connection: "desktop-cloud" });
  const deps = { storage, read: read === "tail" ? c.read : c.fullRead };
  return { ...c, storage, deps };
}

const eventIds = sync => sync.works[0].events.map(event => event.event_id);

test("a quiet project sync of a long-history member reads the newest turn, not the history", async t => {
  const f = await member(t, 150);
  assert.equal((await syncProject("P", {}, f.deps)).complete, true);
  f.resetServed();
  const quiet = await syncProject("P", {}, f.deps);
  assert.equal(quiet.complete, true); assert.deepEqual(quiet.works[0].events, []);
  assert.deepEqual([f.state.served.turns, f.state.served.ids], [0, 2], "the first round and the head check each list the newest turn's id only");

  const started = f.append([user("next order")], { status: "inProgress" }); f.state.status = "active"; f.resetServed();
  const running = await syncProject("P", {}, f.deps);
  assert.equal(running.complete, true); assert.deepEqual(eventIds(running), [started.id, started.items[0].id]);
  assert.equal(f.state.served.turns, 3, "the new turn and the previous newest, then the new turn again");

  const report = agent("finished"); f.complete([command("ok"), report]); f.resetServed();
  const done = await syncProject("P", {}, f.deps);
  assert.equal(done.complete, true); assert.equal(done.works[0].group, "検収待ち");
  assert.deepEqual(eventIds(done), [started.id, started.items[1].id, report.id], "the turn end is an update and its items are new; the opening message is not repeated");
  assert.equal((await projectEvent(done.works[0].events.at(-1).token, f.storage)).event.text, "finished");
  assert.equal(f.state.served.turns, 1, "the completed turn once; the head check lists its id only");
});

test("a quiet read lists the newest turn's id and falls back to its items when that cannot prove the read quiet", async () => {
  const f = cloud();
  for (let n = 0; n < 5; n++) f.append(work(n));
  const first = await f.read(ID, { limit: 1000 });
  f.resetServed();
  const quiet = await f.read(ID, { since: first.cursor });
  assert.equal(quiet.cursor, first.cursor); assert.equal(quiet.changed, false); assert.deepEqual(quiet.events, []);
  assert.deepEqual([f.state.served.turns, f.state.served.ids], [0, 1]);

  f.state.flags = ["waitingOnApproval"]; f.resetServed();
  const flagged = await f.read(ID, { since: first.cursor });
  assert.equal(flagged.changed, true); assert.deepEqual(flagged.attention, ["waitingOnApproval"]); assert.equal(f.state.served.turns, 1);

  f.state.flags = []; f.state.rejectNotLoaded = true; f.resetServed();
  const fallback = await f.read(ID, { since: first.cursor });
  assert.equal(fallback.cursor, first.cursor); assert.equal(f.state.served.turns, 1);
});

test("a final newest turn with a change held back or a command still running is read in full", async () => {
  const pending = cloud(), running = { ...command(""), status: "inProgress" };
  pending.append([user("order"), running], { status: "inProgress" }); pending.state.status = "active";
  let { cursor } = await pending.read(ID, { limit: 1000 });
  pending.complete(); running.status = "completed";
  const held = await pending.read(ID, { since: cursor, limit: 1 });
  assert.deepEqual(held.events.map(event => [event.id, event.change]), [["turn-0", "updated"]]); assert.equal(held.has_more, true);
  const rest = await pending.read(ID, { since: held.cursor });
  assert.deepEqual(rest.events.map(event => [event.id, event.status, event.change]), [[running.id, "completed", "updated"]]);

  const stuck = cloud(), left = { ...command(""), status: "inProgress" };
  stuck.append([user("order"), left]);
  ({ cursor } = await stuck.read(ID, { limit: 1000 }));
  const reference = await stuck.fullRead(ID, { limit: 1000 }), again = await stuck.read(ID, { since: cursor });
  assert.deepEqual(again.running_commands, reference.running_commands); assert.equal(again.running_commands.length, 1);
});

test("several turns completed between reads are delivered in order, once, across limited pages", async t => {
  const f = cloud();
  for (let n = 0; n < 40; n++) f.append(work(n));
  let cursor = (await f.read(ID, { limit: 1000 })).cursor;
  const added = []; for (let n = 40; n < 45; n++) added.push(f.append(work(n)));
  const expected = added.flatMap(turn => [turn.id, ...turn.items.map(item => item.id)]), seen = [];
  f.resetServed();
  for (let page; !page || page.has_more;) {
    page = await f.read(ID, { since: cursor, limit: 3 });
    seen.push(...page.events.map(event => event.id)); cursor = page.cursor;
  }
  assert.deepEqual(seen, expected);
  assert.ok(f.state.served.turns <= 7 * 6, `draining five new turns read ${f.state.served.turns} turns`);
  const again = await f.read(ID, { since: cursor, limit: 3 });
  assert.deepEqual(again.events, []); assert.equal(again.cursor, cursor, "an unchanged re-read returns the same cursor");
});

test("a first read without a cursor shows the newest events and counts older ones only when it read to the start", async t => {
  const long = cloud();
  for (let n = 0; n < 150; n++) long.append(work(n));
  const reference = await long.fullRead(ID, { limit: 5 }); long.resetServed();
  const tail = await long.read(ID, { limit: 5 });
  assert.deepEqual(tail.events, reference.events); assert.equal(tail.omitted_older_events, null);
  assert.ok(long.state.served.turns <= 2, `read ${long.state.served.turns} turns`);

  const short = cloud();
  for (let n = 0; n < 2; n++) short.append(work(n));
  const exact = await short.fullRead(ID, { limit: 5 }), counted = await short.read(ID, { limit: 5 });
  assert.deepEqual(counted.events, exact.events); assert.equal(counted.omitted_older_events, exact.omitted_older_events); assert.equal(counted.omitted_older_events, 3);

  const f = await member(t, 300);
  const sync = await syncProject("P", {}, f.deps);
  assert.equal(sync.complete, false); assert.equal(sync.works[0].error, "WORK_INITIAL_HISTORY_GAP"); assert.equal(sync.works[0].history_gap, true);
});

test("a cursor whose window turn is gone fails as a history gap without reading the older history", async t => {
  const f = await member(t, 150);
  await syncProject("P", {}, f.deps);
  f.state.turns.pop(); f.resetServed();
  const sync = await syncProject("P", {}, f.deps);
  assert.equal(sync.works[0].error, "STALE_CURSOR"); assert.equal(sync.works[0].history_gap, true); assert.equal(sync.complete, false);
  assert.ok(f.state.served.turns <= 2, `read ${f.state.served.turns} turns`);

  const g = cloud();
  for (let n = 0; n < 5; n++) g.append(work(n), { startedAt: null });
  const { cursor } = await g.read(ID, { limit: 1000 });
  g.state.turns.pop();
  await assert.rejects(g.read(ID, { since: cursor }), { code: "STALE_CURSOR" });
});

test("a changed delivered turn or a service listing oldest first fails closed and never redelivers", async t => {
  const f = cloud();
  for (let n = 0; n < 5; n++) f.append(work(n));
  const { cursor } = await f.read(ID, { limit: 1000 });
  f.state.turns.at(-1).items[1].aggregatedOutput = "rewritten";
  assert.equal((await f.read(ID, { since: cursor })).cursor, cursor, "a quiet read lists only the id of the final newest turn");
  f.append(work(5));
  await assert.rejects(f.read(ID, { since: cursor }), { code: "STALE_CURSOR" }, "the next read that lists it in full sees the rewrite");

  const g = cloud();
  for (let n = 0; n < 5; n++) g.append(work(n));
  const first = await g.read(ID, { limit: 1000 });
  g.append(work(5));
  const request = g.rpc.request;
  g.rpc.request = (method, params) => request(method, method === "thread/turns/list" ? { ...params, sortDirection: "asc" } : params);
  await assert.rejects(g.read(ID, { since: first.cursor }), { code: "STALE_CURSOR" });
});

test("a turn listing that repeats a turn or a cursor, or stalls, is rejected", async () => {
  for (const fault of ["turn", "cursor", "empty"]) {
    const f = cloud();
    for (let n = 0; n < 4; n++) f.append(work(n));
    const request = f.rpc.request;
    let pages = 0;
    f.rpc.request = async (method, params) => {
      if (method !== "thread/turns/list" || params.sortDirection !== "desc") return request(method, params);
      const page = await request(method, params);
      if (++pages === 2) {
        if (fault === "turn") page.data = [{ ...page.data[0], id: "turn-3" }];
        if (fault === "cursor") page.nextCursor = params.cursor;
        if (fault === "empty") page.data = [];
      }
      return page;
    };
    await assert.rejects(f.read(ID, { limit: 1000 }), { code: "DESKTOP_CLOUD_PROTOCOL_ERROR" }, fault);
  }
});

test("cursors saved by earlier versions are upgraded by one full read without losing or repeating events", async t => {
  const f = await member(t, 20, { read: "full" });
  assert.equal((await syncProject("P", {}, f.deps)).complete, true);
  const saved = (await getManagedThread(ID, f.storage)).sync_cursor;
  assert.equal(parseCursor(saved, ID).v, 1);
  f.deps.read = f.read;
  const added = [f.append(work(20)), f.append(work(21))]; f.resetServed();
  const upgrade = await syncProject("P", {}, f.deps);
  assert.equal(upgrade.complete, true);
  assert.deepEqual(eventIds(upgrade), added.flatMap(turn => [turn.id, ...turn.items.map(item => item.id)]));
  assert.equal(parseCursor((await getManagedThread(ID, f.storage)).sync_cursor, ID).v, 3);
  assert.equal(f.state.served.turns, 22, "one full read; the head check lists the newest turn's id");
  f.resetServed();
  assert.deepEqual((await syncProject("P", {}, f.deps)).works[0].events, []);
  assert.deepEqual([f.state.served.turns, f.state.served.ids], [0, 2]);

  const c = cloud();
  for (let n = 0; n < 3; n++) c.append(work(n));
  const v1 = (await c.fullRead(ID, { limit: 1000 })).cursor;
  c.append(work(3));
  const reference = await c.fullRead(ID, { since: v1 }), upgraded = await c.read(ID, { since: v1 });
  assert.deepEqual(upgraded.events, reference.events); assert.equal(parseCursor(upgraded.cursor, ID).v, 3);
});

test("a wait baseline saved by an earlier version returns the change since it once", async t => {
  const f = await member(t, 10, { read: "full" });
  await syncProject("P", {}, f.deps);
  f.deps.read = f.read;
  const wait = { ...f.deps, pollMs: 5, unreadGraceMs: 0, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  assert.equal((await waitProject("P", { timeoutMs: 20 }, wait)).timed_out, true);
  const turn = f.append(work(10));
  const result = await waitProject("P", { timeoutMs: 2000 }, wait);
  assert.equal(result.reason, "work_changed"); assert.deepEqual(eventIds(result.sync), [turn.id, ...turn.items.map(item => item.id)]);
  f.resetServed();
  const quiet = await waitProject("P", { timeoutMs: 20 }, wait);
  assert.equal(quiet.timed_out, true, "the same change is not returned twice");
  assert.ok(f.state.served.turns <= 2 * f.state.calls.filter(call => call.method === "thread/read").length, "the published baseline is read from its newest turn");
});

test("a --based-on check from a tail cursor refuses new user input in the running turn or a new turn", async () => {
  const { prepareDirective } = await import("../src/directive.mjs");
  for (const change of ["steer", "turn"]) {
    const f = cloud();
    for (let n = 0; n < 3; n++) f.append(work(n));
    f.append([user("order")], { status: "inProgress" }); f.state.status = "active";
    const { cursor } = await f.read(ID, { limit: 1000 }), client = await f.connect();
    const directive = await prepareDirective(ID, "Continue.", { basedOn: cursor, source: "test" }, "fixture-message");
    await directive.beforeSend({}, client);
    if (change === "steer") f.state.turns.at(-1).items.push(user("steer"));
    else { f.complete(); f.append([user("next")], { status: "inProgress" }); }
    await assert.rejects(directive.beforeSend({}, client), { code: "STALE_OBSERVATION" }, change);
  }
});

test("--full-history keeps the full read and its v1 cursor; a tail cursor cannot be combined with it", async () => {
  const f = cloud();
  for (let n = 0; n < 3; n++) f.append(work(n));
  const full = await f.read(ID, { fullHistory: true });
  assert.equal(parseCursor(full.cursor, ID).v, 1); assert.equal(full.history_scope, "full");
  const tail = await f.read(ID, {});
  assert.equal(parseCursor(tail.cursor, ID).v, 3); assert.equal(tail.history_scope, "tail-turns");
  await assert.rejects(f.read(ID, { since: tail.cursor, fullHistory: true }), { code: "OPTIONS_INVALID" });
});

test("a newest turn larger than the receive limit on its own still fails with the receive limit error", async t => {
  const f = await member(t, 3, { receiveLimit: 64 * 1024 });
  await syncProject("P", {}, f.deps);
  f.append([user("large"), command("x".repeat(80 * 1024))]);
  const sync = await syncProject("P", {}, f.deps);
  assert.equal(sync.complete, false); assert.equal(sync.works[0].error, "PAYLOAD_TOO_LARGE");
});

// The full reader is the reference: from the same history and the same reads,
// the tail reader must deliver the same events, has_more and changed. Running
// turns change in every way the reader tracks (new and streamed items, item and
// turn status, a running turn left behind by a newer one); final turns never do.
test("the tail reader delivers exactly what the full reader delivers", async () => {
  const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const items = r => Array.from({ length: Math.floor(r() * 4) }, () => pick(r, [() => agent("note"), () => command("out"), () => ({ id: next(), type: "reasoning" }),
    () => ({ id: next(), type: "fileChange", status: "completed", changes: [{ path: "a.txt", kind: "update", diff: "+a" }] })])());
  const visible = page => ({ events: page.events, has_more: page.has_more, changed: page.changed, omitted_older_events: page.omitted_older_events,
    status: page.status, active_turn_id: page.active_turn_id, latest_turn_id: page.latest_turn_id, latest_turn_status: page.latest_turn_status,
    active_turn_count: page.active_turn_count, attention: page.attention, running_commands: page.running_commands });
  const change = (r, f) => {
    const running = f.state.turns.filter(turn => turn.status === "inProgress"), turn = pick(r, running), choice = r();
    if (!turn || choice < 0.15) { f.append([user("order")], { status: "inProgress" }); return; }
    if (choice < 0.25) { f.append([user("order"), ...items(r)]); return; }
    const last = turn.items.findLast(item => item.type === "agentMessage"), active = turn.items.find(item => item.status === "inProgress");
    if (choice < 0.4) turn.items.push(pick(r, [user("steer"), agent("partial"), { ...command(""), status: "inProgress" }]));
    else if (choice < 0.55 && last) last.text += " more";
    else if (choice < 0.7 && active) { active.status = "completed"; active.aggregatedOutput = "done"; }
    else {
      for (const item of turn.items) if (item.status === "inProgress") item.status = "completed";
      turn.status = pick(r, ["completed", "completed", "failed", "interrupted"]); turn.items.push(...items(r));
    }
  };
  for (let seed = 1; seed <= 80; seed++) {
    const r = random(seed), f = cloud();
    for (let n = Math.floor(r() * 4); n > 0; n--) f.append([user("order"), ...items(r)]);
    let full, tail;
    for (let step = 0; step < 30; step++) {
      for (let n = Math.floor(r() * 4); n > 0; n--) change(r, f);
      f.state.status = f.state.turns.some(turn => turn.status === "inProgress") ? "active" : "idle";
      const limit = full ? pick(r, [1, 2, 3, 5, 1000]) : 1000, outcome = read => read.then(page => ({ page }), error => ({ error: error.code }));
      const a = await outcome(f.fullRead(ID, { since: full, limit, fullEvents: true })), b = await outcome(f.read(ID, { since: tail, limit, fullEvents: true }));
      // A rewritten delivered event is a history gap for both readers; both then start over.
      if (a.error || b.error) { assert.deepEqual(b, a, `seed ${seed} step ${step}`); full = tail = undefined; continue; }
      assert.deepEqual(visible(b.page), visible(a.page), `seed ${seed} step ${step}`);
      full = a.page.cursor; tail = b.page.cursor;
      if (!b.page.has_more) assert.equal((await f.read(ID, { since: tail, limit })).cursor, tail, `seed ${seed} step ${step}: stable cursor`);
    }
  }
});
