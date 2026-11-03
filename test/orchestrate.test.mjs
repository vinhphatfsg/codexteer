import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function childPreparation(prompt, agent = "codex", creationCommand = prompt.split("\n").find(line => line.endsWith(" --version")).slice(0, -" --version".length), thread = ID) {
  const command = prompt.split("\n").find(line => line.includes(" supervise prompt <THREAD-ID> "));
  assert.ok(command, "The workflow must generate an individually bound child prompt");
  return command.replace("<CREATE-COMMAND>", creationCommand).replace("<THREAD-ID>", thread).replace("<AGENT>", agent);
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
  for (const rule of ["prepared-command --connection shared supervise stop <THREAD-ID> --json", "ユーザーの確定要件ではありません"]) assert.ok(data.prompt.includes(rule), rule);
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
  assert.equal(data.cloud_command, "codexteer --connection cloud");
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
  assert.deepEqual(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer")), ["bin", "runtimes"]);
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
  for (const rule of [/--new-turn[^。]*監督方針で再開/, /--new-turnでの再開[^。]*idle/, /監督方針の終了条件/, /監視の終了条件[^。]*全体の完了/]) assert.match(childData.prompt, rule, "The child prompt carries its own resume delegation and end condition");
  const bootstrap = childData.prompt.split("\n").find(line => line.includes(` supervise register ${ID} `));
  assert.match(path.basename(childData.command), /^codexteer-s-[0-9a-f]{12}$/);
  assert.ok(bootstrap.startsWith(`${childData.command} `), "The child observes through its own launcher, not the project one");
  const registered = spawnSync("/bin/sh", ["-c", bootstrap], receiving);
  assert.equal(registered.status, 0, registered.stderr);
  const savedCli = path.join(data.deployment.directory, "bin/codexteer.mjs");
  const control = args => spawnSync(process.execPath, [savedCli, "--json", "supervise", ...args, ID], options);
  const status = control(["status"]);
  assert.equal(JSON.parse(status.stdout).data.session_id, childData.supervisor.session_id);
  assert.equal(control(["pause"]).status, 0);
  assert.equal(spawnSync("/bin/sh", ["-c", bootstrap], receiving).status, 0);
  assert.equal(JSON.parse(control(["status"]).stdout).data.state, "paused", "Re-registration must not unpause a child");
  const stop = data.prompt.split("\n").find(line => line.endsWith(" supervise stop <THREAD-ID> --json")).replace("<CREATE-COMMAND>", data.command).replace("<THREAD-ID>", ID);
  assert.equal(JSON.parse(spawnSync("/bin/sh", ["-c", stop], receiving).stdout).ok, true);
  assert.equal(JSON.parse(control(["status"]).stdout).data.state, "stopped", "The completion step ends the child's supervision");
  const cloud = spawnSync("/bin/sh", ["-c", childPreparation(data.prompt, "codex", data.cloud_command, "task_fixture_orchestrate")], receiving);
  assert.equal(cloud.status, 0, cloud.stderr);
  const cloudData = JSON.parse(cloud.stdout).data;
  assert.equal(cloudData.deployment.directory, data.deployment.directory);
  assert.equal(cloudData.supervisor.connection, "cloud");
  assert.ok(cloudData.prompt.includes(ORCHESTRATED_SUPERVISION_POLICY));
  assert.match(readFileSync(data.cloud_command, "utf8"), /--connection cloud "\$@"/);
  assert.doesNotMatch(readFileSync(data.cloud_command, "utf8"), /--host|--supervisor/);
  assert.equal(existsSync(receiving.env.CODEX_HOME), false);
});

test("paired orchestration stays on its host and never prepares a Cloud command or workflow", t => {
  for (const pathMode of [false, true]) {
    const options = fixture(t);
    const r = cli(options, ["--host", "remote-control:env_fixture", "--remote-transport", "paired", "orchestrate", "prompt", "--project", "P", "goal", ...(pathMode ? ["--use-path-cli"] : []), "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { data } = JSON.parse(r.stdout);
    assert.equal(data.cloud_command, null);
    assert.equal(data.host_id, "remote-control:env_fixture");
    assert.equal(data.remote_transport, "paired");
    assert.doesNotMatch(data.prompt, /Cloud|push済み|<CREATE-COMMAND>|--connection cloud|desktop-cloud|durable_/);
    if (pathMode) {
      assert.match(data.command, /--host 'remote-control:env_fixture' --remote-transport paired/);
      assert.equal(existsSync(options.env.CODEX_HOME), false);
    } else assert.equal(readdirSync(path.join(options.env.CODEX_HOME, "codex-steer/bin")).length, 1);
  }
});

test("Web Cloud operation lines from saved and PATH orchestration are accepted by the CLI without mutations", t => {
  const task = "task_fixture_orchestrate";
  for (const pathMode of [false, true]) {
    const options = fixture(t), bin = path.join(options.cwd, "bin"); mkdirSync(bin);
    symlinkSync(BIN, path.join(bin, "codexteer")); symlinkSync(process.execPath, path.join(bin, "node"));
    const preload = path.join(options.cwd, "cloud-read-only.mjs"), calls = path.join(options.cwd, "calls.jsonl");
    writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async (url, options) => {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url, method:options.method})+'\\n');
  if (options.method !== 'GET' || url !== 'https://chatgpt.com/backend-api/wham/environments') throw Error('Only the environment GET is allowed');
  return new Response(JSON.stringify([{id:'env_fixture',label:'fixture/project',repo_map:{fixture:{repository_full_name:'fixture/project',default_branch:'main'}}}]));
};`);
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    writeFileSync(path.join(bin, "codex"), `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args})+'\\n');
if (args.join(' ')==='app-server --listen stdio://') {
  let pending=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{pending+=chunk;let i;while((i=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{authMethod:'chatgpt',authToken:${JSON.stringify(token)}}}));}});
} else if(args.join(' ')==='cloud --version') console.log('codex-cli-cloud 0.157.1');
else if(args.join(' ')==='cloud diff --help') console.log('Usage: codex cloud diff --attempt N');
else if(args.join(' ')==='cloud diff ${task}') console.log('diff --git a/example b/example');
else { console.error('Unexpected official CLI operation'); process.exitCode=85; }
`, { mode: 0o700 });
    options.env = { ...options.env, PATH: bin, NODE_OPTIONS: `--import=${preload}` };
    const generated = cli(options, ["orchestrate", "prompt", "--project", "P", "goal", ...(pathMode ? ["--use-path-cli"] : []), "--json"]);
    assert.equal(generated.status, 0, generated.stderr);
    const { data } = JSON.parse(generated.stdout);
    assert.equal(data.connection, "shared");
    assert.doesNotMatch(data.prompt, /desktop-cloud|durable_/);
    const sections = Object.fromEntries(data.prompt.split("\n\n").filter(section => /^[567]\. /.test(section)).map(section => [section[0], section]));
    assert.match(sections[5], /Unity Editor.*第6節の条件に従ってWeb Cloud.*resourceリース.*統合後の確認・画面確認/);
    assert.match(sections[6], /占有せず.*並行作業を増やせます/);
    assert.match(sections[6], /ローカル未コミット差分・実機・GUIを必要としない担当はWeb Cloudを優先/);
    assert.match(sections[6], /条件を満たさない場合や作成前に環境がない・照合できない場合はDesktop/);
    assert.match(sections[7], /選んだ作成先の手順だけを実行/);
    assert.ok(sections[7].indexOf(data.cloud_command + " thread create ") < sections[7].indexOf(data.command + " thread create "), "The preferred Cloud path is presented before Desktop");
    assert.match(sections[7], /Cloud環境から取得できるpush済みの作業ブランチ/);
    assert.match(sections[7], /GOALや方針で委任されていれば作業ブランチだけ.*委任がなければユーザーに確認/);
    assert.match(sections[7], /既定ブランチへの直接pushと、ユーザーの未コミット差分を巻き込むpushは禁止/);
    assert.doesNotMatch(data.prompt, /batchmode|EditMode/);
    assert.doesNotMatch(ORCHESTRATED_SUPERVISION_POLICY, /[\r\n\u2028\u2029]/);
    assert.equal(data.prompt.split(ORCHESTRATED_SUPERVISION_POLICY).length - 1, 1, "The child policy is emitted only once");
    const workOrder = path.join(options.cwd, "work-order.txt"); writeFileSync(workOrder, "fixture work order");
    const receiptDir = path.join(options.env.CODEX_HOME, "codex-steer/cloud-creations"); mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(receiptDir, ID + ".json"), JSON.stringify({ schema: 1, attempt_id: ID, creation_status: "not_created", submission_status: "not_sent" }), { mode: 0o600 });
    const execute = command => {
      const r = spawnSync("/bin/sh", ["-c", command], { ...options, timeout: 15000 });
      assert.equal(r.status, 0, `${command}\n${r.stdout}\n${r.stderr}`);
      return JSON.parse(r.stdout).data;
    };
    const lines = data.prompt.split("\n").filter(line => line.startsWith(data.cloud_command + " "));
    assert.equal(lines.length, 3, "Execute every concrete Cloud operation in the orchestration body");
    let environments;
    for (const line of lines) {
      let command = line.replace("<ENV-ID>", "env_fixture").replace("<BRANCH>", "feature/fixture").replace("<ATTEMPT-ID>", ID).replace("<WORK-ORDER-FILE>", workOrder);
      if (line.includes(" thread create ")) command = command.replace(" - --json", " - --json --dry-run");
      const result = execute(command);
      if (line.includes(" projects list ")) environments = result.projects;
      if (line.includes(" thread create ")) {
        assert.equal(result.creation_status, "not_created"); assert.equal(result.submission_status, "not_sent");
        assert.equal(execute(command.replace(" --branch feature/fixture", "")).branch_source, "environment-default");
      }
    }
    assert.equal(environments[0].project_id, "env_fixture");
    const child = execute(childPreparation(data.prompt, "codex", data.cloud_command, task));
    assert.equal(child.cli_mode, data.cli_mode);
    assert.equal(child.supervisor.connection, "cloud");
    assert.equal(child.deployment?.directory, data.deployment?.directory);
    const childLines = child.prompt.split("\n");
    execute(childLines.find(line => line.startsWith(child.command + " supervise register ")) + " --json");
    for (const help of ["monitor", "cloud"]) execute(`${child.command} help ${help} --json`);
    execute(childLines.find(line => line === child.command + " help cloud") + " --json");
    const patch = execute(childLines.find(line => line.startsWith(child.command + " diff ")));
    assert.equal(patch.diff_available, true);
    const stop = data.prompt.split("\n").find(line => line.endsWith(" supervise stop <THREAD-ID> --json"));
    assert.equal(execute(stop.replace("<CREATE-COMMAND>", data.cloud_command).replace("<THREAD-ID>", task)).state, "stopped");
    const recorded = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(recorded.some(row => row.method === "GET"));
    assert.ok(recorded.every(row => row.method === "GET" || row.args?.[0] === "app-server" || row.args?.[1] === "diff" || row.args?.[1] === "--version"), "No create or send was dispatched");
    assert.deepEqual(readdirSync(receiptDir), [ID + ".json"], "Dry-run creates no additional receipt");
  }
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
