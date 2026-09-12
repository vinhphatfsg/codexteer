import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const BIN = fileURLToPath(new URL("../bin/codex-steer.mjs", import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "cs-prompt-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_HOME: path.join(cwd, "unused-home") };
  return { cwd, env, encoding: "utf8" };
}

test("supervise prompt emits only orchestrator instructions, normalizes the target, and works offline outside the repo", t => {
  const options = fixture(t);
  const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options);
  assert.equal(plain.status, 0);
  assert.equal(plain.stderr, "");
  assert.match(plain.stdout, new RegExp(`対象タスク: ${ID}`));
  assert.match(plain.stdout, /監督役（オーケストレーター）/);
  assert.ok(plain.stdout.endsWith("\n"));
  assert.ok(plain.stdout.split("\n").length > 10, "The output is a multiline initial prompt");
  assert.equal(plain.stdout.includes("<THREAD>"), false, "Every example targets the selected task");
  const url = `codex://threads/${ID.toUpperCase()}?prompt=must-not-enter-supervisor-prompt`;
  const resolved = spawnSync(process.execPath, [BIN, "supervise", "prompt", url], options);
  assert.equal(resolved.status, 0);
  assert.equal(resolved.stdout, plain.stdout, "Only the normalized ID is interpolated, not URL query text");
  assert.equal(existsSync(options.env.CODEX_HOME), false, "Generating text must not create runtime or journal state");
});

test("JSON prompt output preserves the text as one field with the standard CLI envelope", t => {
  const options = fixture(t);
  const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options);
  for (const args of [["--json", "supervise", "prompt", ID], ["supervise", "prompt", ID, "--json"]]) {
    const result = spawnSync(process.execPath, [BIN, ...args], options);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "supervise.prompt", data: { thread_id: ID, prompt: plain.stdout.slice(0, -1) } });
  }
});

test("invalid prompt arguments fail without producing a partial prompt or touching state", t => {
  const options = fixture(t);
  for (const args of [[], ["invalid-id"], [ID, "extra"], [ID, "--unexpected"], [`codex://other/${ID}`], [`${ID}; echo injected`]]) {
    const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ...args], options);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, /codex-steer:/);
    const json = spawnSync(process.execPath, [BIN, "--json", "supervise", "prompt", ...args], options);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, "");
    const error = JSON.parse(json.stdout);
    assert.equal(error.ok, false);
    assert.ok(error.error.message);
    assert.equal(error.data, undefined);
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("the removed top-level prompt command and help topic fail without producing a prompt", t => {
  const options = fixture(t);
  for (const args of [["prompt", ID], ["help", "prompt"], ["prompt", "--help"]]) {
    const plain = spawnSync(process.execPath, [BIN, ...args], options);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, /codex-steer:/);
    const json = spawnSync(process.execPath, [BIN, "--json", ...args], options);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).ok, false);
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("supervise prompt composes with a shell launcher without consuming stdin or launching on invalid IDs", t => {
  const options = fixture(t);
  symlinkSync(BIN, path.join(options.cwd, "codex-steer"));
  symlinkSync(process.execPath, path.join(options.cwd, "node"));
  // Capture argv/stdin without launching a real Claude session or contacting a model.
  writeFileSync(path.join(options.cwd, "claude"), '#!/usr/bin/env node\nconst fs = require("node:fs"); process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, "utf8") }));\n', { mode: 0o755 });
  options.env.PATH = `${options.cwd}:${process.env.PATH}`;
  const expected = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options).stdout.slice(0, -1);
  const script = 'steer_prompt=$(codex-steer supervise prompt "$1") && claude "$steer_prompt"';
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    const launched = spawnSync(shell, ["-f", "-c", script, "prompt-shortcut-test", ID], { ...options, input: "terminal input remains available\n" });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout), { args: [expected], input: "terminal input remains available\n" });
    const rejected = spawnSync(shell, ["-f", "-c", script, "prompt-shortcut-test", "invalid-id"], options);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "", "Claude must not start when prompt generation fails");
  }
});
