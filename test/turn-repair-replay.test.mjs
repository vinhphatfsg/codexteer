import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { BUNDLED_CLI } from "../src/wrapper.mjs";
import { repairTurns, repairRuntimeVersion } from "../src/turn-repair.mjs";

// Explicit opt-in: starts only a synthetic, unauthenticated app-server under a
// temporary HOME/CODEX_HOME. No real profile, model turn, message, or interrupt.
test("bundled Codex replays repair incrementally and from scratch without changing items", {
  skip: process.env.CODEXTEER_TEST_REPAIR_REPLAY !== "1", timeout: 60000,
}, async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const version = repairRuntimeVersion();
  const home = await mkdtemp("/private/tmp/ct-repair-replay-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000010", old = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011", next = "aaaaaaaa-aaaa-4aaa-8aaa-000000000012";
  const dir = `${home}/sessions/2026/10/11`; await mkdir(dir, { recursive: true });
  const file = `${dir}/rollout-2026-10-11T00-00-00-${id}.jsonl`;
  const event = payload => ({ type: "event_msg", payload });
  const start = turn_id => event({ type: "task_started", turn_id, root_turn_id: turn_id, started_at: 1791676800, model_context_window: 258400, collaboration_mode_kind: "default" });
  const item = (turn_id, itemId, text) => event({ type: "item_completed", thread_id: id, turn_id,
    item: { type: "AgentMessage", id: itemId, content: [{ type: "Text", text }], phase: "commentary" }, started_at_ms: 1791676800000, completed_at_ms: 1791676801000 });
  const rows = [
    { type: "session_meta", payload: { id, session_id: id, timestamp: "2026-10-11T00:00:00Z", cwd: home, originator: "codex_cli_rs", cli_version: version, source: "cli", model_provider: "openai", history_mode: "paginated", base_instructions: { text: "" } } },
    start(old), item(old, "message-old", "Keep old content exactly."),
    start(next), item(next, "message-new", "Keep new content exactly."),
    event({ type: "task_complete", turn_id: next, root_turn_id: next, last_agent_message: "done", started_at: 1791676800, completed_at: 1791676802, duration_ms: 2000 }),
  ];
  await writeFile(file, rows.map((r, ordinal) => JSON.stringify({ timestamp: "2026-10-11T00:00:00Z", ordinal, ...r })).join("\n") + "\n");
  const rawStates = () => {
    const db = new DatabaseSync(`${home}/thread_history_1.sqlite`, { readOnly: true });
    try { return db.prepare("SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal").all(id).map(r => [r.turn_id, r.status]); }
    finally { db.close(); }
  };
  async function replay() {
    // Restrict warmup to a closed loopback port even if the bundled runtime
    // initializes its Responses transport during resume. Never copy auth/config.
    const child = spawn(BUNDLED_CLI, ["app-server", "--stdio", "-c", 'model_provider="repair-test"', "-c", 'model_providers.repair-test={name="Repair test",base_url="http://127.0.0.1:1/v1",wire_api="responses"}'], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, OPENAI_BASE_URL: "http://127.0.0.1:1/v1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const exit = once(child, "exit"); let seq = 0; const pending = new Map();
    const lines = createInterface({ input: child.stdout }); let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    lines.on("line", line => { const r = JSON.parse(line); pending.get(r.id)?.(r); });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; exit=${child.exitCode}; ${stderr}`)); }, 10000);
      pending.set(id, r => { clearTimeout(timer); pending.delete(id); if (r.error) reject(new Error(`${method}: ${JSON.stringify(r.error)}`)); else resolve(r.result); });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    try {
      await request("initialize", { clientInfo: { name: "codexteer-repair-replay-test", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized","params":{}}\n');
      await request("thread/resume", { threadId: id, path: file, cwd: home, modelProvider: "repair-test", excludeTurns: true });
      const turns = (await request("thread/turns/list", { threadId: id, itemsView: "notLoaded", sortDirection: "asc", limit: 100 })).data;
      const items = (await request("thread/items/list", { threadId: id, sortDirection: "asc", limit: 100 })).data;
      const oldItems = (await request("thread/items/list", { threadId: id, turnId: old, sortDirection: "asc", limit: 100 })).data;
      return { turns, items, oldItems };
    } finally { child.kill("SIGTERM"); await exit; lines.close(); }
  }
  const before = await replay();
  assert.deepEqual(rawStates(), [[old, "inProgress"], [next, "completed"]], "stored state must reproduce the bug before repair");
  assert.equal(before.turns[0].status, "interrupted", "idle API masks the stale stored status");
  assert.equal(before.items.length, 2); assert.equal(before.oldItems.length, 1);
  const original = await readFile(file);
  const repair = await repairTurns(id, { home, apply: true }, { offline: () => {}, runtimeVersion: () => version });
  assert.equal(repair.status, "repaired");
  const incremental = await replay();
  assert.deepEqual(rawStates(), [[old, "interrupted"], [next, "completed"]]);
  assert.deepEqual(incremental.items, before.items); assert.deepEqual(incremental.oldItems, before.oldItems);
  assert.deepEqual((await readFile(file)).subarray(0, original.length), original);
  // Only a disposable synthetic projection is deleted. This exercises a full
  // rebuild and proves the repair is durable in the rollout, not a DB overlay.
  for (const suffix of ["", "-wal", "-shm"]) await rm(path.join(home, `thread_history_1.sqlite${suffix}`), { force: true });
  const rebuilt = await replay();
  assert.deepEqual(rawStates(), [[old, "interrupted"], [next, "completed"]]);
  assert.deepEqual(rebuilt.items, before.items); assert.deepEqual(rebuilt.oldItems, before.oldItems);
  const future = "aaaaaaaa-aaaa-4aaa-8aaa-a1f0cbffca0a";
  const lastOrdinal = JSON.parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)).ordinal;
  await writeFile(file, JSON.stringify({ timestamp: "2026-10-12T00:00:00Z", ordinal: lastOrdinal + 1, ...start(future) }) + "\n", { flag: "a" });
  await replay();
  assert.deepEqual(rawStates(), [[old, "interrupted"], [next, "completed"], [future, "inProgress"]], "a later unfinished turn must not resurrect the repaired one");
});
