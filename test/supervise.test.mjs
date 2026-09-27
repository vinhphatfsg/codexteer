import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";
const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));


const withoutSession = text => text.replaceAll(/--supervisor '[0-9a-f-]{36}'/g, "--supervisor '<SESSION>'");

function capturedAgent(output) {
  const data = JSON.parse(output); data.args = data.args.map(withoutSession); return data;
}

function fixture(t) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cs-supervise-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, "bin"); mkdirSync(bin);
  const env = { ...process.env, PATH: bin, CODEX_HOME: path.join(cwd, "unused-home") };
  symlinkSync(process.execPath, path.join(bin, "node"));
  // PATH contains only this fixture: even an incorrect launcher cannot find
  // the user's real Claude executable or start an actual supervisor session.
  writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync("started", String(process.pid));
if (process.env.CS_SUPERVISE_TEST_WAIT) {
  process.on("SIGTERM", () => { process.stdout.write("forwarded SIGTERM\\n"); process.exit(37); });
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(99), 5000);
  process.stdout.write("ready\\n");
} else if (process.env.CS_SUPERVISE_TEST_SIGNAL) {
  process.kill(process.pid, process.env.CS_SUPERVISE_TEST_SIGNAL);
} else {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input: fs.readFileSync(0, "utf8") }) + "\\n");
  process.stderr.write("agent stderr\\n");
  process.exitCode = Number(process.env.CS_SUPERVISE_TEST_EXIT ?? 0);
}
`, { mode: 0o755 });
  symlinkSync(path.join(bin, "claude"), path.join(bin, "codex"));
  return { cwd, env, encoding: "utf8", timeout: 10000 };
}

function prompt(options, policy, agent = "claude") {
  const result = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, ...(policy === undefined ? [] : [policy]), "--agent", agent], options);
  assert.equal(result.status, 0, result.stderr);
  return withoutSession(result.stdout.slice(0, -1));
}

test("supervise preserves forwarded argv and prompt boundaries, inherits cwd and all standard streams", t => {
  const options = fixture(t);
  const forwarded = ["--model", "model with spaces", "--effort", "high", "", "line 1\nline 2", "$(touch INJECTED)", "`touch INJECTED_TOO`", "*", 'quote"and\'slash\\', "--help", "--version", "--json", "--require-node-version", "v0.0.0", "--use-path-cli", "--agent", "not-a-steer-agent", "--", "literal tail"];
  const result = spawnSync(process.execPath, [BIN, "supervise", ID, "--agent", "claude", "--", ...forwarded], { ...options, input: "interactive input\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "agent stderr\n", "The CLI must not mix status output into agent streams");
  assert.deepEqual(capturedAgent(result.stdout), { args: [...forwarded, "--", prompt(options)], cwd: options.cwd, input: "interactive input\n" });
  assert.equal(existsSync(path.join(options.cwd, "INJECTED")), false);
  assert.equal(existsSync(path.join(options.cwd, "INJECTED_TOO")), false);
  assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["locks", "runtimes", "supervisors"], "The launcher saves its session without connecting to Desktop");
});

test("direct PATH CLI supervision passes the same prompt and cleans up its session without a deployment", t => {
  for (const agent of ["claude", "codex"]) {
    const options = fixture(t), policy = "観測結果を報告してください。";
    const generated = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, policy, "--agent", agent, "--use-path-cli"], options);
    assert.equal(generated.status, 0, generated.stderr);
    const forwarded = ["--use-path-cli", "--model", "agent-model"];
    const result = spawnSync(process.execPath, [BIN, "supervise", ID, policy, "--agent", agent, "--use-path-cli", "--", ...forwarded], { ...options, input: "interactive input\n" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(capturedAgent(result.stdout), { args: [...forwarded, "--", withoutSession(generated.stdout.slice(0, -1))], cwd: options.cwd, input: "interactive input\n" });
    assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["locks", "supervisors"]);
    const status = spawnSync(process.execPath, [BIN, "supervise", "status", ID, "--json"], options);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.state, "stopped");
    assert.equal(JSON.parse(status.stdout).data.owner, agent);
  }
});

test("PATH CLI launch still validates the profile before registration or agent launch", t => {
  const options = fixture(t);
  mkdirSync(options.env.CODEX_HOME); chmodSync(options.env.CODEX_HOME, 0o777);
  const result = spawnSync(process.execPath, [BIN, "supervise", ID, "--use-path-cli"], options);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ancestor can be replaced|owner-controlled/);
  assert.equal(existsSync(path.join(options.cwd, "started")), false);
  assert.deepEqual(readdirSync(options.env.CODEX_HOME), []);
});

test("supervise uses the normalized target and propagates the agent's normal exit code", t => {
  const options = fixture(t), expected = prompt(options);
  for (const exitCode of [0, 23]) {
    const result = spawnSync(process.execPath, [BIN, "supervise", "--agent", "claude", `codex://threads/${ID.toUpperCase()}?prompt=discard-me`], { ...options, env: { ...options.env, CS_SUPERVISE_TEST_EXIT: String(exitCode) } });
    assert.equal(result.status, exitCode);
    assert.deepEqual(capturedAgent(result.stdout).args, ["--", expected]);
  }
});

test("supervise defaults to Claude and accepts the same literal custom policy as prompt output", t => {
  const options = fixture(t);
  const policy = '  監視だけにしてください。\n"quoted" $(touch INJECTED) `touch INJECTED_TOO` {{threadId}} --json\n';
  const forwarded = ["--model", "model with spaces", "--json", "--agent", "preserved"];
  for (const message of [undefined, policy]) {
    const expected = prompt(options, message);
    for (const agent of [[], ["--agent", "claude"]]) {
      const result = spawnSync(process.execPath, [BIN, "supervise", ID, ...(message === undefined ? [] : [message]), ...agent, "--", ...forwarded], { ...options, input: "interactive input\n" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(capturedAgent(result.stdout), { args: [...forwarded, "--", expected], cwd: options.cwd, input: "interactive input\n" });
    }
  }
  assert.equal(existsSync(path.join(options.cwd, "INJECTED")), false);
  assert.equal(existsSync(path.join(options.cwd, "INJECTED_TOO")), false);
});

test("Codex CLI receives the selected policy and unchanged agent flags, with a stopped session after exit", t => {
  const options = fixture(t), policy = "観測を続けて確認結果を報告してください。";
  const expected = prompt(options, policy, "codex");
  const forwarded = ["--model", "example-model", "--config", 'model_reasoning_effort="high"'];
  const result = spawnSync(process.execPath, [BIN, "supervise", ID, policy, "--agent", "codex", "--", ...forwarded], { ...options, input: "input\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedAgent(result.stdout), { args: [...forwarded, "--", expected], cwd: options.cwd, input: "input\n" });
  assert.match(expected, /supervise register .* --owner codex/);
  assert.match(expected, /--source codex --kind review/);
  const status = spawnSync(process.execPath, [BIN, "supervise", "status", ID, "--json"], options);
  assert.equal(JSON.parse(status.stdout).data.state, "stopped");
  assert.equal(JSON.parse(status.stdout).data.owner, "codex");
});

test("invalid IDs, empty policies, unsupported agents and misplaced flags never start an agent", t => {
  const options = fixture(t);
  for (const args of [[], [ID, ""], [ID, " \t\n"], [ID, "policy", "extra"], [ID, "--agent"], ["invalid-id", "--agent", "claude"], [ID, "--agent", "gemini"], [ID, "--agent", "/bin/sh"], [ID, "--agent", "claude", "--agent", "claude"], [ID, "--agent", "claude", "--model", "model"], [ID, "--unexpected"]]) {
    const result = spawnSync(process.execPath, [BIN, "supervise", ...args], options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /codexteer:/);
    assert.equal(existsSync(path.join(options.cwd, "started")), false);
  }
  const json = spawnSync(process.execPath, [BIN, "supervise", ID, "--agent", "claude", "--json"], options);
  assert.equal(json.status, 1);
  assert.match(JSON.parse(json.stdout).error.message, /does not support --json/);
  assert.equal(existsSync(path.join(options.cwd, "started")), false);
  assert.equal(existsSync(options.env.CODEX_HOME), false, "Invalid arguments must fail before placement");
});

test("a modified deployment prevents agent launch without overwriting the saved files", t => {
  const options = fixture(t);
  const prepared = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, "--json"], options);
  assert.equal(prepared.status, 0, prepared.stderr);
  const saved = path.join(JSON.parse(prepared.stdout).data.deployment.directory, "src/prompt.mjs");
  writeFileSync(saved, "modified saved prompt");
  const result = spawnSync(process.execPath, [BIN, "supervise", ID, "--agent", "claude"], options);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Deployed files differ from the installed distribution/);
  assert.equal(existsSync(path.join(options.cwd, "started")), false);
  assert.equal(readFileSync(saved, "utf8"), "modified saved prompt");
});

test("missing or non-executable Claude fails without launching or exposing forwarded arguments", t => {
  const options = fixture(t), executable = path.join(options.env.PATH, "claude");
  chmodSync(executable, 0o600);
  for (const code of ["EACCES", "ENOENT"]) {
    if (code === "ENOENT") rmSync(executable);
    const result = spawnSync(process.execPath, [BIN, "supervise", ID, "--agent", "claude", "--", "private-agent-argument"], options);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Could not start claude \\(${code}\\)`));
    assert.equal(result.stderr.includes("private-agent-argument"), false);
    assert.equal(existsSync(path.join(options.cwd, "started")), false);
  }
});

test("a signal-terminated agent produces the conventional shell exit status", t => {
  const options = fixture(t);
  const result = spawnSync(process.execPath, [BIN, "supervise", ID, "--agent", "claude"], { ...options, env: { ...options.env, CS_SUPERVISE_TEST_SIGNAL: "SIGTERM" } });
  assert.equal(result.status, 128 + os.constants.signals.SIGTERM);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("signals directed at the launcher reach its agent and preserve the resulting exit code", { timeout: 10000 }, async t => {
  const options = fixture(t);
  const child = spawn(process.execPath, [BIN, "supervise", ID, "--agent", "claude"], { ...options, env: { ...options.env, CS_SUPERVISE_TEST_WAIT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const closed = once(child, "close");
  await once(child.stdout, "data");
  assert.match(output, /ready/);
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [37, null]);
  assert.equal(output, "ready\nforwarded SIGTERM\n");
  assert.equal(errors, "");
});
