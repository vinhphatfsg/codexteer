import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";
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
  assert.match(result.error.message, /Shared App Server is unavailable/);
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
    assert.match(result.error.message, /require --backend ui/);
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
    assert.match(conflict.result.error.message, /cannot be combined/);
  }
  const ui = cli(["send", ID, "test", "--sound", "--backend", "ui", "--dry-run"]);
  assert.equal(ui.status, 1);
  assert.match(ui.result.error.message, /--sound requires --backend app-server/);
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

test("command help explains purpose, results and examples without contacting Desktop", () => {
  for (const topic of ["supervise", "supervise prompt", "findings", "connection", "read", "status", "watch", "monitor", "send", "history", "instructions", "checkpoint", "resource", "doctor", "desktop", "threads", "thread", "open", "debug-ui"]) {
    for (const args of [["help", ...topic.split(" ")], [...topic.split(" "), "--help"]]) {
      const { status, result } = cli(args);
      assert.equal(status, 0); assert.equal(result.command, "help");
      assert.equal(result.data.topic, topic); assert.ok(result.data.when); assert.ok(result.data.returns); assert.ok(result.data.examples.length);
    }
  }
  const plain = spawnSync(process.execPath, ["bin/codexteer.mjs", "read", "--help"], { encoding: "utf8" });
  assert.match(plain.stdout, /使い所:/); assert.match(plain.stdout, /確認できること:/);
  for (const args of [["--help"], ["supervise", "prompt", "--help"]]) {
    const help = spawnSync(process.execPath, ["bin/codexteer.mjs", ...args], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /codexteer supervise prompt <THREAD> \[MESSAGE\](?: \[--agent claude\|codex\] \[--connection shared\|desktop\])? \[--json\]/);
    assert.doesNotMatch(help.stdout, /codexteer prompt <THREAD>/);
  }
});

test("Monitor stream rejects one-shot flags before connecting and always uses JSON errors", t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "cs-monitor-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const args of [["--until", "idle"], ["--timeout-ms", "1000"]]) {
    const result = cli(["watch", ID, "--stream", ...args], undefined, { CODEX_HOME: home });
    assert.equal(result.status, 1); assert.match(result.result.error.message, /do not combine/);
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
    assert.match(result.result.error.message, /--notify|--settle-ms|--max-hold-ms/);
    assert.doesNotMatch(result.result.error.message, /Shared App Server/);
  }
  for (const args of [[], ["--until", "change", "--timeout-ms", "0"], ["--notify", "all"], ["--stream"], ["--stream", "--notify", "all"], ["--stream", "--settle-ms", "1000", "--max-hold-ms", "10000"]]) {
    const result = cli(["watch", ID, ...args], undefined, { CODEX_HOME: home });
    assert.equal(result.status, 1); assert.match(result.result.error.message, /Shared App Server is unavailable/, args.join(" "));
  }
  const help = cli(["help", "watch"], undefined, { CODEX_HOME: home });
  assert.ok(help.result.data.usage.some(line => line.includes("--notify all|digest")));
  assert.ok(help.result.data.notes.some(line => line.includes("watch --streamの既定はdigest")));
});

test("metadata dry-run validates kind and evidence without exposing message text", () => {
  const { result } = cli(["send", ID, "private body", "--dry-run", "--kind", "hypothesis", "--source", "claude-code"]);
  assert.equal(result.data.metadata.kind, "hypothesis"); assert.equal(result.data.freshness_checked, false);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(cli(["send", ID, "test", "--dry-run", "--kind", "typo"]).status, 1);
  assert.equal(cli(["send", ID, "test", "--dry-run", "--kind", "review", "--backend", "ui"]).status, 1);
});
