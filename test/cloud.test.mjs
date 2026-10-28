import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { cloudRoutingError, cloudTaskId, createCloudTask, cloudTaskStatus, cloudTaskDiff, runCloudCli } from "../src/cloud.mjs";

function exec(file, args, { input = "", ...settings } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15000, ...settings }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
const ID = "task_fixture_001", URL = `https://chatgpt.com/codex/tasks/${ID}`;
const help = action => `Usage: codex cloud ${action} --env ENV_ID --branch BRANCH --attempts N --attempt N`;

test("cloud routing rejects Desktop host options before they can be consumed", () => {
  for (const prefix of [[], ["--json"], ["--connection", "shared"]]) {
    assert.equal(cloudRoutingError([...prefix, "--host", "local", "cloud", "status", ID]).code, "CLOUD_TARGET_CONFLICT");
    assert.equal(cloudRoutingError([...prefix, "cloud", "status", ID, "--remote-transport", "native"]).code, "CLOUD_TARGET_CONFLICT");
    assert.equal(cloudRoutingError([...prefix, "--context-thread", "fixture", "cloud", "create"]).code, "CLOUD_TARGET_CONFLICT");
  }
  assert.equal(cloudRoutingError(["--host", "remote-control:env_fixture", "send", "fixture", "cloud"]), null);
  assert.equal(cloudRoutingError(["cloud", "create", "--", "--host"]), null);
});
function fixtureRun(result) {
  const calls = [], run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "--version") return { started: true, exitCode: 0, stdout: "codex-cli-cloud 0.157.1\n" };
    return { started: true, exitCode: 0, stdout: args.includes("--help") ? help(args[0]) : "", ...(args.includes("--help") ? {} : result) };
  };
  return { calls, run };
}

test("cloud destinations accept only cloud task IDs and official links", () => {
  for (const target of [ID, URL, `${URL}?view=diff#top`]) assert.equal(cloudTaskId(target), ID);
  for (const target of ["aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "-c", "https://example.com/codex/tasks/task_fixture_001",
    "https://chatgpt.com.evil.invalid/codex/tasks/task_fixture_001", "http://chatgpt.com/codex/tasks/task_fixture_001",
    "https://user@chatgpt.com/codex/tasks/task_fixture_001", `${URL}/extra`, `${URL}%2fextra`, "codex://threads/task_fixture_001"]) assert.throws(() => cloudTaskId(target));
});

test("creation transmits the exact prompt once through stdin and stores only its digest", async () => {
  const f = fixtureRun({ stdout: `${URL}\n` }), writes = [], prompt = "日本語\n--json $(no-shell) `literal`";
  const receipt = await createCloudTask("env_fixture", "feature/cloud", prompt, {}, { run: f.run, write: async (...args) => writes.push(args) });
  assert.equal(receipt.task_id, ID); assert.equal(receipt.creation_status, "created"); assert.equal(receipt.submission_status, "accepted");
  const dispatch = f.calls.filter(c => c.args[0] === "exec" && !c.args.includes("--help"));
  assert.equal(dispatch.length, 1); assert.deepEqual(dispatch[0].args, ["exec", "--env", "env_fixture", "--branch", "feature/cloud", "--attempts", "1", "-"]);
  assert.equal(dispatch[0].options.input, prompt);
  assert(!JSON.stringify(writes).includes("no-shell")); assert(!JSON.stringify(receipt).includes("no-shell"));
  assert.equal(writes[1][2].creation_status, "dispatching"); assert.equal(writes.at(-1)[2].creation_status, "created");
});

test("dry run and invalid options never invoke any CLI or write receipts", async () => {
  let calls = 0; const dependencies = { run: async () => calls++, write: async () => calls++ };
  const dry = await createCloudTask("env_fixture", "main", "fixture", { dryRun: true }, dependencies);
  assert.equal(dry.creation_status, "not_created"); assert.equal(dry.receipt_path, undefined);
  for (const [env, branch, prompt, settings] of [[undefined, "main", "fixture"], ["env fixture", "main", "fixture"], ["env_fixture", undefined, "fixture"],
    ["env_fixture", "--config", "fixture"], ["env_fixture", "a..b", "fixture"], ["env_fixture", "main", ""], ["env_fixture", "main", "x\0y"],
    ["env_fixture", "main", "fixture", { timeoutMs: 0 }]]) await assert.rejects(createCloudTask(env, branch, prompt, settings, dependencies));
  assert.equal(calls, 0);
});

test("CLI preflight fails closed before creating a task", async () => {
  for (const result of [{ started: false, launchError: "ENOENT" }, { started: true, exitCode: 1, stdout: "private diagnostic" },
    { started: true, exitCode: 0, stdout: "Changed command interface" }]) {
    let calls = 0, writes = 0;
    await assert.rejects(createCloudTask("env_fixture", "main", "fixture", {}, { run: async () => { calls++; return result; }, write: async () => writes++ }));
    assert.equal(calls, 1); assert.equal(writes, 0);
  }
});

test("unverified old CLI stdin contracts are refused before submission", async () => {
  for (const version of ["codex-cli-cloud 0.156.0", "codex-cli-cloud 0.157.0", "unknown version"]) {
    let dispatches = 0, writes = 0;
    await assert.rejects(createCloudTask("env_fixture", "main", "fixture", {}, {
      run: async args => {
        if (args.includes("--help")) return { started: true, exitCode: 0, stdout: help("exec") };
        if (args[0] === "--version") return { started: true, exitCode: 0, stdout: version };
        dispatches++;
      }, write: async () => writes++,
    }), { code: "CLOUD_CLI_UNSUPPORTED" });
    assert.equal(dispatches, 0); assert.equal(writes, 0);
  }
});

test("submission failures and malformed acknowledgements remain unknown and are never retried", async () => {
  for (const result of [{ exitCode: 1, stdout: "private diagnostic" }, { exitCode: 0, stdout: `${URL}\n${URL}` },
    { timedOut: true, exitCode: null, signal: "SIGTERM" }, { overflow: true, exitCode: null }, { stdout: "new response format" },
    { stdout: ID }, { stdout: URL.replace("task_", "ta\nsk_") }, { exitCode: 1, stdout: URL }]) {
    const f = fixtureRun(result), writes = [];
    const error = await createCloudTask("env_fixture", "main", "private prompt", {}, { run: f.run, write: async (...a) => writes.push(a) }).then(() => null, e => e);
    assert(error); assert.equal(error.uncertain, true); assert.equal(error.submission_status, "unknown");
    assert.equal(error.creation_status, result.stdout === URL ? "created" : "unknown");
    assert(!JSON.stringify(error).includes("private")); assert.equal(f.calls.length, 3); assert.equal(writes.at(-1)[2].submission_status, "unknown");
  }
});

test("a failed launch after preflight is not-created and accepted receipts survive a save failure", async () => {
  const f = fixtureRun({ started: false, launchError: "ENOENT" });
  await assert.rejects(createCloudTask("env_fixture", "main", "fixture", {}, { run: f.run, write: async () => {} }), e => e.creation_status === "not_created" && !e.uncertain);
  const g = fixtureRun({ stdout: URL }); let count = 0;
  const receipt = await createCloudTask("env_fixture", "main", "fixture", {}, { run: g.run, write: async () => { if (++count === 3) throw new Error("disk"); } });
  assert.equal(receipt.creation_status, "created"); assert.equal(receipt.task_id, ID); assert.equal(receipt.receipt_update_required, true); assert.equal(g.calls.length, 3);
});

test("status distinguishes a successful query from pending, applied, and failed tasks", async () => {
  for (const state of ["PENDING", "READY", "APPLIED", "ERROR"]) {
    const f = fixtureRun({ stdout: `[${state}] fixture\n+1/-0 • 1 file\n`, exitCode: state === "READY" ? 0 : 1 });
    const data = await cloudTaskStatus(URL, {}, { run: f.run });
    assert.equal(data.status, state.toLowerCase()); assert.equal(data.task_id, ID); assert.deepEqual(f.calls[2].args, ["status", ID]);
  }
  for (const result of [{ stdout: "Error: private diagnostic", exitCode: 1 }, { stdout: "[READY] fixture", exitCode: 1 }, { stdout: "[PENDING] fixture", exitCode: 0 }, { stdout: "[NEW_STATE] fixture", exitCode: 0 }]) {
    const f = fixtureRun(result); await assert.rejects(cloudTaskStatus(ID, {}, { run: f.run }), { code: "CLOUD_PROTOCOL_UNVERIFIED" });
  }
});

test("diff preserves bytes, selects attempts explicitly, and never applies changes", async () => {
  const diff = "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -0,0 +1 @@\n+日本語\n";
  for (const attempt of [undefined, 1, 4]) {
    const f = fixtureRun({ stdout: diff }), data = await cloudTaskDiff(ID, { attempt }, { run: f.run });
    assert.equal(data.diff, diff); assert.equal(data.attempt, attempt ?? null);
    assert.deepEqual(f.calls[2].args, ["diff", ID, ...(attempt === undefined ? [] : ["--attempt", String(attempt)])]);
  }
  for (const attempt of [0, 5, 1.5, "1"]) await assert.rejects(cloudTaskDiff(ID, { attempt }));
});

test("diff distinguishes a finished task without a server patch from no working-copy changes", async () => {
  const f = fixtureRun({ exitCode: 1, stdout: "" });
  const request = async () => ({ task: { id: ID }, current_diff_task_turn: null, current_assistant_turn: { role: "assistant", turn_status: "completed", output_items: [{ type: "message" }] } });
  const result = await cloudTaskDiff(ID, {}, { run: f.run, request });
  assert.equal(result.diff, null); assert.equal(result.diff_available, false); assert.equal(result.local_changes, "unknown");
  await assert.rejects(cloudTaskDiff(ID, {}, { run: f.run, request: async () => ({ task: { id: "task_other" } }) }), { code: "CLOUD_CLI_FAILED" });
  await assert.rejects(cloudTaskDiff(ID, { attempt: 1 }, { run: f.run, request: () => { throw new Error("must not infer another attempt"); } }), { code: "CLOUD_CLI_FAILED" });
});

async function fakeCli(t) {
  const root = await mkdtemp("/private/tmp/codexteer-cloud-test-"); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), home = path.join(root, "home"), log = path.join(root, "calls.jsonl");
  await mkdir(bin); await mkdir(home, { mode: 0o700 });
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args,input,cwd:process.cwd(),startingDiff:process.env.CODEX_STARTING_DIFF}) + '\\n');
fs.writeFileSync('error.log', 'private fixture diagnostic');
if (args.includes('--help')) { console.log('Usage: codex cloud ' + args[1] + ' --env ENV --branch BRANCH --attempts N --attempt N'); }
else if (args[1] === '--version') { console.log('codex-cli-cloud 0.157.1'); }
else if (args[1] === 'exec') {
  const failure = process.env.FIXTURE_ERROR_MODE;
  if (!failure || failure.startsWith('confirmed')) console.log('${URL}');
  if (failure === 'confirmed-receipt-failure') {
    const bucket = process.env.CODEX_HOME + '/codex-steer/cloud-creations';
    fs.renameSync(bucket, bucket + '.saved');
    fs.writeFileSync(bucket, 'blocked fixture', {mode:0o600});
  }
  if (failure) { console.error('private fixture diagnostic'); process.exitCode = 1; }
}
else if (args[1] === 'status') { console.log('[PENDING] fixture'); process.exitCode = 1; }
else if (args[1] === 'diff') { process.stdout.write('+日本語\\n'); }
else { process.exitCode = 2; }
`;
  await writeFile(path.join(bin, "codex"), script, { mode: 0o700 });
  return { root, home, log, env: { ...process.env, PATH: bin, HOME: home, CODEX_HOME: home, FIXTURE_LOG: log } };
}

test("CLI roundtrip uses a fake executable with isolated HOME and retrieves private receipts", async t => {
  const f = await fakeCli(t), invoke = async (args, input) => JSON.parse((await exec(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { env: f.env, input })).stdout);
  f.env.CODEX_STARTING_DIFF = "private fixture starting diff";
  const created = await invoke(["cloud", "create", "--env", "env_fixture", "--branch", "main", "-"], "日本語\n$(literal)");
  assert.equal(created.command, "cloud.create"); assert.equal(created.data.task_id, ID);
  const saved = JSON.parse(await readFile(created.data.receipt_path)); assert.equal(saved.task_id, ID); assert.equal((await stat(created.data.receipt_path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(created.data.receipt_path))).mode & 0o777, 0o700);
  assert.equal((await invoke(["cloud", "receipt", created.data.attempt_id])).data.task_id, ID);
  assert.equal((await invoke(["cloud", "status", URL])).data.status, "pending");
  assert.equal((await invoke(["cloud", "diff", ID, "--attempt", "2"])).data.diff, "+日本語\n");
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(s => JSON.parse(s));
  assert.equal(calls.filter(c => c.args[1] === "exec" && !c.args.includes("--help")).length, 1);
  const dispatch = calls.find(c => c.args[1] === "exec" && !c.args.includes("--help"));
  assert.notEqual(dispatch.cwd, process.cwd()); assert.equal(dispatch.startingDiff, undefined);
  await assert.rejects(stat(dispatch.cwd), { code: "ENOENT" });
  assert.equal(dispatch.input, "日本語\n$(literal)"); assert(!JSON.stringify(dispatch.args).includes("literal"));
  const before = calls.length;
  for (const args of [["cloud", "create", "--env", "env_fixture", "--branch", "main", "--dry-run", "fixture"], ["cloud", "--help"]]) await invoke(args);
  assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, before);
});

test("Desktop-bound, remote, duplicate, and unsupported cloud options fail before subprocess access", async t => {
  const f = await fakeCli(t);
  for (const args of [["--supervisor", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "cloud", "status", ID], ["--connection", "desktop", "cloud", "status", ID],
    ["--host", "remote-control:env_fixture", "cloud", "status", ID], ["--host", "local", "cloud", "status", ID], ["cloud", "status", ID, "--host", "local"], ["cloud", "apply", ID],
    ["cloud", "create", "--env", "env_fixture", "--env", "other", "--branch", "main", "fixture"], ["cloud", "create", "--env", "env_fixture", "fixture"],
    ["cloud", "diff", ID, "--attempt", "0"], ["cloud", "status", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"]]) {
    const result = await exec(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { env: f.env }).then(() => null, e => e);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).ok, false);
  }
  await assert.rejects(readFile(f.log), { code: "ENOENT" });
});

test("JSON and human submission errors retain recovery IDs even if the final receipt cannot be saved", async t => {
  for (const mode of ["unknown", "confirmed", "confirmed-receipt-failure"]) for (const json of [false, true]) {
    const f = await fakeCli(t);
    const result = await exec(process.execPath, ["bin/codexteer.mjs", ...(json ? ["--json"] : []), "cloud", "create", "--env", "env_fixture", "--branch", "main", "hidden fixture instruction"],
      { env: { ...f.env, FIXTURE_ERROR_MODE: mode } }).then(() => null, error => error);
    assert.equal(result.code, 1);
    assert(!result.stderr.includes("hidden fixture instruction")); assert(!result.stderr.includes("private fixture diagnostic"));
    if (json) {
      const error = JSON.parse(result.stdout).error;
      assert.match(error.attempt_id, /^[0-9a-f-]{36}$/); assert.equal(typeof error.receipt_path, "string");
      assert.equal(error.task_id, mode.startsWith("confirmed") ? ID : undefined);
      assert.equal(error.receipt_update_required, mode.endsWith("receipt-failure") ? true : undefined);
    } else {
      assert.equal(result.stdout, ""); assert.match(result.stderr, /attempt_id: "[0-9a-f-]{36}"/);
      assert(result.stderr.includes(`receipt_path: "${f.home}/codex-steer/cloud-creations/`));
      if (mode.startsWith("confirmed")) { assert(result.stderr.includes(`task_id: "${ID}"`)); assert(result.stderr.includes(`url: "${URL}"`)); }
      if (mode.endsWith("receipt-failure")) assert(result.stderr.includes("receipt_update_required: true"));
    }
    const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.args[1] === "exec" && !call.args.includes("--help")).length, 1);
  }
});

test("real subprocess adapter handles UTF-8, timeout, output bounds, and missing CLI without diagnostics", async t => {
  // Exercise only a fake process. No login, Desktop, or network access.
  const f = await fakeCli(t), original = { PATH: process.env.PATH, FIXTURE_LOG: process.env.FIXTURE_LOG };
  process.env.PATH = f.env.PATH; process.env.FIXTURE_LOG = f.log;
  t.after(() => { process.env.PATH = original.PATH; if (original.FIXTURE_LOG === undefined) delete process.env.FIXTURE_LOG; else process.env.FIXTURE_LOG = original.FIXTURE_LOG; });
  assert.equal((await runCloudCli(["diff", ID])).stdout, "+日本語\n");
  assert.equal((await runCloudCli(["diff", ID], { maxBytes: 1 })).overflow, true);
  await writeFile(path.join(f.env.PATH, "codex"), `#!${process.execPath}\nconst bytes=Buffer.from('+日本語\\n'); process.stdout.write(bytes.subarray(0,2)); setTimeout(()=>process.stdout.write(bytes.subarray(2)),10);\n`, { mode: 0o700 });
  assert.equal((await runCloudCli(["diff", ID])).stdout, "+日本語\n");
  await writeFile(path.join(f.env.PATH, "codex"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  assert.equal((await runCloudCli(["status", ID], { timeoutMs: 30 })).timedOut, true);
  process.env.PATH = path.join(f.root, "missing");
  const missing = await runCloudCli(["status", ID]); assert.equal(missing.started, false); assert.equal(missing.launchError, "ENOENT");
});
