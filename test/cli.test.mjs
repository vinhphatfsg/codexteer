import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

test("routing takes the destination from positionals rather than metadata option values or message text", () => {
  const link = `codex://threads/${ID}?hostId=remote-control%3Aenv_fixture`;
  for (const leading of [["--evidence", link], ["--source", ID.replace(/1$/, "2")]]) {
    const before = cli(["send", ...leading, ID, "fixture", "--dry-run", "--no-sound"]);
    const after = cli(["send", ID, "fixture", ...leading, "--dry-run", "--no-sound"]);
    assert.equal(before.status, 0); assert.equal(after.status, 0); assert.equal(before.result.data.thread_id, ID);
    assert.equal(cli(["--host", "local", "send", ...leading, ID, "fixture", "--dry-run"]).status, 0);
  }
  const invalidCursorBefore = cli(["send", "--based-on", link, ID, "fixture", "--dry-run"]);
  const invalidCursorAfter = cli(["send", ID, "fixture", "--based-on", link, "--dry-run"]);
  assert.equal(invalidCursorBefore.result.error.code, invalidCursorAfter.result.error.code);
  assert(!["REMOTE_READ_ONLY", "HOST_MISMATCH"].includes(invalidCursorBefore.result.error.code));
  const remote = cli(["--remote-transport", "control", "send", "--source", ID, link, "fixture", "--dry-run", "--no-sound"]);
  assert.equal(remote.status, 0); assert.equal(remote.result.data.host_id, "remote-control:env_fixture");
  assert.equal(cli(["send", ID, "--dry-run", "--", link]).status, 0);
  assert.equal(cli(["--host", "local", "send", link, "fixture", "--dry-run"]).result.error.code, "HOST_MISMATCH");
});

test("thread repair rejects unsafe CLI combinations before access", () => {
  for (const flags of [["--apply", "--dry-run"], ["--force"], ["--all"]]) {
    const r = cli(["thread", "repair", ID, ...flags]);
    assert.equal(r.status, 1);
  }
  const desktop = cli(["--connection", "desktop", "thread", "repair", ID]);
  assert.equal(desktop.result.error.code, "DESKTOP_READ_ONLY");
  const supervisor = cli(["--supervisor", ID, "thread", "repair", ID, "--apply"]);
  assert.equal(supervisor.result.error.code, "SUPERVISOR_CONTROL_FORBIDDEN");
});

function cli(args, input, env = {}) {
  const result = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { encoding: "utf8", input, env: { ...process.env, ...env } });
  return { status: result.status, result: JSON.parse(result.stdout), stderr: result.stderr };
}

test("default live send uses App Server and fails without UI fallback when unavailable", t => {
  // Never let this live-send test discover the user's real Desktop runtime.
  const home = mkdtempSync(path.join(os.tmpdir(), "codexteer-default-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { status, result } = cli(["send", ID, "test"], undefined, { CODEX_HOME: home });
  assert.equal(status, 1);
  assert.equal(result.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(result.error.thread_id, ID);
  assert.equal(result.error.sent, false);
  assert.equal(result.error.delivery_status, "not_sent");
  const doctor = cli(["doctor"], undefined, { CODEX_HOME: home });
  assert.equal(doctor.result.data.default_send_backend, "app-server");
  assert.equal(doctor.result.data.rollout_status, "enabled");
  assert.equal(doctor.result.data.ready, false);
  assert.equal(doctor.result.data.compatibility.status, "unverified");
  assert.equal(cli(["doctor", "--thread", "not-a-thread"], undefined, { CODEX_HOME: home }).status, 1);
  assert.equal(cli(["doctor", "--thread", ID, "--backend", "ui"], undefined, { CODEX_HOME: home }).status, 1);
});

test("background dry run keeps command, UUID/link, shorthand and stdin interfaces", () => {
  for (const args of [["send", ID], [`codex://threads/${ID}`]]) for (const backend of [[], ["--backend", "app-server"]]) for (const mode of [[], ["--new-turn"]]) {
    const { status, result } = cli([...args, "-", "--dry-run", ...backend, ...mode], "日本語\nline 2");
    assert.equal(status, 0);
    assert.equal(result.data.thread_id, ID);
    assert.equal(result.data.backend, "app-server");
    assert.equal(result.data.delivery_action, mode.length ? "new-turn" : "steer");
    assert.equal(result.data.message_characters, 10);
    assert.equal(result.data.sent, false);
    assert.equal(JSON.stringify(result).includes("line 2"), false);
  }
});

test("UI-only flags require explicit UI backend", () => {
  for (const backend of [[], ["--backend", "app-server"]]) for (const options of [["--keep-focus"], ["--wait-ms", "10"]]) {
    const { status, result } = cli(["send", ID, "test", ...backend, "--dry-run", ...options]);
    assert.equal(status, 1);
  }
  const { result } = cli(["send", ID, "test", "--backend", "ui", "--dry-run", "--keep-focus"]);
  assert.equal(result.data.backend, "desktop-ui");
  assert.equal(result.data.focus_policy, "keep-codex-focused");
});

test("option terminator preserves literal flags in messages", () => {
  const { result } = cli(["send", ID, "--dry-run", "--", "--backend", "ui"]);
  assert.equal(result.data.backend, "app-server");
  assert.equal(result.data.message_characters, "--backend ui".length);
});

test("sound defaults on, supports explicit mute, and stays silent in dry runs", () => {
  for (const args of [["send", ID], [ID]]) for (const flag of [[], ["--sound"], ["--no-sound"]]) {
    const { status, result } = cli([...args, "test", ...flag, "--dry-run"]);
    assert.equal(status, 0);
    assert.equal(result.data.message_characters, 4);
    assert.deepEqual(result.data.sound, { played: false, reason: flag.includes("--no-sound") ? "disabled" : "dry_run" });
  }
  for (const flag of ["--sound", "--no-sound"]) {
    const literal = cli(["send", ID, "--dry-run", "--", flag]);
    assert.equal(literal.result.data.message_characters, flag.length);
    assert.deepEqual(literal.result.data.sound, { played: false, reason: "dry_run" });
  }
  for (const flags of [["--sound", "--no-sound"], ["--no-sound", "--sound"]]) {
    const conflict = cli(["send", ID, "test", ...flags]);
    assert.equal(conflict.status, 1);
  }
  const ui = cli(["send", ID, "test", "--sound", "--backend", "ui", "--dry-run"]);
  assert.equal(ui.status, 1);
});

test("desktop start dry run does not launch or inspect Desktop", () => {
  const { status, result } = cli(["desktop", "start", "--dry-run"]);
  assert.equal(status, 0);
  assert.equal(result.data.started, false);
});

test("unknown backend and empty messages fail before doing any work", () => {
  assert.equal(cli(["send", ID, "x", "--backend", "typo"]).status, 1);
  assert.equal(cli(["send", ID, "", "--backend", "app-server", "--dry-run"]).status, 1);
});

test("Monitor stream rejects one-shot flags before connecting and always uses JSON errors", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cs-monitor-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const args of [["--until", "idle"], ["--timeout-ms", "1000"]]) {
    const result = cli(["watch", ID, "--stream", ...args], undefined, { CODEX_HOME: home });
    assert.equal(result.status, 1); assert.notEqual(result.result.error.code, "RUNTIME_UNAVAILABLE");
  }
  const result = spawnSync(process.execPath, ["bin/codexteer.mjs", "watch", ID, "--stream"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(JSON.parse(result.stdout).data.type, "connection");
  assert.equal(JSON.parse(result.stdout).data.state, "failed");
});

test("watch validates digest flags before connecting and leaves single-shot watch unchanged", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-digest-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const args of [
    ["--notify", "digest"], ["--notify", "digest", "--until", "change"], ["--settle-ms", "1000"],
    ["--stream", "--notify", "typo"], ["--stream", "--notify"], ["--stream", "--settle-ms", "999"],
    ["--stream", "--settle-ms", "120001"], ["--stream", "--settle-ms", "NaN"], ["--stream", "--settle-ms", "1000.5"],
    ["--stream", "--max-hold-ms", "9999"], ["--stream", "--max-hold-ms", "1800001"],
    ["--stream", "--notify", "all", "--settle-ms", "1000"], ["--stream", "--notify", "all", "--max-hold-ms", "10000"],
  ]) {
    const result = cli(["watch", ID, ...args], undefined, { CODEX_HOME: home });
    assert.equal(result.status, 1, args.join(" "));
    assert.notEqual(result.result.error.code, "RUNTIME_UNAVAILABLE", args.join(" "));
  }
  for (const args of [[], ["--until", "change", "--timeout-ms", "0"], ["--notify", "all"], ["--stream"], ["--stream", "--notify", "all"], ["--stream", "--settle-ms", "1000", "--max-hold-ms", "10000"]]) {
    const result = cli(["watch", ID, ...args], undefined, { CODEX_HOME: home });
    assert.equal(result.status, 1); assert.equal(result.result.error.code, "RUNTIME_UNAVAILABLE", args.join(" "));
  }
});

test("metadata dry-run validates kind and evidence without exposing message text", () => {
  const { result } = cli(["send", ID, "private body", "--dry-run", "--kind", "hypothesis", "--source", "claude-code"]);
  assert.equal(result.data.metadata.kind, "hypothesis"); assert.equal(result.data.freshness_checked, false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(cli(["send", ID, "test", "--dry-run", "--kind", "typo"]).status, 1);
  assert.equal(cli(["send", ID, "test", "--dry-run", "--kind", "review", "--backend", "ui"]).status, 1);
});

test("desktop update dry run and argument validation", () => {
  const { status, result } = cli(["desktop", "update", "--dry-run"]);
  assert.equal(status, 0);
  assert.equal(result.command, "desktop.update");
  assert.equal(result.data.started, false);
  for (const args of [["--timeout-ms", "wat"], ["--timeout-ms", "1"], ["--unknown"]]) {
    assert.equal(cli(["desktop", "update", "--dry-run", ...args]).status, 1);
  }
});

test("bound supervisors cannot launch Desktop updates", () => {
  // Both fallbacks are harmless even if the supervisor guard regresses:
  // dry-run has no effects, and the invalid timeout fails before platform work.
  for (const flags of [["--dry-run"], ["--timeout-ms", "1"]]) {
    const result = cli(["--supervisor", ID, "desktop", "update", ...flags]);
    assert.equal(result.status, 1);
    assert.equal(result.result.error.code, "SUPERVISOR_CONTROL_FORBIDDEN");
  }
});

test("local send rejects unknown options before the -- separator and sends text after it literally", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-send-options-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  for (const args of [["send", ID, "--bogus", "hi"], ["send", ID, "--kidn", "review", "hi"], ["send", "--bogus", ID, "hi"], [ID, "--bogus", "hi"], [`codex://threads/${ID}`, "hi", "--kidn", "review"], ["send", ID, "hi", "--kind"]]) {
    const { status, result } = cli([...args, "--dry-run"], undefined, env);
    assert.equal(status, 1, args.join(" ")); assert.equal(result.error.code, "OPTIONS_INVALID", args.join(" "));
  }
  for (const args of [["send", ID, "--dry-run", "--", "--force", "--dry-run"], [ID, "--dry-run", "--", "--force", "--dry-run"]]) {
    const { status, result } = cli(args, undefined, env);
    assert.equal(status, 0, args.join(" ")); assert.equal(result.data.dry_run, true); assert.equal(result.data.message_characters, "--force --dry-run".length);
  }
});

test("diff on a local task fails as invalid usage instead of being sent as a message", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-local-diff-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const args of [["diff", ID], ["diff", `codex://threads/${ID}`], ["diff"], ["--connection", "desktop", "diff", ID], ["--host", "remote-control:env_fixture", "diff", ID]]) {
    const { status, result } = cli(args, undefined, { CODEX_HOME: home });
    assert.equal(status, 1, args.join(" ")); assert.equal(result.error.code, "OPTIONS_INVALID", args.join(" "));
  }
  assert.equal(cli(["help", "diff"]).status, 0);
});

test("local usage failures carry a code callers can branch on", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ct-usage-codes-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-000000000055", MSG = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff";
  const table = { OPTIONS_INVALID: [
    ["send"], ["send", ID, "x", "--backend", "typo"], ["send", ID, "", "--dry-run"], ["send", "not-a-thread", "x", "--dry-run"], ["send", ID, "x", "--sound", "--no-sound"],
    ["send", ID, "x", "--keep-focus", "--dry-run"], ["send", ID, "x", "--kind", "typo", "--dry-run"], ["send", ID, "x", "--backend", "ui", "--source", "me", "--dry-run"],
    ["send", ID, "x", "--evidence", ["https://user", "secret@example.com/"].join(":"), "--dry-run"], ["send", ID, "x", "--evidence", home, "--dry-run"], ["--supervisor", SESSION, "send", ID, "x", "--backend", "ui"],
    ["read", ID, "extra"], ["watch", ID, "--until", "never"], ["watch", ID, "--stream", "--until", "idle"], ["watch", ID, "--notify", "digest"], ["watch", ID, "--stream", "--notify", "typo"],
    ["watch", ID, "--stream", "--settle-ms", "999"], ["watch", ID, "--stream", "--notify", "all", "--settle-ms", "1000"], ["watch", ID, "--stream", "--poll-ms", "1"],
    ["doctor", "--thread", ID, "--backend", "ui"], ["doctor", "extra"], ["supervise", "prompt"], ["supervise", ID], ["supervise", "prompt", ID, "--agent", "typo"], ["supervise", "register", ID], ["supervise", "status"],
    ["thread", "repair", ID, "--apply", "--dry-run"], ["thread", "resolve"], ["thread", "nope"], ["threads", "list", "--limit", "0"], ["projects", "nope"], ["desktop", "nope"], ["open"], ["debug-ui"],
    ["checkpoint", "list"], ["checkpoint", "nope", ID], ["checkpoint", "capture", ID, "name"], ["checkpoint", "attach", ID, MSG],
    ["history", "nope", ID], ["history", "mark", ID, MSG, "--status", "typo", "--note", "x"], ["history", "mark", ID, MSG, "--status", "applied", "--note", "x"],
    ["instructions", "nope"], ["resource", "nope"], ["resource", "acquire", "x"], ["resource", "acquire", "x", "--owner", "a", "--ttl-ms", "1"], ["resource", "run", "x", "--owner", "a"],
    ["resource", "run", "x", "--owner", "a", "--exec-backend", "typo", "--", "true"], ["resource", "run", "x", "--owner", "a", "--exec-backend", "thread-shell", "--", "true"],
    ["orchestrate", "prompt"], ["--host", "local", "--host", "local", "threads", "list"], ["--require-node-version", "bad", "threads", "list"], ["remote", "nope"],
  ], REMOTE_PAIR_INPUT_INVALID: [["remote", "pair", "--code-stdin"]], SUPERVISOR_CONTROL_FORBIDDEN: [["--supervisor", SESSION, "supervise", "prompt", ID], ["--supervisor", SESSION, "supervise", ID], ["--supervisor", SESSION, "supervise", "list"]] };
  for (const [code, rows] of Object.entries(table)) for (const args of rows) {
    const { status, result } = cli(args, undefined, { CODEX_HOME: home });
    assert.equal(status, 1, args.join(" ")); assert.equal(result.error.code, code, args.join(" "));
  }
});
