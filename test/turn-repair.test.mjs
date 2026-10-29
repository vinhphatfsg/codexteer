import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, link, stat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { repairTurns, scanRepairRollout, repairProcessBlockers } from "../src/turn-repair.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000010";
const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011", NEXT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000012";
const hash = b => createHash("sha256").update(b).digest("hex");
const deps = { offline: async () => {}, runtimeVersion: async () => "0.162.0-alpha.17.2", now: () => new Date("2026-10-12T00:00:00Z") };
const event = payload => ({ type: "event_msg", payload });
const start = id => event({ type: "task_started", turn_id: id, root_turn_id: id, started_at: 1791709145 });
const end = id => event({ type: "task_complete", turn_id: id });
function records() {
  return [{ type: "session_meta", payload: { id: ID, history_mode: "paginated" } }, start(OLD),
    { type: "response_item", payload: { role: "user", content: "private original input" } }, start(NEXT), end(NEXT)];
}
const encode = rows => rows.map((r, ordinal) => JSON.stringify({ timestamp: "2026-10-11T00:00:00Z", ordinal, ...r })).join("\n") + "\n";
async function fixture(t, rows = records()) {
  const home = await mkdtemp("/private/tmp/ct-turn-repair-test-"); t.after(() => rm(home, { recursive: true, force: true }));
  const dir = `${home}/sessions/2026/10/11`; await mkdir(dir, { recursive: true });
  const file = `${dir}/rollout-2026-10-11T00-00-00-${ID}.jsonl`; await writeFile(file, encode(rows));
  return { home, dir, file };
}

test("dry-run finds old missing terminal even when an idle API would mask it; it writes nothing", async t => {
  const { home, file } = await fixture(t);
  const before = await readFile(file);
  const r = await repairTurns(`codex://threads/${ID}`, { home }, { offline: () => assert.fail("dry run needs no process inspection"), runtimeVersion: () => assert.fail("dry run needs no executable") });
  assert.equal(r.status, "residual_candidates");
  assert.equal(r.history_changed, false);
  assert.deepEqual(r.candidates.map(c => [c.turn_id, c.successor_id]), [[OLD, NEXT]]);
  assert.equal(r.source_sha256, hash(before));
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(home), ["sessions"]);
  assert.ok(!JSON.stringify(r).includes("private original input"));
});

test("apply backs up exact bytes, appends ID-specific terminal, verifies, and is idempotent", async t => {
  const { home, file } = await fixture(t), before = await readFile(file);
  const r = await repairTurns(ID, { home, apply: true }, deps);
  assert.equal(r.status, "repaired"); assert.equal(r.history_changed, true);
  assert.deepEqual(r.repaired_turn_ids, [OLD]);
  assert.deepEqual(await readFile(r.backup_path), before);
  assert.equal((await stat(r.backup_path)).mode & 0o777, 0o600);
  const after = await readFile(file);
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(hash(after), r.repaired_sha256);
  const append = JSON.parse(after.subarray(before.length).toString());
  assert.equal(append.ordinal, 5);
  assert.deepEqual(append.payload, { type: "turn_aborted", turn_id: OLD, root_turn_id: OLD, reason: "interrupted", started_at: 1791709145 });
  assert.equal(append.payload.completed_at, undefined, "do not invent when the old turn stopped");
  assert.equal(JSON.parse(await readFile(r.receipt_path)).status, "verified");
  assert.equal((await repairTurns(ID, { home, apply: true }, deps)).status, "no_residual_candidates");
  assert.deepEqual(await readFile(file), after);
});

test("latest unfinished turn is never repaired, nor used as permission to repair old ones", async t => {
  const { home, file } = await fixture(t, records().slice(0, -1));
  const before = await readFile(file), r = await repairTurns(ID, { home });
  assert.deepEqual(r.unresolved_latest.map(c => c.turn_id), [NEXT]);
  await assert.rejects(repairTurns(ID, { home, apply: true }, deps), { code: "REPAIR_LATEST_UNFINISHED" });
  assert.deepEqual(await readFile(file), before);
});

test("a terminal arriving later in the log closes its own turn without touching intervening ones", async t => {
  const rows = records(); rows.push(event({ type: "turn_aborted", turn_id: OLD, reason: "interrupted" }));
  const { home } = await fixture(t, rows);
  assert.equal((await repairTurns(ID, { home })).candidates.length, 0);
});

test("old formats without root_turn_id can be inspected; completed nested turns are preserved", async t => {
  const rows = records(); delete rows[1].payload.root_turn_id;
  rows[3].payload.root_turn_id = OLD;
  rows.push(start("aaaaaaaa-aaaa-4aaa-8aaa-a1f0cbffca0a"), end("aaaaaaaa-aaaa-4aaa-8aaa-a1f0cbffca0a"));
  const { home } = await fixture(t, rows);
  const r = await repairTurns(ID, { home });
  assert.deepEqual(r.candidates.map(c => c.turn_id), [OLD]);
  assert.equal(r.candidates[0].successor_id, "aaaaaaaa-aaaa-4aaa-8aaa-a1f0cbffca0a");
});

test("unknown/nested unfinished turns block mutation", async t => {
  const rows = records().slice(0, -1); rows[3].payload.root_turn_id = OLD;
  const { home } = await fixture(t, rows);
  const r = await repairTurns(ID, { home });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.unresolved_latest.length, 2);
  assert.equal((await repairTurns(ID, { home, apply: true }, deps)).history_changed, false);
});

test("malformed, incomplete, reordered, ambiguous and foreign history fail without writes", async t => {
  for (const change of [
    s => s.slice(0, -1), s => s + "broken\n", s => s.replace('"ordinal":1', '"ordinal":7'),
    s => s.replace('"history_mode":"paginated"', '"history_mode":"future"'),
    s => s.replace(`"id":"${ID}"`, `"id":"${OLD}"`),
    () => encode([...records(), start(OLD)]),
    () => encode([...records(), end(NEXT)]),
  ]) {
    const { home, file } = await fixture(t); const content = change(await readFile(file, "utf8")); await writeFile(file, content);
    await assert.rejects(repairTurns(ID, { home, apply: true }, deps), { code: "REPAIR_HISTORY_UNSUPPORTED" });
    assert.equal(await readFile(file, "utf8"), content);
  }
});

test("symlinks, hardlinks and duplicate rollout paths are refused", async t => {
  for (const kind of ["symlink", "hardlink", "duplicate"]) {
    const { home, file, dir } = await fixture(t);
    if (kind === "symlink") { await renameForSymlink(file); }
    else if (kind === "hardlink") await link(file, `${dir}/copy`);
    else { const other = `${home}/archived_sessions`; await mkdir(other); await writeFile(`${other}/other-${ID}.jsonl`, await readFile(file)); }
    await assert.rejects(repairTurns(ID, { home }), { code: kind === "duplicate" ? "REPAIR_ROLLOUT_AMBIGUOUS" : "REPAIR_UNSAFE_PATH" });
  }
});
async function renameForSymlink(file) { const content = await readFile(file); await writeFile(`${file}.real`, content); await rm(file); await symlink(`${file}.real`, file); }

test("running Codex, permission failure and unknown parser version stop before any mutation", async t => {
  for (const code of ["REPAIR_REQUIRES_OFFLINE", "REPAIR_OFFLINE_UNVERIFIED", "REPAIR_RUNTIME_UNVERIFIED"]) {
    const { home, file } = await fixture(t), before = await readFile(file);
    const method = code === "REPAIR_RUNTIME_UNVERIFIED" ? "runtimeVersion" : "offline";
    await assert.rejects(repairTurns(ID, { home, apply: true }, { ...deps, [method]: () => { throw Object.assign(new Error("blocked"), { code }); } }), { code });
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(home), ["sessions"]);
  }
});

test("history changes after backup never get overwritten", async t => {
  const { home, file } = await fixture(t); let inspections = 0;
  const extra = encode([event({ type: "other" })]);
  await assert.rejects(repairTurns(ID, { home, apply: true }, { ...deps, offline: async () => {
    if (++inspections === 3) await writeFile(file, extra, { flag: "a" });
  } }), e => e.code === "REPAIR_HISTORY_CHANGED" && e.history_changed === false && !!e.backup_path);
  assert.ok((await readFile(file, "utf8")).endsWith(extra));
});

test("failure after append reports changed state and durable recovery paths", async t => {
  const { home, file } = await fixture(t); let inspections = 0;
  await assert.rejects(repairTurns(ID, { home, apply: true }, { ...deps, offline: () => {
    if (++inspections === 5) throw Object.assign(new Error("Codex restarted"), { code: "REPAIR_REQUIRES_OFFLINE" });
  } }), e => e.history_changed === true && !!e.backup_path && !!e.receipt_path);
  assert.equal((await scanRepairRollout(file, ID)).candidates.length, 0);
});

test("metadata-only change when opening for append is accepted only after hashing the writable descriptor", async t => {
  const { home, file } = await fixture(t), before = await readFile(file);
  const r = await repairTurns(ID, { home, apply: true }, { ...deps, openForAppend: async path => {
    const h = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const s = await h.stat();
    await h.utimes(s.atime, new Date(s.mtimeMs + 2000));
    return h;
  } });
  assert.equal(r.status, "repaired");
  assert.deepEqual((await readFile(file)).subarray(0, before.length), before);
  const receipt = JSON.parse(await readFile(r.receipt_path));
  assert.equal(receipt.append_descriptor_sha256_verified, true);
  assert.equal(receipt.metadata_revalidated, true);
});

test("same-size content change on append open is rejected even with restored mtime", async t => {
  const { home, file } = await fixture(t), before = await readFile(file, "utf8");
  const tampered = before.replace("private", "changed"); assert.equal(tampered.length, before.length);
  await assert.rejects(repairTurns(ID, { home, apply: true }, { ...deps, openForAppend: async path => {
    const s = await stat(path);
    await writeFile(path, tampered);
    const h = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    await h.utimes(s.atime, s.mtime);
    return h;
  } }), e => e.code === "REPAIR_HISTORY_CHANGED" && e.history_changed === false && !!e.repair_stat && /contents changed/.test(e.message));
  assert.equal(await readFile(file, "utf8"), tampered);
});

test("a restart during descriptor hashing is checked again before any append", async t => {
  const { home, file } = await fixture(t), before = await readFile(file); let inspections = 0;
  await assert.rejects(repairTurns(ID, { home, apply: true }, { ...deps, offline: () => {
    if (++inspections === 4) throw Object.assign(new Error("Codex restarted"), { code: "REPAIR_REQUIRES_OFFLINE" });
  } }), e => e.history_changed === false && !!e.backup_path);
  assert.deepEqual(await readFile(file), before);
});

test("process guard recognizes all Codex app/server executables and fails closed on malformed output", () => {
  const rows = " 10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n 11 /opt/bin/codex\n 12 /opt/bin/codex-app-server\n 13 /Applications/Codex.app/Contents/MacOS/Codex\n 14 /usr/bin/node\n";
  assert.deepEqual(repairProcessBlockers(rows).map(p => p.pid), [10, 11, 12, 13]);
  assert.throws(() => repairProcessBlockers("unparseable"), { code: "REPAIR_OFFLINE_UNVERIFIED" });
});
