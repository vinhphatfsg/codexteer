// Shared Desktop runtime compatibility needs macOS's /private/tmp namespace.
// Portable tarball, prompt and help checks also run in package-content.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, chmod, readFile, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createServer as createControl } from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { preparePackageContent } from "../test-support/package-content.mjs";
const exec = promisify(execFile);
if (process.platform !== "darwin") {
  console.log(JSON.stringify({ suite: "package-runtime", result: "SKIP", reason: "Shared Desktop Unix socket/legacy wrapper compatibility requires macOS /private/tmp; portable package, prompt and help checks run on every OS in test/package-content.test.mjs" }));
} else {
  const fixture = await preparePackageContent();
  let { root, cache, workspace, home, env, ID, TURN, source, sourcePackage, artifact, agentBin,
    savedVersionCommand, deployment, cli, cliPath, claimRuntime, VERSION, PACKAGE_NAME, RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } = fixture;
  let lease, http, control, ws;
  try {
  // A renamed CLI must discover and use a wrapper started under the old name.
  lease = await claimRuntime(home, { codex_steer_package: "@vinhphatfsg/codex-steer", codex_steer_version: "0.14.0", codex_steer_protocol: RUNTIME_PROTOCOL });
  assert.equal(lease.paths.root, `/private/tmp/codex-steer-${process.getuid()}`);
  http = createServer(); ws = new WebSocketServer({ server: http }); let reads = 0, sends = 0;
  ws.on("error", () => {}); // The HTTP listener's error rejects once() below.
  ws.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes); if (!request.id) return;
    let result;
    if (request.method === "initialize") result = {};
    else if (request.method === "thread/read") {
      reads++;
      result = { thread: { id: ID, status: { type: "active" }, turns: [{ id: TURN, status: "inProgress", items: [] }] } };
    } else if (request.method === "turn/steer") {
      sends++; assert.equal(request.params.threadId, ID); assert.equal(request.params.expectedTurnId, TURN); result = { turnId: TURN };
    } else assert.fail(`Unexpected RPC: ${request.method}`);
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  http.listen(lease.paths.socket); await once(http, "listening"); await chmod(lease.paths.socket, 0o600);
  control = createControl(socket => socket.destroy()); control.listen(lease.paths.control); await once(control, "listening"); await chmod(lease.paths.control, 0o600);
  await lease.update({ server_pid: process.pid, desktop_connected: true });
  assert.equal((await cli(["read", ID])).data.thread_id, ID);
  assert.equal((await cli(["send", ID, "synthetic message", "--no-sound"])).data.delivery_status, "accepted");
  assert.equal(sends, 1);
  await lease.update({ codex_steer_package: PACKAGE_NAME });
  for (const version of [null, "0.14.1", "0.15.0", "99.0.0"]) {
    await lease.update({ codex_steer_version: version });
    assert.equal((await cli(["read", ID])).data.thread_id, ID);
    assert.equal((await cli(["send", ID, "synthetic message", "--no-sound"])).data.sent, true);
  }
  assert.equal(sends, 5, "compatible mixed versions must send");
  await lease.update({ codex_steer_capabilities: { ...RUNTIME_CAPABILITIES, desktop_subscribe: [2] } });
  const before = reads;
  const unavailable = await cli(["send", ID, "synthetic", "--new-turn", "--no-sound"], false);
  assert.equal(unavailable.error.code, "CAPABILITY_UNSUPPORTED");
  assert.equal(unavailable.error.capability, "desktop_subscribe");
  assert.equal(reads, before); assert.equal(sends, 5);
  assert.equal((await cli(["read", ID])).data.thread_id, ID);
  assert.equal((await cli(["send", ID, "synthetic message", "--no-sound"])).data.sent, true);
  await lease.update({ codex_steer_protocol: 2 });
  const beforeProtocol = reads;
  for (const args of [["read", ID], ["send", ID, "synthetic", "--no-sound"]]) {
    assert.equal((await cli(args, false)).error.code, "RUNTIME_PROTOCOL_UNSUPPORTED");
  }
  await cli(["help"]); await cli(["supervise", "prompt", ID]); await cli(["history", "list", ID]);
  assert.equal((await cli(["send", ID, "synthetic", "--dry-run"])).data.sent, false);
  assert.equal(reads, beforeProtocol); assert.equal(sends, 6);
  await lease.update({ codex_steer_package: PACKAGE_NAME, codex_steer_version: VERSION, codex_steer_protocol: 1, codex_steer_capabilities: RUNTIME_CAPABILITIES });
  // Normal read/steer must also work with no subscription endpoint at all.
  await new Promise(resolve => control.close(resolve));
  await rm(workspace, { recursive: true }); await rm(cache, { recursive: true, force: true });
  const afterRemoval = await exec("/bin/sh", ["-c", savedVersionCommand], { cwd: root, env: { ...env, PATH: agentBin }, timeout: 10000 });
  assert.equal(afterRemoval.stdout.trim(), VERSION, "The generated command must survive removal of the original/cache");
  fixture.cliPath = cliPath = path.join(deployment.directory, "bin/codexteer.mjs");
  assert.equal((await cli(["--version"])).data.version, VERSION);
  assert.equal((await cli(["read", ID])).data.thread_id, ID);
  assert.equal((await cli(["send", ID, "synthetic after cache removal", "--no-sound"])).data.delivery_status, "accepted");
  assert.equal(sends, 7);
  const savedCommand = savedVersionCommand.slice(0, -" --version".length);
  await exec("/bin/sh", ["-c", `${savedCommand} supervise register ${ID} --owner claude --json`], { cwd: root, env });
  const recipientUser = path.join(root, "recipient-user"); await mkdir(recipientUser);
  for (const receivingHome of [undefined, path.join(root, "different-home")]) {
    const recipientEnv = { ...env, HOME: recipientUser };
    if (receivingHome === undefined) delete recipientEnv.CODEX_HOME;
    else recipientEnv.CODEX_HOME = receivingHome;
    const runSaved = args => exec("/bin/sh", ["-c", `${savedCommand} ${args} --json`], { cwd: recipientUser, env: recipientEnv, timeout: 10000 });
    const observation = JSON.parse((await runSaved(`read ${ID}`)).stdout).data;
    assert.equal(observation.thread_id, ID);
    assert.equal(JSON.parse((await runSaved(`watch ${ID} --timeout-ms 0`)).stdout).data.thread_id, ID);
    const finding = JSON.parse((await runSaved(`findings create ${ID} --key package-${sends} --title 'Package verification' --condition 'The isolated fixture accepts this message' --based-on '${observation.cursor}'`)).stdout).data;
    const sendArgs = `send ${ID} 'synthetic saved supervisor' --finding ${finding.id} --based-on '${observation.cursor}' --no-sound`;
    await cli(["supervise", "pause", ID]);
    await assert.rejects(runSaved(sendArgs), error => JSON.parse(error.stdout).error.code === "SUPERVISOR_PAUSED");
    assert.equal(JSON.parse((await runSaved(`read ${ID}`)).stdout).data.thread_id, ID);
    await cli(["supervise", "resume", ID]);
    const receipt = JSON.parse((await runSaved(sendArgs)).stdout).data;
    assert.equal(receipt.delivery_status, "accepted");
    await assert.rejects(runSaved(sendArgs), error => JSON.parse(error.stdout).error.code === "DUPLICATE_INTERVENTION");
    assert.ok((await cli(["history", "list", ID])).data.some(entry => entry.id === receipt.message_id), "Saved sends must be journaled in the original profile");
    assert.ok(JSON.parse((await runSaved(`history list ${ID}`)).stdout).data.some(entry => entry.id === receipt.message_id));
    assert.equal(await lstat(receivingHome ?? path.join(recipientUser, ".codex")).catch(error => { if (error.code !== "ENOENT") throw error; return null; }), null, "The receiving profile must not be created or written");
  }
  assert.equal(sends, 9);
  await cli(["supervise", "stop", ID]);
  const pkg = JSON.parse(await readFile(path.join(deployment.directory, "package.json")));
  assert.equal(pkg.license, "MIT"); assert.equal(Object.hasOwn(pkg, "private"), false);
  assert.deepEqual(pkg.bin, { "codexteer": "bin/codexteer.mjs" });
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack"]) assert.equal(pkg.scripts[hook], undefined);
  // Cloud must also work from the saved tarball with no real codex on PATH.
  const cloudBin = path.join(root, "cloud-bin"), cloudPreload = path.join(root, "cloud-fixture.mjs"); await mkdir(cloudBin);
  await writeFile(cloudPreload, `globalThis.fetch=async(url,options)=>{if(options.method!=='GET'||url!=='https://chatgpt.com/backend-api/wham/environments')throw new Error('Unexpected cloud request');return new Response(JSON.stringify([{id:'env_package_fixture',label:'fixture/project',repo_map:{fixture:{repository_full_name:'fixture/project',default_branch:'main'}}}]),{status:200});};`);
  await writeFile(path.join(cloudBin, "codex"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0]==='app-server'){
let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{pending+=s;let i;while((i=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{authMethod:'chatgpt',authToken:'fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')+'.fixture'}}));}});
}else{
const input = fs.readFileSync(0, 'utf8');
if (args.includes('--help')) console.log('Usage: codex cloud ' + args[1] + ' --env ENV --branch BRANCH --attempts N --attempt N');
else if (args[1] === '--version') console.log('codex-cli-cloud 0.157.1');
else if (args[1] === 'exec' && input === 'synthetic cloud instruction') console.log('https://chatgpt.com/codex/tasks/task_package_fixture');
else if (args[1] === 'diff') process.stdout.write('+packaged cloud fixture\\n');
else process.exitCode = 2;
}
`, { mode: 0o700 });
  const cloudCli = async args => JSON.parse((await exec(process.execPath, ["--import", cloudPreload, cliPath, ...args, "--json"], { cwd: root, env: { ...env, PATH: cloudBin }, timeout: 10000 })).stdout).data;
  const cloudCreated = await cloudCli(["--connection", "cloud", "thread", "create", "--project", "env_package_fixture", "--branch", "main", "synthetic cloud instruction"]);
  assert.equal(cloudCreated.task_id, "task_package_fixture");
  assert.equal((await cloudCli(["--connection", "cloud", "thread", "receipt", cloudCreated.attempt_id])).task_id, cloudCreated.task_id);
  assert.equal((await cloudCli(["diff", cloudCreated.task_id, "--attempt", "2"])).diff, "+packaged cloud fixture\n");
  const removed = await exec(process.execPath, [cliPath, "cloud", "read", cloudCreated.task_id, "--json"], { cwd: root, env: { ...env, PATH: cloudBin }, timeout: 10000 }).then(() => null, error => error);
  assert.equal(removed.code, 1); assert.equal(JSON.parse(removed.stdout).ok, false);
  console.log(JSON.stringify({ suite: "package", result: "PASS", package: PACKAGE_NAME, version: VERSION, packed_files: artifact.files.length, publish_dry_run: true, offline_install: true, npm_exec: true, npx_supervision: true, copied_prompt: true, cache_update: true, cache_removal: true, mixed_versions: true, feature_isolation: true, real_desktop_validated: false }));
} finally {
  for (const socket of ws?.clients ?? []) socket.terminate();
  if (ws) await new Promise(resolve => ws.close(resolve));
  if (http?.listening) await new Promise(resolve => http.close(resolve));
  if (control?.listening) await new Promise(resolve => control.close(resolve));
  await lease?.release();
  await rm(root, { recursive: true, force: true });
}

}
