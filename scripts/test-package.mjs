// Validate our own tarball only. No public package execution, real Desktop,
// account credentials, paid agents, or real task messages are involved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, chmod, readFile, readdir, lstat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createServer as createControl } from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describeDistribution } from "../src/distribution.mjs";


const withoutSession = text => text.replaceAll(/--supervisor '[0-9a-f-]{36}'/g, "--supervisor '<SESSION>'");

const exec = promisify(execFile), repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp("/private/tmp/cs-package-");
const cache = path.join(root, "npm-cache"), workspace = path.join(root, "consumer"), home = path.join(root, "codex-home");
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, npm_config_cache: cache,
  npm_config_userconfig: path.join(root, "empty-npmrc"), npm_config_globalconfig: path.join(root, "empty-global-npmrc") };
const ID = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222";
let lease, http, control, ws;
try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace);
  const source = await describeDistribution(repo);
  const sourcePackage = JSON.parse(source.contents.get("package.json"));
  assert.equal(sourcePackage.name, "codexteer");
  // npm publish --dry-run skips libnpmpublish's EPRIVATE guard, so check the
  // release metadata explicitly as well as exercising npm's publish preparation.
  assert.equal(Object.hasOwn(sourcePackage, "private"), false, "Release package must not disable publication");
  assert.deepEqual(sourcePackage.bin, { "codexteer": "bin/codexteer.mjs" });
  assert.equal(sourcePackage.publishConfig.access, "public");
  assert.equal(sourcePackage.publishConfig.registry, "https://registry.npmjs.org/");
  const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, env });
  const [artifact] = JSON.parse(stdout);
  assert.equal(artifact.name, source.manifest.package);
  const required = new Set([...source.manifest.files.map(f => f.path), "README.md", "CHANGELOG.md", "docs/distribution.md"]);
  for (const file of artifact.files) {
    assert.ok(required.delete(file.path), `Unexpected or duplicate packed file: ${file.path}`);
    if (file.path.startsWith("bin/")) assert.ok(file.mode & 0o100, "packed executable lost its mode");
  }
  assert.deepEqual([...required], [], "Required files are absent from the real tarball");
  const tarball = path.join(root, artifact.filename);
  // Scrubbed credentials, offline mode, dry-run and an explicit loopback registry
  // keep this check separate from real publication, even on a logged-in machine.
  const preview = await exec("npm", ["publish", "--dry-run", "--offline", "--ignore-scripts", "--json", "--access", "public", "--registry", "http://127.0.0.1:9/"], { cwd: repo, env, timeout: 20000 });
  assert.doesNotMatch(preview.stderr, /auto-corrected|errors corrected|invalid and removed/i, "Publish must not repair or remove release metadata");
  const publishArtifact = JSON.parse(preview.stdout);
  assert.equal(publishArtifact.name, sourcePackage.name);
  assert.equal(publishArtifact.version, sourcePackage.version);
  assert.equal(publishArtifact.shasum, artifact.shasum, "Publish preparation must pack the tested artifact");
  const executed = await exec("npm", ["exec", "--offline", "--yes", "--package", tarball, "--", "codexteer", "desktop", "start", "--dry-run", "--json"], { cwd: root, env });
  assert.equal(JSON.parse(executed.stdout).data.started, false);

  // npx must pass a prompt bound to a saved copy of its tarball, even if another CLI
  // is on PATH. The fake agent executes only the prompt's read-only version check.
  const agentBin = path.join(root, "agent-bin"); await mkdir(agentBin);
  await symlink(process.execPath, path.join(agentBin, "node"));
  await writeFile(path.join(agentBin, "codexteer"), '#!/bin/sh\necho wrong-cli >&2\nexit 91\n', { mode: 0o755 });
  await writeFile(path.join(agentBin, "claude"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const prompt = process.argv.at(-1);
const command = prompt.split("\\n").find(line => line.endsWith(" --version"));
if (!command) throw new Error("Missing bound version check");
const result = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, PATH: "/no-supervisor-cli-on-path" }, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
console.log(JSON.stringify({ prompt, version: result.stdout.trim() }));
`, { mode: 0o755 });
  const npxEnv = { ...env, PATH: `${agentBin}:${env.PATH}` };
  await symlink(path.join(agentBin, "claude"), path.join(agentBin, "codex"));
  const npxArgs = ["--offline", "--yes", "--ignore-scripts", `file:${tarball}`];
  const agent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, "--agent", "claude"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(agent.version, sourcePackage.version);
  const codexAgent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, "--agent", "codex"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(codexAgent.version, sourcePackage.version);
  assert.match(codexAgent.prompt, /--owner codex/);
  assert.ok(agent.prompt.includes(`${home}/codex-steer/runtimes/${source.id}/`), "The agent must receive a content-addressed saved path");
  assert.equal(agent.prompt.includes(`${cache}/_npx/`), false, "The agent must not depend on the mutable npx cache");
  assert.equal(agent.prompt.includes(repo), false, "The packaged prompt must not bind to the development checkout");
  const copiedPrompt = JSON.parse((await exec("npx", [...npxArgs, "supervise", "prompt", ID, "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout).data.prompt;
  assert.equal(withoutSession(copiedPrompt), withoutSession(agent.prompt), "Direct launch and copy/paste must use the same invocation");
  const policy = '  セキュリティの問題だけを報告し、Codexへは送信しないでください。\n"quotes" $(touch INJECTED) `touch INJECTED_TOO` {{threadId}}  ';
  const customAgent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, policy], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  const customPrompt = JSON.parse((await exec("npx", [...npxArgs, "supervise", "prompt", ID, policy, "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout).data;
  assert.equal(customAgent.version, sourcePackage.version);
  assert.equal(withoutSession(customAgent.prompt), withoutSession(customPrompt.prompt), "Both npx forms must compose the same custom policy, with Claude as the default agent");
  assert.ok(customPrompt.prompt.endsWith(`\n\n■ 監督方針\n${policy}`), "Custom text must be preserved as literal policy text");
  assert.equal(withoutSession(customPrompt.prompt.split("\n\n■ 監督方針\n")[0]), withoutSession(copiedPrompt.split("\n\n■ 監督方針\n")[0]), "A custom policy must retain the mandatory template");
  assert.doesNotMatch(customPrompt.prompt, /不要な抽象化・汎用化|変化のない定期報告は控え/);
  assert.equal(customPrompt.deployment.sha256, source.sha256);
  assert.equal(customPrompt.deployment.reused, true);
  const consumerFiles = await readdir(root);
  assert.equal(consumerFiles.includes("INJECTED"), false);
  assert.equal(consumerFiles.includes("INJECTED_TOO"), false);
  const savedVersionCommand = copiedPrompt.split("\n").find(line => line.endsWith(" --version"));
  // Simulate a later npx run replacing the same cached package with another version.
  let updatedPackages = 0;
  for (const entry of await readdir(path.join(cache, "_npx"))) {
    const pkgPath = path.join(cache, "_npx", entry, "node_modules", sourcePackage.name, "package.json");
    const text = await readFile(pkgPath, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (text) {
      await writeFile(pkgPath, JSON.stringify({ ...JSON.parse(text), version: "99.0.0" }));
      updatedPackages++;
    }
  }
  assert.ok(updatedPackages > 0, "The fixture must replace the actual npx package before checking the saved CLI");
  const pasted = await exec("/bin/sh", ["-c", savedVersionCommand], { cwd: root, env: { ...env, PATH: agentBin }, timeout: 10000 });
  assert.equal(pasted.stdout.trim(), sourcePackage.version);
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", workspace, tarball], { cwd: root, env });
  const installed = path.join(workspace, "node_modules", source.manifest.package);
  const load = name => import(pathToFileURL(path.join(installed, "src", name)).href);
  const { prepareDeployment } = await load("distribution.mjs");
  const { claimRuntime } = await load("runtime.mjs");
  const { VERSION, PACKAGE_NAME } = await load("version.mjs");
  const { RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } = await load("compatibility.mjs");
  let cliPath = path.join(installed, "bin/codexteer.mjs");
  async function cli(args, ok = true) {
    let result;
    try { result = await exec(process.execPath, [cliPath, ...args, "--json"], { cwd: root, env, timeout: 10000 }); }
    catch (error) { if (ok) throw error; result = error; }
    const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, ok); return parsed;
  }
  assert.equal((await cli(["--version"])).data.version, VERSION);
  await cli(["help"]);
  assert.equal((await cli(["desktop", "start", "--dry-run"])).data.started, false);
  assert.equal((await cli(["send", ID, "synthetic message", "--dry-run"])).data.sent, false);
  const localPrompt = (await cli(["supervise", "prompt", ID])).data;
  assert.equal(localPrompt.thread_id, ID);
  assert.equal(withoutSession(localPrompt.prompt), withoutSession(copiedPrompt), "Identical local and npx distributions must render the same saved invocation");
  assert.equal(localPrompt.deployment.sha256, source.sha256);
  assert.equal(localPrompt.prompt.includes(`${cache}/_npx/`), false);
  const localCustomPrompt = (await cli(["supervise", "prompt", ID, policy])).data;
  assert.equal(withoutSession(localCustomPrompt.prompt), withoutSession(customPrompt.prompt), "Custom policies must also agree across local and npx installations");
  assert.equal(localCustomPrompt.deployment.directory, localPrompt.deployment.directory);
  const deployment = await prepareDeployment(home);
  assert.equal((await lstat(deployment.wrapper_path)).mode & 0o777, 0o700);
  assert.equal(deployment.sha256, source.sha256, "packing changed executable distribution contents");

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
  cliPath = path.join(deployment.directory, "bin/codexteer.mjs");
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
  console.log(JSON.stringify({ suite: "package", result: "PASS", package: PACKAGE_NAME, version: VERSION, packed_files: artifact.files.length, publish_dry_run: true, offline_install: true, npm_exec: true, npx_supervision: true, copied_prompt: true, cache_update: true, cache_removal: true, mixed_versions: true, feature_isolation: true, real_desktop_validated: false }));
} finally {
  for (const socket of ws?.clients ?? []) socket.terminate();
  if (ws) await new Promise(resolve => ws.close(resolve));
  if (http?.listening) await new Promise(resolve => http.close(resolve));
  if (control?.listening) await new Promise(resolve => control.close(resolve));
  await lease?.release();
  await rm(root, { recursive: true, force: true });
}
