import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orchestrationPrompt, ORCHESTRATED_SUPERVISION_POLICY } from "../src/orchestrate-prompt.mjs";

const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const REPO = path.dirname(path.dirname(BIN));
const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ct-orchestrate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, env: { ...process.env, CODEX_HOME: path.join(cwd, "unused-home"), CODEX_THREAD_ID: ID }, encoding: "utf8" };
}

function cli(options, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { ...options, ...(input === undefined ? {} : { input }) });
}

function childPreparation(prompt, agent = "codex") {
  const command = prompt.split("\n").find(line => line.includes(" supervise prompt <THREAD-ID> "));
  assert.ok(command, "The workflow must generate an individually bound child prompt");
  return command.replace("<THREAD-ID>", ID).replace("<AGENT>", agent);
}

test("orchestration preserves the goal and connects ambition, dissent and evidence to concrete decisions", () => {
  const goal = "  見える成果\n{{command}} ${goal} $(touch should-not-exist)  ";
  const data = orchestrationPrompt("My Project", goal, "prepared-command --connection shared");
  assert.equal(data.goal, goal);
  assert.equal(data.project_selector, "My Project");
  assert.ok(data.prompt.includes(goal));
  for (const requirement of [
    /高度:.*作業→成果→上位の目的/,
    /深さ:.*一次資料・生データ・実コード.*自分や実装担当の説明以外/,
    /範囲:.*使う技法・期待する改善・確かめ方/,
    /現状.*挑戦目標|要求基準、現状、.*挑戦目標/,
    /主要な実装方針を選ぶ前.*重要な新しい証拠.*統合前.*全体の完了前/,
    /代理指標だけを良くしていないか/,
    /継続・計画変更・権限や目的の確認/,
    /Codex.*調査・設計判断・実装・検証.*異論や改善案/,
    /妥当なら計画と発注書を更新/,
    /期待する結論を指定しません/,
    /受入条件を都合よく緩めず/,
    /自分の仮説をユーザー決定として伝えません/,
    /同じ目的の未完了作業.*後続ターン開始/,
    /監視を開始できなければ追加作成を止め/,
    /個別の監督コマンド/,
    /unknown\/dispatchingは未作成の証拠ではありません/,
    /一括停止する機能ではありません/,
  ]) assert.ok(requirement.test(data.prompt), `Missing orchestration requirement: ${requirement}`);
  assert.equal(data.prompt.includes(ID), false, "An unrelated environment thread is not a target");
  const operationLines = data.prompt.split("\n").filter(line => line.startsWith("prepared-command "));
  assert.ok(operationLines.some(line => line.includes(" thread create --project <PROJECT-ID> ")));
  assert.ok(operationLines.every(line => !line.includes("--supervisor")), "Project operations cannot borrow a child's supervisor ID");
  assert.ok(childPreparation(data.prompt).includes(ORCHESTRATED_SUPERVISION_POLICY));
});

test("PATH generation is deterministic, offline and does not create any state", t => {
  const options = fixture(t);
  options.env.PATH = "/no-cli-on-path";
  const project = "日本語 'quoted' $(touch unexpected)", goal = "  user goal\n${command} {{threadId}} `literal`  ";
  const args = ["orchestrate", "prompt", "--project", project, goal, "--use-path-cli"];
  const plain = cli(options, args);
  assert.equal(plain.status, 0, plain.stderr);
  const result = cli(options, [...args, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const { command, data } = JSON.parse(result.stdout);
  assert.equal(command, "orchestrate.prompt");
  assert.equal(data.project_selector, project); assert.equal(data.goal, goal);
  assert.equal(plain.stdout, data.prompt + "\n");
  assert.equal(data.cli_mode, "path"); assert.equal(data.connection, "shared");
  assert.equal(data.deployment, null); assert.equal(data.node, null);
  assert.equal(Object.hasOwn(data, "supervisor"), false);
  assert.match(data.prompt, /^codexteer --connection shared projects list --json$/m);
  assert.equal(data.agent, null);
  assert.match(data.prompt, /--agent <AGENT> --use-path-cli --json/);
  assert.match(childPreparation(data.prompt), / --agent codex --use-path-cli --json$/);
  assert.doesNotMatch(data.prompt, /Claude|--agent claude/);
  assert.doesNotMatch(data.prompt, /CODEX_HOME=|--require-node-version|codex-steer\/runtimes/);
  assert.equal(existsSync(options.env.CODEX_HOME), false);
  assert.deepEqual(readdirSync(options.cwd), []);
});

test("stdin and literal goal arguments retain their exact content without replacing policy", t => {
  const options = fixture(t), goal = "\n最初の目標\n--use-path-cli ${command}\n  ";
  const stdin = cli(options, ["--json", "orchestrate", "prompt", "--project", "P", "--use-path-cli", "-"], goal);
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(JSON.parse(stdin.stdout).data.goal, goal);
  for (const literal of ["--json", "--use-path-cli", "--"]) {
    const result = cli(options, ["--json", "orchestrate", "prompt", "--project", "P", "--use-path-cli", "--", literal]);
    assert.equal(result.status, 0, result.stderr);
    const { data } = JSON.parse(result.stdout);
    assert.equal(data.goal, literal);
    assert.match(data.prompt, /2\. 高度・深さ・範囲/);
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("both help routes work offline and describe metadata and generation boundaries", t => {
  const options = fixture(t);
  for (const args of [["help", "orchestrate"], ["help", "orchestrate", "prompt"], ["orchestrate", "--help"], ["orchestrate", "prompt", "--help"]]) {
    const result = cli(options, [...args, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { data } = JSON.parse(result.stdout);
    assert.match(data.topic, /^orchestrate( prompt)?$/);
    assert.ok(data.usage.some(usage => /orchestrate prompt --project/.test(usage)));
    if (data.topic.endsWith(" prompt")) assert.match(data.returns, /project_selector.*goal.*cli_mode/);
  }
  const overview = JSON.parse(cli(options, ["help", "--json"]).stdout).data;
  assert.ok(overview.use_cases.some(entry => entry.command === "help orchestrate prompt"));
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("invalid inputs and incompatible scope fail before deployment or a partial prompt", t => {
  const options = fixture(t);
  const cases = [
    { args: ["orchestrate"] },
    { args: ["orchestrate", "start"] },
    { args: ["orchestrate", "prompt", "--project", "P"] },
    { args: ["orchestrate", "prompt", "goal"], code: "PROJECT_REQUIRED" },
    { args: ["orchestrate", "prompt", "--project", " ", "goal"], code: "PROJECT_REQUIRED" },
    { args: ["orchestrate", "prompt", "--project", "bad\nproject", "goal"], code: "INVALID_ORCHESTRATION_PROJECT" },
    { args: ["orchestrate", "prompt", "--project", "P", ""], code: "INVALID_ORCHESTRATION_GOAL" },
    { args: ["orchestrate", "prompt", "--project", "P", "-"], input: " \n ", code: "INVALID_ORCHESTRATION_GOAL" },
    { args: ["orchestrate", "prompt", "--project", "P", "goal", "extra"] },
    { args: ["orchestrate", "prompt", "--project", "P", "goal", "--agent", "other"], code: "INVALID_ORCHESTRATION_AGENT" },
    { args: ["orchestrate", "prompt", "--project", "P", "goal", "--policy", "custom"] },
    { args: ["orchestrate", "prompt", "--project", "P", "--project", "Q", "goal"] },
    { args: ["--connection", "desktop", "orchestrate", "prompt", "--project", "P", "goal"], code: "DESKTOP_READ_ONLY" },
    { args: ["--supervisor", ID, "orchestrate", "prompt", "--project", "P", "goal"], code: "SUPERVISOR_CONTROL_FORBIDDEN" },
  ];
  for (const { args, input, code } of cases) {
    const result = cli(options, ["--json", ...args], input);
    assert.equal(result.status, 1, JSON.stringify(args));
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(Object.hasOwn(parsed, "data"), false);
    if (code) assert.equal(parsed.error.code, code);
    assert.equal(existsSync(options.env.CODEX_HOME), false);
  }
  const plain = cli(options, ["orchestrate", "prompt", "--project", "P", " "]);
  assert.equal(plain.stdout, ""); assert.equal(plain.status, 1);
});

test("a saved project prompt creates a bound child prompt after the original source is removed", t => {
  const options = fixture(t), source = path.join(options.cwd, "source");
  mkdirSync(source);
  for (const entry of ["src", "bin", "assets", "scripts", "package.json", "LICENSE"]) cpSync(path.join(REPO, entry), path.join(source, entry), { recursive: true });
  mkdirSync(path.join(source, "node_modules"));
  cpSync(path.join(REPO, "node_modules/ws"), path.join(source, "node_modules/ws"), { recursive: true });
  const generated = spawnSync(process.execPath, [path.join(source, "bin/codexteer.mjs"), "orchestrate", "prompt", "--project", "P", "goal", "--json"], options);
  assert.equal(generated.status, 0, generated.stderr);
  const { data } = JSON.parse(generated.stdout);
  assert.equal(data.cli_mode, "saved");
  assert.deepEqual(data.node, { path: realpathSync(process.execPath), version: process.version });
  assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["runtimes"]);
  assert.ok(existsSync(path.join(data.deployment.directory, "src/orchestrate-prompt.mjs")));
  rmSync(source, { recursive: true });
  const receiving = { ...options, env: { ...options.env, PATH: "/missing-cli", CODEX_HOME: path.join(options.cwd, "other-home") } };
  const versionCommand = data.prompt.split("\n").find(line => line.endsWith(" --version"));
  const version = spawnSync("/bin/sh", ["-c", versionCommand], receiving);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), data.deployment.version);
  const child = spawnSync("/bin/sh", ["-c", childPreparation(data.prompt)], receiving);
  assert.equal(child.status, 0, child.stderr);
  const childData = JSON.parse(child.stdout).data;
  assert.equal(childData.thread_id, ID);
  assert.equal(childData.deployment.directory, data.deployment.directory);
  assert.equal(childData.deployment.reused, true);
  assert.equal(childData.supervisor.owner, "codex");
  assert.ok(childData.prompt.includes(ORCHESTRATED_SUPERVISION_POLICY));
  const bootstrap = childData.prompt.split("\n").find(line => line.includes(` supervise register ${ID} `));
  assert.ok(bootstrap.includes(`--supervisor '${childData.supervisor.session_id}'`));
  const registered = spawnSync("/bin/sh", ["-c", bootstrap], receiving);
  assert.equal(registered.status, 0, registered.stderr);
  const savedCli = path.join(data.deployment.directory, "bin/codexteer.mjs");
  const control = args => spawnSync(process.execPath, [savedCli, "--json", "supervise", ...args, ID], options);
  const status = control(["status"]);
  assert.equal(JSON.parse(status.stdout).data.session_id, childData.supervisor.session_id);
  assert.equal(control(["pause"]).status, 0);
  assert.equal(spawnSync("/bin/sh", ["-c", bootstrap], receiving).status, 0);
  assert.equal(JSON.parse(control(["status"]).stdout).data.state, "paused", "Re-registration must not unpause a child");
  assert.equal(existsSync(receiving.env.CODEX_HOME), false);
});

test("PATH orchestration retains PATH mode when generating the child's managed prompt", t => {
  const options = fixture(t), bin = path.join(options.cwd, "bin");
  const generated = cli(options, ["orchestrate", "prompt", "--project", "P", "goal", "--use-path-cli", "--json"]);
  const { data } = JSON.parse(generated.stdout);
  mkdirSync(bin);
  symlinkSync(BIN, path.join(bin, "codexteer"));
  symlinkSync(process.execPath, path.join(bin, "node"));
  const child = spawnSync("/bin/sh", ["-c", childPreparation(data.prompt)], { ...options, env: { ...options.env, PATH: bin } });
  assert.equal(child.status, 0, child.stderr);
  const childData = JSON.parse(child.stdout).data;
  assert.equal(childData.cli_mode, "path");
  assert.equal(childData.deployment, null); assert.equal(childData.node, null);
  assert.match(childData.prompt, new RegExp(`--supervisor '${childData.supervisor.session_id}' --connection shared`));
  assert.ok(childData.prompt.includes(ORCHESTRATED_SUPERVISION_POLICY));
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("either CLI identity can supervise without changing the model-neutral role division", t => {
  const options = fixture(t), bin = path.join(options.cwd, "bin");
  mkdirSync(bin);
  symlinkSync(BIN, path.join(bin, "codexteer"));
  symlinkSync(process.execPath, path.join(bin, "node"));
  for (const agent of ["claude", "codex"]) {
    const generated = cli(options, ["orchestrate", "prompt", "--project", "P", "goal", "--agent", agent, "--use-path-cli", "--json"]);
    assert.equal(generated.status, 0, generated.stderr);
    const { data } = JSON.parse(generated.stdout);
    assert.equal(data.agent, agent);
    assert.match(data.prompt, /オーケストレーターとCodex担当の役割分担/);
    assert.match(data.prompt, /役割は特定のモデルに依存せず、Codex自身も/);
    assert.doesNotMatch(data.prompt, /あなたはClaude|Claudeの仮説|ClaudeとCodex/);
    const command = childPreparation(data.prompt);
    assert.ok(command.includes(` --agent ${agent} `));
    const child = spawnSync("/bin/sh", ["-c", command], { ...options, env: { ...options.env, PATH: bin } });
    assert.equal(child.status, 0, child.stderr);
    const childData = JSON.parse(child.stdout).data;
    assert.equal(childData.supervisor.owner, agent);
    assert.ok(childData.prompt.includes(`--source ${agent === "claude" ? "claude-code" : "codex"}`));
  }
  assert.equal(existsSync(options.env.CODEX_HOME), false);
});

test("a modified saved runtime is rejected without repair or partial orchestration output", t => {
  const options = fixture(t), args = ["orchestrate", "prompt", "--project", "P", "goal", "--json"];
  const first = cli(options, args);
  assert.equal(first.status, 0, first.stderr);
  const runtime = JSON.parse(first.stdout).data.deployment.directory;
  appendFileSync(path.join(runtime, "src/orchestrate-prompt.mjs"), "\n// altered\n");
  const rejected = cli(options, args);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, "DEPLOYMENT_MODIFIED");
  assert.equal(Object.hasOwn(JSON.parse(rejected.stdout), "data"), false);
});
