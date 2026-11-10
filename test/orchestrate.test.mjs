import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOrchestrationContent } from "../test-support/prompt-contract.mjs";
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

test("orchestration preserves literal goals, uses four operations and has no fixed model duties", () => {
  const goal = "  user goal\n${literal} $(touch never)  ";
  const data = orchestrationPrompt("P", goal, "prepared-command --connection shared", { cloudCommand: "prepared-cloud --connection desktop-cloud" });
  assert.equal(data.goal, goal); assert.ok(data.prompt.includes(goal));
  assertOrchestrationContent(data.prompt);
  for (const operation of ["work start", "project sync", "work tell", "project control"]) assert.ok(data.prompt.includes(operation));
  for (const text of ["CODEXTEER.md", "専門性", "理由と境界", "Unity", "Blender", "GUI", "実機", "確認タスク", "再起動", "unknown", "再公開", "fetch", "main", "高度", "一次資料", "隣接分野", "waitはその担当の変化を監視していません", "waitを静かにする目的でstopしません"]) assert.ok(data.prompt.includes(text), text);
  assert.doesNotMatch(data.prompt, /supervise prompt|--supervisor|--agent|--based-on|findings create|--connection cloud(?:\s|$)|Web Cloud|Codex担当には/);
  assert.doesNotMatch(ORCHESTRATED_SUPERVISION_POLICY, /Codex担当には|Claude|GPT|Gemini|[\r\n]/);
  assert.ok(Buffer.byteLength(data.prompt) < 13000, "compact workflow limits context consumption");
  for (const agent of ["claude", "codex"]) {
    const { prompt } = orchestrationPrompt("P", goal, "prepared-command --connection shared", { agent, cloudCommand: "prepared-cloud --connection desktop-cloud" });
    assert.ok(Buffer.byteLength(prompt) < 13000, `${agent} workflow stays compact`);
  }
});

test("PATH generation is deterministic, offline and retains the Desktop Cloud command", t => {
  const options = fixture(t); options.env.PATH = "/no-cli-on-path";
  const args = ["orchestrate", "prompt", "--project", "P", "goal", "--use-path-cli"];
  const text = cli(options, args), result = cli(options, [...args, "--json"]);
  assert.equal(result.status, 0, result.stderr); const { data } = JSON.parse(result.stdout);
  assert.equal(text.stdout, data.prompt + "\n"); assert.equal(data.cloud_command, "codexteer --connection desktop-cloud");
  assert.equal(data.agent, null); assert.equal(data.deployment, null); assert.equal(data.node, null);
  assert.equal(existsSync(options.env.CODEX_HOME), false); assert.deepEqual(readdirSync(options.cwd), []);
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
    ...["cloud", "desktop-cloud"].map(connection => ({ args: ["--connection", connection, "orchestrate", "prompt", "--project", "P", "goal"], code: "CLOUD_CAPABILITY_UNSUPPORTED" })),
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

test("saved project and Desktop Cloud launchers survive removal of the original source", t => {
  const options = fixture(t), source = path.join(options.cwd, "source"); mkdirSync(source);
  for (const entry of ["src", "bin", "assets", "scripts", "package.json", "LICENSE"]) cpSync(path.join(REPO, entry), path.join(source, entry), { recursive: true });
  mkdirSync(path.join(source, "node_modules")); cpSync(path.join(REPO, "node_modules/ws"), path.join(source, "node_modules/ws"), { recursive: true });
  const result = spawnSync(process.execPath, [path.join(source, "bin/codexteer.mjs"), "orchestrate", "prompt", "--project", "P", "goal", "--json"], options);
  assert.equal(result.status, 0, result.stderr); const { data } = JSON.parse(result.stdout); rmSync(source, { recursive: true });
  for (const command of [data.command, data.cloud_command]) {
    const r = spawnSync("/bin/sh", ["-c", command + " --version"], { ...options, env: { ...options.env, PATH: "/missing", CODEX_HOME: path.join(options.cwd, "other-home") } });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), data.deployment.version);
  }
  assert.match(readFileSync(data.cloud_command, "utf8"), /--connection desktop-cloud/);
  assert.doesNotMatch(data.prompt, /supervise prompt|--connection cloud(?:\s|$)/);
});

test("the project launcher is reused by content, and a modified one is refused without being rewritten", t => {
  const options = fixture(t);
  const generate = () => cli(options, ["orchestrate", "prompt", "--project", "P", "goal", "--json"]);
  const first = JSON.parse(generate().stdout).data, again = JSON.parse(generate().stdout).data;
  assert.match(path.basename(first.command), /^codexteer-p-[0-9a-f]{12}$/);
  assert.equal(again.command, first.command);
  assert.equal(statSync(again.command).ino, statSync(first.command).ino, "Reuse must not replace the file");
  const tampered = readFileSync(first.command, "utf8").replace("--connection shared", "--connection desktop");
  writeFileSync(first.command, tampered);
  const rejected = generate();
  assert.equal(rejected.status, 1);
  const parsed = JSON.parse(rejected.stdout);
  assert.equal(parsed.error.code, "LAUNCHER_MODIFIED"); assert.equal(Object.hasOwn(parsed, "data"), false);
  assert.equal(readFileSync(first.command, "utf8"), tampered);
});

test("paired orchestration never issues unsupported work-start or Cloud examples", t => {
  for (const pathMode of [false, true]) {
    const options = fixture(t), r = cli(options, ["--host", "remote-control:env_fixture", "--remote-transport", "paired", "orchestrate", "prompt", "--project", "P", "goal", ...(pathMode ? ["--use-path-cli"] : []), "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr); const { data } = JSON.parse(r.stdout);
    assert.equal(data.cloud_command, null); assert.equal(data.host_id, "remote-control:env_fixture");
    assert.ok(!data.prompt.split("\n").some(l => l.startsWith(data.command + " work start ")));
    assert.doesNotMatch(data.prompt, /--connection cloud|--connection desktop-cloud/);
  }
});

test("launch identity never imposes worker scope or agent flags on the workflow", t => {
  const options = fixture(t);
  for (const agent of ["claude", "codex"]) {
    const result = cli(options, ["orchestrate", "prompt", "--project", "P", "goal", "--agent", agent, "--use-path-cli", "--json"]);
    assert.equal(result.status, 0, result.stderr); const { data } = JSON.parse(result.stdout);
    assert.equal(data.agent, agent); assert.doesNotMatch(data.prompt, /--agent|Claude|Codex担当には/);
  }
});

test("every saved and PATH prompt command example reaches the real CLI parser without live backend effects", t => {
  for (const pathMode of [false, true]) {
    const options = fixture(t), bin = path.join(options.cwd, "bin"); mkdirSync(bin);
    symlinkSync(BIN, path.join(bin, "codexteer")); symlinkSync(process.execPath, path.join(bin, "node"));
    const result = cli(options, ["orchestrate", "prompt", "--project", "P", "goal", ...(pathMode ? ["--use-path-cli"] : []), "--json"]);
    assert.equal(result.status, 0, result.stderr); const { data } = JSON.parse(result.stdout);
    mkdirSync(options.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const order = path.join(options.cwd, "order.txt"); writeFileSync(order, "fixture instruction");
    const lines = data.prompt.split("\n").filter(l => [data.command, data.cloud_command].some(prefix => prefix && l.startsWith(prefix + " ")));
    assert.ok(lines.length >= 13);
    for (const line of lines) {
      const expanded = line.replace(/<PROJECT>/g, "P").replace(/<CHECKOUT>/g, options.cwd).replace(/<TITLE>/g, "fixture")
        .replace(/<ORDER-FILE>|<INSTRUCTION-FILE>/g, order).replace(/<DURABLE-THREAD>/g, "durable_" + ID)
        .replace(/<THREAD>|<TOKEN>|<EVENT-TOKEN>/g, ID).replace(/<EVENT-OFFSET>|<OFFSET>/g, "0").replace(/<ENVIRONMENT>/g, "fixture-config");
      const bounded = line.includes(" project wait ") ? expanded + " --timeout-ms 0" : expanded;
      const r = spawnSync("/bin/sh", ["-c", bounded], { ...options, env: { ...options.env, PATH: bin, CODEX_THREAD_ID: "" }, timeout: 10000 });
      assert.ok([0, 1].includes(r.status), expanded + "\n" + r.stderr);
      if (line.endsWith(" --version")) { assert.equal(r.status, 0); assert.ok(r.stdout.trim()); continue; }
      const response = JSON.parse(r.stdout);
      if (!response.ok) {
        const expected = new Set(["RUNTIME_UNAVAILABLE", "RUNTIME_NOT_READY", "CLOUD_AUTH_UNAVAILABLE", "WORK_TELL_UNMANAGED", "PROJECT_CONTROL_UNMANAGED", "PROJECT_SYNC_CONTINUATION_NOT_FOUND", "PROJECT_EVENT_NOT_FOUND"]);
        assert.ok(expected.has(response.error?.code), expanded + "\n" + r.stdout);
      }
    }
    assert.equal(existsSync(path.join(options.cwd, "never")), false);
  }
});
