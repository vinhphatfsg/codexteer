// Validate our own tarball only. No public package execution, real Desktop,
// account credentials, paid agents, or real task messages are involved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, chmod, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createServer as createControl } from "node:net";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describeDistribution } from "../src/distribution.mjs";

const exec = promisify(execFile), repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp("/private/tmp/cs-package-");
const cache = path.join(root, "npm-cache"), workspace = path.join(root, "consumer"), home = path.join(root, "codex-home");
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, npm_config_cache: cache, npm_config_userconfig: path.join(root, "empty-npmrc") };
const ID = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222";
let lease, http, control, ws;
try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace);
  const source = await describeDistribution(repo);
  const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, env });
  const [artifact] = JSON.parse(stdout);
  assert.equal(artifact.name, source.manifest.package);
  const required = new Set([...source.manifest.files.map(f => f.path), "README.md", "docs/distribution.md"]);
  for (const file of artifact.files) {
    assert.ok(required.delete(file.path), `Unexpected or duplicate packed file: ${file.path}`);
    if (file.path.startsWith("bin/")) assert.ok(file.mode & 0o100, "packed executable lost its mode");
  }
  assert.deepEqual([...required], [], "Required files are absent from the real tarball");
  const tarball = path.join(root, artifact.filename);
  const executed = await exec("npm", ["exec", "--offline", "--yes", "--package", tarball, "--", "codex-steer", "desktop", "start", "--dry-run", "--json"], { cwd: root, env });
  assert.equal(JSON.parse(executed.stdout).data.started, false);
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", workspace, tarball], { cwd: root, env });
  const installed = path.join(workspace, "node_modules", source.manifest.package);
  const load = name => import(pathToFileURL(path.join(installed, "src", name)).href);
  const { prepareDeployment } = await load("distribution.mjs");
  const { claimRuntime } = await load("runtime.mjs");
  const { VERSION, PACKAGE_NAME, RUNTIME_PROTOCOL } = await load("version.mjs");
  let cliPath = path.join(installed, "bin/codex-steer.mjs");
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
  assert.equal((await cli(["supervise", "prompt", ID])).data.thread_id, ID);
  const deployment = await prepareDeployment(home);
  assert.equal((await lstat(deployment.wrapper_path)).mode & 0o777, 0o700);
  assert.equal(deployment.sha256, source.sha256, "packing changed executable distribution contents");

  lease = await claimRuntime(home, { codex_steer_package: PACKAGE_NAME, codex_steer_version: VERSION, codex_steer_protocol: RUNTIME_PROTOCOL });
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
  const before = reads;
  for (const version of [null, "0.0.0"]) {
    await lease.update({ codex_steer_version: version });
    assert.match((await cli(["read", ID], false)).error.code, /^STEER_VERSION_/);
    assert.match((await cli(["send", ID, "synthetic message", "--no-sound"], false)).error.code, /^STEER_VERSION_/);
  }
  assert.equal(reads, before); assert.equal(sends, 1, "mixed versions must not send");
  await lease.update({ codex_steer_version: VERSION });
  await rm(workspace, { recursive: true }); await rm(cache, { recursive: true, force: true });
  cliPath = path.join(deployment.directory, "bin/codex-steer.mjs");
  assert.equal((await cli(["--version"])).data.version, VERSION);
  assert.equal((await cli(["read", ID])).data.thread_id, ID);
  assert.equal((await cli(["send", ID, "synthetic after cache removal", "--no-sound"])).data.delivery_status, "accepted");
  assert.equal(sends, 2);
  const pkg = JSON.parse(await readFile(path.join(deployment.directory, "package.json")));
  assert.equal(pkg.license, "MIT"); assert.equal(pkg.private, true);
  for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepack"]) assert.equal(pkg.scripts[hook], undefined);
  console.log(JSON.stringify({ suite: "package", result: "PASS", package: PACKAGE_NAME, version: VERSION, packed_files: artifact.files.length, offline_install: true, npm_exec: true, cache_removal: true, version_rejection: true, real_desktop_validated: false }));
} finally {
  for (const socket of ws?.clients ?? []) socket.terminate();
  if (ws) await new Promise(resolve => ws.close(resolve));
  if (http?.listening) await new Promise(resolve => http.close(resolve));
  if (control?.listening) await new Promise(resolve => control.close(resolve));
  await lease?.release();
  await rm(root, { recursive: true, force: true });
}
