import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeRecord } from "../src/store.mjs";
import { DEFAULT_SUPERVISION_POLICY, supervisorPrompt } from "../src/prompt.mjs";
import { ORCHESTRATED_SUPERVISION_POLICY } from "../src/orchestrate-prompt.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const REPO = path.dirname(path.dirname(BIN));

test("the prompt keeps digest watch commands and the safety rules the supervisor must follow", () => {
  const prompt = supervisorPrompt(ID, "saved-command").prompt;
  const startup = prompt.split("\n\n").find(section => section.startsWith("4. 開始手順"));
  assert.ok(startup);
  assert.doesNotMatch(startup, /help monitor/, "Startup must not reread the procedure the prompt already contains");
  assert.ok(prompt.includes("saved-command help monitor"), "Resuming after a summary rereads the procedure with the saved command");
  assert.match(prompt, /watch .* --stream --notify digest --since/);
  assert.match(prompt, /watch .* --since .* --until change --timeout-ms 30000/);
  assert.match(prompt, /digest\.from_cursor/);
  for (const rule of ["paused", "SUPERVISOR_STOPPED", "--supervisor", "--new-turn", "自動再送", "reconnecting"]) assert.ok(prompt.includes(rule), rule);
});

test("every supervision policy keeps the shared idle reply, decision kind and shell command rules", () => {
  for (const policy of [undefined, "セキュリティの問題だけを私へ報告してください。", ORCHESTRATED_SUPERVISION_POLICY]) {
    for (const usePathCli of [false, true]) {
      const { prompt } = supervisorPrompt(ID, "saved-command", policy, undefined, { usePathCli });
      assert.match(prompt, /「変化なし」/);
      assert.match(prompt, /--kind decision[^。]*ユーザー本人/);
      assert.match(prompt, /シェル変数/);
    }
  }
});


const withoutSession = text => text.replaceAll(/--supervisor '[0-9a-f-]{36}'/g, "--supervisor '<SESSION>'");

function versionCommand(text) {
  const command = text.split("\n").find(line => line.endsWith(" --version"));
  assert.ok(command, "The prompt must include an executable CLI version check");
  return command;
}

function copyCli(directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of ["src", "bin", "assets", "scripts"]) cpSync(path.join(REPO, name), path.join(directory, name), { recursive: true });
  for (const name of ["package.json", "LICENSE"]) copyFileSync(path.join(REPO, name), path.join(directory, name));
  mkdirSync(path.join(directory, "node_modules"));
  cpSync(path.join(REPO, "node_modules/ws"), path.join(directory, "node_modules/ws"), { recursive: true });
  return path.join(directory, "bin/codexteer.mjs");
}

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
  assert.ok(plain.stdout.endsWith("\n"));
  assert.ok(plain.stdout.split("\n").length > 10, "The output is a multiline initial prompt");
  assert.equal(plain.stdout.includes("<THREAD>"), false, "Every example targets the selected task");
  const url = `codex://threads/${ID.toUpperCase()}?prompt=must-not-enter-supervisor-prompt`;
  const resolved = spawnSync(process.execPath, [BIN, "supervise", "prompt", url], options);
  assert.equal(resolved.status, 0);
  assert.equal(withoutSession(resolved.stdout), withoutSession(plain.stdout), "Only the normalized ID is interpolated, not URL query text");
  assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["runtimes"], "Generation prepares only the distribution, without connections or journal state");
});

test("JSON prompt output preserves the text as one field with the standard CLI envelope", t => {
  const options = fixture(t);
  const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options);
  for (const args of [["--json", "supervise", "prompt", ID], ["supervise", "prompt", ID, "--json"]]) {
    const result = spawnSync(process.execPath, [BIN, ...args], options);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const { ok, command, data } = JSON.parse(result.stdout);
    assert.equal(ok, true); assert.equal(command, "supervise.prompt");
    assert.equal(data.thread_id, ID); assert.equal(withoutSession(data.prompt), withoutSession(plain.stdout.slice(0, -1)));
    assert.equal(data.deployment.reused, true);
    assert.equal(data.cli_mode, "saved");
    assert.match(data.deployment.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(data.node, { path: realpathSync(process.execPath), version: process.version });
  }
});

test("PATH CLI prompts omit executable paths and deployment, preserving policy and session controls", t => {
  const options = fixture(t), policy = "この方針だけで監督してください。";
  options.env.PATH = "/no-cli-installed";
  for (const connection of ["shared", "desktop"]) {
    for (const agent of ["claude", "codex"]) {
      const result = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, policy, "--use-path-cli", "--agent", agent, "--connection", connection, "--json"], options);
      assert.equal(result.status, 0, result.stderr);
      const { data } = JSON.parse(result.stdout);
      assert.equal(data.cli_mode, "path");
      assert.equal(data.deployment, null); assert.equal(data.node, null);
      assert.equal(data.supervisor.owner, agent); assert.equal(data.supervisor.connection, connection);
      assert.ok(data.prompt.includes(policy));
      const prefix = `codexteer --supervisor '${data.supervisor.session_id}' --connection ${connection}`;
      for (const operation of ["--version", "doctor", "supervise register", "read", "watch", "history list", "findings list"]) {
        assert.ok(data.prompt.includes(`\n${prefix} ${operation}`), operation);
      }
      assert.match(data.prompt, /^command -v codexteer$/m);
      assert.doesNotMatch(data.prompt, /CODEX_HOME=|--require-node-version|codex-steer\/runtimes/);
      assert.equal(data.prompt.includes(options.cwd), false);
      assert.equal(data.prompt.includes(realpathSync(process.execPath)), false);
      if (connection === "desktop") assert.doesNotMatch(data.prompt, /\n.* send /);
      else assert.ok(data.prompt.includes(`\n${prefix} send `));
    }
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false, "PATH prompt generation must not write a deployment or register a session");
});

test("PATH prompt commands use the receiving PATH and profile, and preserve registration and stop checks", async t => {
  const options = fixture(t);
  const generated = spawnSync(process.execPath, [BIN, "supervise", "prompt", "--use-path-cli", ID, "--json"], options);
  assert.equal(generated.status, 0, generated.stderr);
  const { prompt } = JSON.parse(generated.stdout).data;
  const bin = path.join(options.cwd, "bin"); mkdirSync(bin);
  const cli = path.join(bin, "codexteer"); symlinkSync(BIN, cli);
  symlinkSync(process.execPath, path.join(bin, "node"));
  const home = path.join(options.cwd, "receiving-home"); mkdirSync(home, { mode: 0o700 });
  const receiving = { ...options, env: { ...options.env, PATH: bin, CODEX_HOME: home } };
  const command = suffix => prompt.split("\n").find(line => line.includes(suffix));
  const bootstrap = command(` supervise register ${ID} `);
  const registered = spawnSync("/bin/sh", ["-c", bootstrap], receiving);
  assert.equal(registered.status, 0, registered.stderr);
  await writeRecord("messages", "receiver", { id: "receiver", thread_id: ID, created_at: "2026-01-01T00:00:00Z" }, { home });
  const historyCommand = command(` history list ${ID} --pending --json`);
  const history = spawnSync("/bin/sh", ["-c", historyCommand], receiving);
  assert.equal(history.status, 0, history.stderr);
  assert.deepEqual(JSON.parse(history.stdout).data.map(entry => entry.id), ["receiver"]);
  const stopped = spawnSync(process.execPath, [BIN, "supervise", "stop", ID, "--json"], receiving);
  assert.equal(stopped.status, 0, stopped.stderr);
  const rejected = spawnSync("/bin/sh", ["-c", bootstrap], receiving);
  assert.equal(rejected.status, 1);
  assert.equal(existsSync(options.env.CODEX_HOME), false, "Generated commands must not bind to the producer's profile in PATH mode");
  unlinkSync(cli); writeFileSync(cli, '#!/bin/sh\nprintf "path-cli-updated\\n"\n', { mode: 0o755 });
  const updated = spawnSync("/bin/sh", ["-c", versionCommand(prompt)], receiving);
  assert.equal(updated.status, 0); assert.equal(updated.stdout, "path-cli-updated\n");
});

test("a custom policy replaces the default policy while retaining the shared template and saved invocation", t => {
  const options = fixture(t);
  const policy = "  セキュリティの問題だけを私へ報告し、Codexへは送信しないでください。\n{{threadId}} ${command} --help --json は本文のまま保持。  ";
  function prepare(message) {
    const result = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, ...message, "--json"], options);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).data;
  }
  const standard = prepare([]), custom = prepare([policy]);
  assert.ok(standard.prompt.includes(DEFAULT_SUPERVISION_POLICY));
  assert.equal(custom.prompt.includes(DEFAULT_SUPERVISION_POLICY), false);
  assert.equal(withoutSession(custom.prompt.replace(policy, () => DEFAULT_SUPERVISION_POLICY)), withoutSession(standard.prompt), "Custom policy must replace the default verbatim, keeping the shared template");
  assert.equal(custom.deployment.directory, standard.deployment.directory, "Policy must not create another executable distribution");
  assert.equal(custom.deployment.reused, true);
  assert.equal(withoutSession(versionCommand(custom.prompt)), withoutSession(versionCommand(standard.prompt)));
  assert.notEqual(custom.supervisor.session_id, standard.supervisor.session_id);
  const after = prepare([]);
  assert.equal(withoutSession(after.prompt), withoutSession(standard.prompt), "An override must not persist into the next invocation");
});

test("generated commands use the saved CLI despite missing or shadowed PATH commands", t => {
  const options = fixture(t);
  const poison = path.join(options.cwd, "poison"); mkdirSync(poison);
  for (const name of ["node", "codexteer", "npx"]) {
    writeFileSync(path.join(poison, name), '#!/bin/sh\necho wrong-executable >&2\nexit 91\n', { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options);
  assert.equal(result.status, 0, result.stderr);
  const command = versionCommand(result.stdout);
  assert.ok(command.includes(realpathSync(process.execPath)));
  assert.ok(command.includes("/codex-steer/runtimes/"));
  assert.equal(command.includes(realpathSync(BIN)), false);
  assert.doesNotMatch(result.stdout, /^(?:command -v codexteer|codexteer |npx )/m);
  const prefix = command.slice(0, -" --version".length);
  for (const operation of ["doctor", "help send", "read", "watch", "send", "history list", "history check", "instructions list"]) {
    assert.ok(result.stdout.includes(`\n${prefix} ${operation}`), `Missing bound command: ${operation}`);
  }
  const expected = spawnSync(process.execPath, [BIN, "--version"], options).stdout;
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    for (const PATH of [poison, path.join(options.cwd, "no-bin")]) {
      const executed = spawnSync(shell, ["-f", "-c", command], { ...options, env: { ...options.env, PATH } });
      assert.equal(executed.status, 0, executed.stderr);
      assert.equal(executed.stdout, expected);
      assert.equal(executed.stderr, "");
    }
  }
  assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["runtimes"]);
});

test("pasted commands retain the generating profile when the receiving environment or home alias changes", async t => {
  for (const source of ["absolute", "relative", "symlink", "default"]) {
    const options = fixture(t);
    const producerUser = path.join(options.cwd, "producer-user");
    const originalHome = source === "default" ? path.join(producerUser, ".codex")
      : path.join(options.cwd, "home 日本語 'quoted' $(touch INJECTED) `touch ALSO_INJECTED`");
    mkdirSync(originalHome, { recursive: true, mode: 0o700 });
    options.env.HOME = producerUser;
    options.env.CODEX_HOME = source === "relative" ? path.relative(options.cwd, originalHome) : originalHome;
    const alias = path.join(options.cwd, "home-alias");
    if (source === "symlink") { symlinkSync(originalHome, alias); options.env.CODEX_HOME = alias; }
    if (source === "default") delete options.env.CODEX_HOME;
    const prepared = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, "--json"], options);
    assert.equal(prepared.status, 0, prepared.stderr);
    const data = JSON.parse(prepared.stdout).data;
    const command = data.prompt.split("\n").find(line => line.endsWith(` history list ${ID} --pending --json`));
    assert.ok(command);
    const bootstrap = data.prompt.split("\n").find(line => line.includes(` supervise register ${ID} `));
    const registered = spawnSync("/bin/sh", ["-c", bootstrap], options);
    assert.equal(registered.status, 0, registered.stderr || registered.stdout);
    const recipientUser = path.join(options.cwd, "recipient-user"), differentHome = path.join(options.cwd, "different-home");
    for (const [home, id] of [[originalHome, "original"], [differentHome, "different"], [path.join(recipientUser, ".codex"), "recipient-default"]]) {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      await writeRecord("messages", id, { id, thread_id: ID, created_at: "2026-01-01T00:00:00Z" }, { home });
    }
    // The saved executable and profile must stay paired even if this alias moves.
    if (source === "symlink") { unlinkSync(alias); symlinkSync(differentHome, alias); }
    for (const receivingHome of [undefined, differentHome]) {
      const env = { ...options.env, HOME: recipientUser, PATH: "/no-supervisor-cli" };
      if (receivingHome === undefined) delete env.CODEX_HOME;
      else env.CODEX_HOME = receivingHome;
      for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
        const executed = spawnSync(shell, ["-f", "-c", command], { ...options, cwd: recipientUser, env });
        assert.equal(executed.status, 0, executed.stderr);
        assert.deepEqual(JSON.parse(executed.stdout).data.map(entry => entry.id), ["original"], `${source} home via ${shell}`);
        for (const marker of ["INJECTED", "ALSO_INJECTED"]) assert.equal(existsSync(path.join(recipientUser, marker)), false);
      }
    }
    assert.equal(data.deployment.codex_home, realpathSync(originalHome));
  }
});

test("generated shell arguments preserve spaces, quotes, unicode and command substitution text in CLI paths", t => {
  const options = fixture(t);
  const copied = copyCli(path.join(options.cwd, "CLI 日本語 'quoted' $(touch INJECTED) `touch ALSO_INJECTED`"));
  options.env.CODEX_HOME = path.join(options.cwd, "home 日本語 'quoted' $(touch INJECTED) `touch ALSO_INJECTED`");
  // A symlinked entry point must still bind to the actual distribution.
  const linked = path.join(options.cwd, "entry.mjs"); symlinkSync(copied, linked);
  const result = spawnSync(process.execPath, [linked, "supervise", "prompt", ID], options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(linked), false);
  const command = versionCommand(result.stdout);
  const expected = spawnSync(process.execPath, [copied, "--version"], options).stdout;
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    const executed = spawnSync(shell, ["-f", "-c", command], { ...options, env: { ...options.env, PATH: "/usr/bin:/bin" } });
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(executed.stdout, expected);
    assert.equal(executed.stderr, "");
    assert.equal(existsSync(path.join(options.cwd, "INJECTED")), false);
    assert.equal(existsSync(path.join(options.cwd, "ALSO_INJECTED")), false);
  }
});

test("control characters in a deployment path fail before emitting a partial prompt or saving files", t => {
  const options = fixture(t);
  options.env.CODEX_HOME = path.join(options.cwd, "home\ninjected instructions");
  const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, "");
  const json = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, "--json"], options);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).error.code, "SUPERVISION_PATH_UNSAFE");
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("a prepared prompt keeps the original CLI after same-version source edits, upgrades and removal", t => {
  const options = fixture(t), source = path.join(options.cwd, "source"), copied = copyCli(source);
  function prepare() {
    const result = spawnSync(process.execPath, [copied, "supervise", "prompt", ID, "--json"], options);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  }
  const first = prepare(), oldCommand = versionCommand(first.prompt);
  const promptFile = path.join(source, "src/prompt.mjs");
  writeFileSync(promptFile, readFileSync(promptFile, "utf8").replace("あなたはCodex", "更新後の監督: あなたはCodex"));
  const edited = prepare();
  assert.equal(edited.deployment.version, first.deployment.version);
  assert.notEqual(edited.deployment.directory, first.deployment.directory);
  assert.match(edited.prompt, /更新後の監督/);
  assert.doesNotMatch(first.prompt, /更新後の監督/);
  const pkgPath = path.join(source, "package.json"), pkg = JSON.parse(readFileSync(pkgPath));
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: "99.0.0" }));
  const upgraded = prepare();
  assert.equal(upgraded.deployment.version, "99.0.0");
  assert.notEqual(upgraded.deployment.directory, first.deployment.directory);
  rmSync(source, { recursive: true });
  for (const [command, version] of [[oldCommand, first.deployment.version], [versionCommand(upgraded.prompt), "99.0.0"]]) {
    const result = spawnSync("/bin/sh", ["-c", command], { ...options, env: { ...options.env, PATH: "/no-cli" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
});

test("a modified saved copy is rejected without repair or partial prompt output", t => {
  const options = fixture(t);
  const first = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, "--json"], options);
  assert.equal(first.status, 0, first.stderr);
  const saved = path.join(JSON.parse(first.stdout).data.deployment.directory, "src/prompt.mjs");
  writeFileSync(saved, "tampered");
  const rejected = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID, "--json"], options);
  assert.equal(rejected.status, 1);
  const result = JSON.parse(rejected.stdout);
  assert.equal(result.error.code, "DEPLOYMENT_MODIFIED");
  assert.equal(result.data, undefined);
  assert.equal(readFileSync(saved, "utf8"), "tampered");
});

test("the supervision Node guard rejects a changed version before any operation or placement", t => {
  const options = fixture(t);
  for (const args of [["send", ID, "must not send"], ["supervise", "prompt", ID], ["desktop", "start"], ["--version"]]) {
    const result = spawnSync(process.execPath, [BIN, "--require-node-version", "v0.0.0", ...args, "--json"], options);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, "NODE_VERSION_MISMATCH");
  }
  const allowed = spawnSync(process.execPath, [BIN, "--require-node-version", process.version, "--version"], options);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("help remains read-only and does not place a supervision distribution", t => {
  const options = fixture(t);
  for (const topic of ["supervise", "supervise prompt", "monitor"]) {
    const result = spawnSync(process.execPath, [BIN, "help", ...topic.split(" ")], options);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("invalid prompt arguments fail without producing a partial prompt or touching state", t => {
  const options = fixture(t);
  for (const args of [[], ["invalid-id"], [ID, "policy", "extra"], [ID, ""], [ID, " \t\n"], [ID, "--unexpected"], [ID, "--use-path-cli", "--use-path-cli"], [ID, "--use-path-cli=false"], [ID, "--use-path-cli", "--agent", "unknown"], ["invalid-id", "--use-path-cli"], [`codex://other/${ID}`], [`${ID}; echo injected`]]) {
    const plain = spawnSync(process.execPath, [BIN, "supervise", "prompt", ...args], options);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, "");
    assert.match(plain.stderr, /codexteer:/);
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
    assert.match(plain.stderr, /codexteer:/);
    const json = spawnSync(process.execPath, [BIN, "--json", ...args], options);
    assert.equal(json.status, 1);
    assert.equal(JSON.parse(json.stdout).ok, false);
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("supervise prompt composes with a shell launcher without consuming stdin or launching on invalid IDs", t => {
  const options = fixture(t);
  symlinkSync(BIN, path.join(options.cwd, "codexteer"));
  symlinkSync(process.execPath, path.join(options.cwd, "node"));
  // Capture argv/stdin without launching a real Claude session or contacting a model.
  writeFileSync(path.join(options.cwd, "claude"), '#!/usr/bin/env node\nconst fs = require("node:fs"); process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, "utf8") }));\n', { mode: 0o755 });
  options.env.PATH = `${options.cwd}:${process.env.PATH}`;
  const expected = spawnSync(process.execPath, [BIN, "supervise", "prompt", ID], options).stdout.slice(0, -1);
  const script = 'steer_prompt=$(codexteer supervise prompt "$1") && claude "$steer_prompt"';
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    const launched = spawnSync(shell, ["-f", "-c", script, "prompt-shortcut-test", ID], { ...options, input: "terminal input remains available\n" });
    assert.equal(launched.status, 0, launched.stderr);
    const captured = JSON.parse(launched.stdout); captured.args = captured.args.map(withoutSession);
    assert.deepEqual(captured, { args: [withoutSession(expected)], input: "terminal input remains available\n" });
    const rejected = spawnSync(shell, ["-f", "-c", script, "prompt-shortcut-test", "invalid-id"], options);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "", "Claude must not start when prompt generation fails");
  }
});
