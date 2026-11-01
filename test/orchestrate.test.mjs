import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orchestrationPrompt, ORCHESTRATED_SUPERVISION_POLICY } from "../src/orchestrate-prompt.mjs";

const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const REPO = path.dirname(path.dirname(BIN));
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

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

test("orchestration preserves the goal and emits project operations and bound child preparation", () => {
  const goal = "  見える成果\n{{command}} ${goal} $(touch should-not-exist)  ";
  const data = orchestrationPrompt("My Project", goal, "prepared-command --connection shared");
  assert.equal(data.goal, goal);
  assert.equal(data.project_selector, "My Project");
  assert.ok(data.prompt.includes(goal));
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

test("stdin and literal goal arguments retain their exact content", t => {
  const options = fixture(t), goal = "\n最初の目標\n--use-path-cli ${command}\n  ";
  const stdin = cli(options, ["--json", "orchestrate", "prompt", "--project", "P", "--use-path-cli", "-"], goal);
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(JSON.parse(stdin.stdout).data.goal, goal);
  for (const literal of ["--json", "--use-path-cli", "--"]) {
    const result = cli(options, ["--json", "orchestrate", "prompt", "--project", "P", "--use-path-cli", "--", literal]);
    assert.equal(result.status, 0, result.stderr);
    const { data } = JSON.parse(result.stdout);
    assert.equal(data.goal, literal);
  }
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
