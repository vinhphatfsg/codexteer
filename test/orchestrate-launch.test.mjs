import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PROJECT = "Example Project", GOAL = "  見える成果\n${goal} $(touch INJECTED) `touch INJECTED_TOO`  ";

function fixture(t) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ct-orchestrate-launch-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, "bin"); mkdirSync(bin); symlinkSync(process.execPath, path.join(bin, "node"));
  // These are the only agents on PATH. No real account, Desktop or model is used.
  for (const agent of ["claude", "codex"]) writeFileSync(path.join(bin, agent), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("started", String(process.pid));
if (process.env.CT_ORCHESTRATE_WAIT) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { process.stdout.write(signal + "\\n"); process.exit(37); });
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(99), 5000);
  process.stdout.write("ready\\n");
} else if (process.env.CT_ORCHESTRATE_SIGNAL) process.kill(process.pid, process.env.CT_ORCHESTRATE_SIGNAL);
else {
  console.log(JSON.stringify({ agent: ${JSON.stringify(agent)}, args: process.argv.slice(2), cwd: process.cwd(), input: fs.readFileSync(0, "utf8"), inherited: process.env.CT_ORCHESTRATE_VALUE }));
  process.stderr.write("agent stderr\\n");
  process.exitCode = Number(process.env.CT_ORCHESTRATE_EXIT ?? 0);
}
`, { mode: 0o755 });
  return { cwd, env: { ...process.env, PATH: bin, CODEX_HOME: path.join(cwd, "unused-home"), CODEX_THREAD_ID: ID, CT_ORCHESTRATE_VALUE: "inherited value" }, encoding: "utf8", timeout: 10000 };
}

function run(options, args, input = "interactive input\n") {
  return spawnSync(process.execPath, [BIN, "orchestrate", ...args], { ...options, input });
}

function expectedPrompt(options, goal, agent, pathMode) {
  const result = run(options, ["prompt", "--project", PROJECT, goal, "--agent", agent, ...(pathMode ? ["--use-path-cli"] : [])]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.slice(0, -1);
}

test("direct orchestration starts either CLI in saved and PATH modes with the exact generated prompt", t => {
  for (const agent of ["claude", "codex"]) for (const pathMode of [false, true]) {
    const options = fixture(t), expected = expectedPrompt(options, GOAL, agent, pathMode);
    const result = run(options, ["--project", PROJECT, GOAL, "--agent", agent, ...(pathMode ? ["--use-path-cli"] : [])]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "agent stderr\n");
    assert.deepEqual(JSON.parse(result.stdout), { agent, args: ["--", expected], cwd: options.cwd, input: "interactive input\n", inherited: "inherited value" });
    assert.match(expected, /役割は特定のモデルに依存せず/);
    assert.ok(expected.includes(`--agent ${agent}${pathMode ? " --use-path-cli" : ""} --json`));
    assert.equal(existsSync(path.join(options.env.CODEX_HOME, "codex-steer", "supervisors")), false, "A project launch cannot fabricate a single-task registration");
    if (pathMode) assert.deepEqual(readdirSync(options.env.CODEX_HOME), []);
    else assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["runtimes"]);
    for (const marker of ["INJECTED", "INJECTED_TOO"]) assert.equal(existsSync(path.join(options.cwd, marker)), false);
  }
});

test("direct orchestration defaults to Claude and preserves the launched CLI's exit code", t => {
  const options = fixture(t), expected = expectedPrompt(options, GOAL, "claude", true);
  for (const code of [0, 23]) {
    const result = run({ ...options, env: { ...options.env, CT_ORCHESTRATE_EXIT: String(code) } }, ["--project", PROJECT, GOAL, "--use-path-cli"]);
    assert.equal(result.status, code); assert.equal(JSON.parse(result.stdout).agent, "claude");
    assert.deepEqual(JSON.parse(result.stdout).args, ["--", expected]);
  }
});

test("agent arguments after -- retain order, empty values and CLI-looking flags without shell expansion", t => {
  const options = fixture(t), expected = expectedPrompt(options, GOAL, "codex", true);
  const forwarded = ["--model", "model with spaces", "", "line 1\nline 2", "$(touch ARGV_INJECTED)", "`touch ARGV_TOO`", "*", 'quote"and\'slash\\', "--help", "--version", "--json", "--require-node-version", "v0.0.0", "--use-path-cli", "--agent", "unchanged", "--", "tail"];
  const result = run(options, ["--project", PROJECT, GOAL, "--agent", "codex", "--use-path-cli", "--", ...forwarded]);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).args, [...forwarded, "--", expected]);
  assert.equal(existsSync(path.join(options.cwd, "ARGV_INJECTED")), false); assert.equal(existsSync(path.join(options.cwd, "ARGV_TOO")), false);
});

test("stdin goals preserve literal leading flags while prompt-only generation remains non-launching", t => {
  const options = fixture(t), goal = "--json\n--agent untouched\n";
  const generated = run(options, ["prompt", "--project", PROJECT, "--agent", "codex", "--use-path-cli", "--json", "-"], goal);
  assert.equal(generated.status, 0, generated.stderr); assert.equal(JSON.parse(generated.stdout).data.goal, goal);
  assert.equal(existsSync(path.join(options.cwd, "started")), false); assert.equal(existsSync(options.env.CODEX_HOME), false);
  const direct = run(options, ["--project", PROJECT, "--agent", "codex", "--use-path-cli", "-"], goal);
  assert.equal(direct.status, 0, direct.stderr); assert.deepEqual(JSON.parse(direct.stdout).args, ["--", JSON.parse(generated.stdout).data.prompt]);
  assert.equal(JSON.parse(direct.stdout).input, "", "stdin was consumed as GOAL before launch");
});

test("invalid direct inputs, managed scope and JSON output never deploy or launch", t => {
  const options = fixture(t);
  const cases = [[], ["--project", PROJECT], ["--project", PROJECT, ""], ["--project", PROJECT, " \n"], ["goal"],
    ["--project", PROJECT, "goal", "extra"], ["--project", PROJECT, "goal", "--agent"], ["--project", PROJECT, "goal", "--agent", "gemini"],
    ["--project", PROJECT, "goal", "--agent", "/bin/sh"], ["--project", PROJECT, "goal", "--project", "extra"],
    ["--project", PROJECT, "goal", "--model", "misplaced"], ["--project", PROJECT, "goal", "--json"],
    ["--supervisor", ID, "--project", PROJECT, "goal"], ["--connection", "desktop", "--project", PROJECT, "goal"]];
  for (const args of cases) {
    const result = run(options, args); assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(existsSync(path.join(options.cwd, "started")), false); assert.equal(existsSync(options.env.CODEX_HOME), false);
  }
});

test("PATH direct launch validates the profile without loosening ownership checks", t => {
  const options = fixture(t); mkdirSync(options.env.CODEX_HOME); chmodSync(options.env.CODEX_HOME, 0o777);
  const result = run(options, ["--project", PROJECT, GOAL, "--use-path-cli"]);
  assert.equal(result.status, 1); assert.match(result.stderr, /ancestor can be replaced|owner-controlled/);
  assert.equal(existsSync(path.join(options.cwd, "started")), false); assert.deepEqual(readdirSync(options.env.CODEX_HOME), []);
});

test("saved direct launch rejects a modified deployment without overwriting or starting an agent", t => {
  const options = fixture(t);
  const prepared = run(options, ["prompt", "--project", PROJECT, GOAL, "--json"]); assert.equal(prepared.status, 0, prepared.stderr);
  const saved = path.join(JSON.parse(prepared.stdout).data.deployment.directory, "src/orchestrate-prompt.mjs"); writeFileSync(saved, "modified");
  const result = run(options, ["--project", PROJECT, GOAL]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Deployed files differ/); assert.equal(readFileSync(saved, "utf8"), "modified");
  assert.equal(existsSync(path.join(options.cwd, "started")), false);
});

test("missing and non-executable agents fail without leaking private forwarded arguments", t => {
  for (const agent of ["claude", "codex"]) {
    const options = fixture(t), executable = path.join(options.env.PATH, agent); chmodSync(executable, 0o600);
    for (const code of ["EACCES", "ENOENT"]) {
      if (code === "ENOENT") rmSync(executable);
      const result = run(options, ["--project", PROJECT, GOAL, "--agent", agent, "--use-path-cli", "--", "private-agent-argument"]);
      assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, new RegExp(`Could not start ${agent} \\(${code}\\)`));
      assert.equal(result.stderr.includes("private-agent-argument"), false); assert.equal(existsSync(path.join(options.cwd, "started")), false);
    }
  }
});

test("signal termination preserves the conventional shell exit code", t => {
  const options = fixture(t);
  const result = run({ ...options, env: { ...options.env, CT_ORCHESTRATE_SIGNAL: "SIGTERM" } }, ["--project", PROJECT, GOAL, "--use-path-cli"]);
  assert.equal(result.status, 128 + os.constants.signals.SIGTERM); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("SIGINT, SIGTERM and SIGHUP reach the launched orchestrator", { timeout: 15000 }, async t => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const options = fixture(t);
    const child = spawn(process.execPath, [BIN, "orchestrate", "--project", PROJECT, GOAL, "--use-path-cli"], { ...options, env: { ...options.env, CT_ORCHESTRATE_WAIT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let output = "", errors = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
    const closed = once(child, "close"); await once(child.stdout, "data"); assert.equal(output, "ready\n");
    child.kill(signal); assert.deepEqual(await closed, [37, null]); assert.equal(output, `ready\n${signal}\n`); assert.equal(errors, "");
  }
});
