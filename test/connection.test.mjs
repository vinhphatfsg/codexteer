import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, chmod, symlink, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { discoverDesktopRuntime, connectDesktop, observationConnection } from "../src/connection.mjs";
import { observeThread } from "../src/observe.mjs";
import { appServerDoctor } from "../src/launcher.mjs";
import { streamThread } from "../src/monitor.mjs";

const ID = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url)), exec = promisify(execFile);
const thread = { id: ID, status: { type: "idle" }, turns: [] };
async function fixture(t, answer = () => undefined) {
  const home = await mkdtemp("/private/tmp/ct-native-"), directory = `${home}/app-server-control`, socket = `${directory}/app-server-control.sock`;
  await mkdir(directory, { mode: 0o700 });
  const http = createServer(), ws = new WebSocketServer({ server: http }), calls = [];
  ws.on("connection", peer => peer.on("message", async bytes => {
    const request = JSON.parse(bytes); if (!request.id) return;
    calls.push(request);
    const result = await answer(request) ?? (request.method === "initialize" ? {} : request.method === "thread/loaded/list" ? { data: [ID], nextCursor: null } : request.method === "thread/read" ? { thread } : undefined);
    if (result === undefined) peer.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unavailable" } }));
    else peer.send(JSON.stringify({ id: request.id, result }));
  }));
  http.listen(socket); await once(http, "listening"); await chmod(socket, 0o600);
  t.after(async () => {
    for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const dependencies = () => {
    const connection = observationConnection("desktop");
    return { ...connection, discover: () => connection.discover(home) };
  };
  async function cli(args, ok = true) {
    let result;
    try { result = await exec(process.execPath, [BIN, "--connection", "desktop", ...args, "--json"], { env: { ...process.env, CODEX_HOME: home }, timeout: 10000 }); }
    catch (error) { if (ok) throw error; result = error; }
    const data = JSON.parse(result.stdout); assert.equal(data.ok, ok); return data;
  }
  return { home, directory, socket, calls, dependencies, cli };
}

test("the existing private Unix endpoint supports read/watch/doctor without claiming mutation support", async t => {
  const f = await fixture(t);
  const observed = await observeThread(ID, {}, f.dependencies());
  assert.equal(observed.thread_id, ID);
  const watched = await observeThread(ID, { watch: true, timeoutMs: 0 }, f.dependencies());
  assert.equal(watched.timed_out, true);
  const report = await appServerDoctor({ threadId: ID, versions: { cli_version: "test", desktop_version: "test" }, ...f.dependencies() });
  assert.equal(report.ready, true); assert.equal(report.compatibility.status, "verified");
  assert.equal(report.connection.observation_only, true);
  assert.equal(report.checks.bundled_wrapper_node, undefined);
  assert.equal(report.runtime_compatibility.operations.send.status, "unsupported");
  assert.equal(report.runtime_compatibility.operations.send_new_turn.status, "unsupported");
  assert.deepEqual(report.compatibility.unverified_features, ["steering", "desktop_ui", "approval_roundtrip"]);
  const controller = new AbortController(), events = [];
  await streamThread(ID, { signal: controller.signal }, data => { events.push(data); controller.abort(); }, f.dependencies());
  assert.equal(events[0].state, "watching");
  assert.ok(f.calls.every(call => ["initialize", "thread/loaded/list", "thread/read"].includes(call.method)));
});

test("an unloaded target is not read or implicitly resumed; paginated loaded lists are checked", async t => {
  let loaded = false;
  const f = await fixture(t, request => request.method === "thread/loaded/list" ? (request.params.cursor ? { data: loaded ? [ID] : [], nextCursor: null } : { data: [OTHER], nextCursor: "next" }) : undefined);
  await assert.rejects(observeThread(ID, {}, f.dependencies()), { code: "DESKTOP_THREAD_NOT_LOADED" });
  assert.equal(f.calls.some(call => call.method === "thread/read"), false);
  loaded = true;
  assert.equal((await observeThread(ID, {}, f.dependencies())).thread_id, ID);
  assert.ok(f.calls.some(call => call.params.cursor === "next"));
});

test("client allowlist rejects mutations and arbitrary APIs before sending them", async t => {
  const f = await fixture(t), runtime = await discoverDesktopRuntime(f.home), client = await connectDesktop(runtime.paths);
  t.after(() => client.close());
  for (const method of ["turn/steer", "turn/start", "thread/resume", "config/write", "unknown"]) {
    await assert.rejects(client.request(method, { threadId: ID }), { code: "DESKTOP_READ_ONLY" });
  }
  await assert.rejects(client.request("thread/read", { threadId: ID }, { mutation: true }), { code: "DESKTOP_READ_ONLY" });
  assert.deepEqual(f.calls.map(call => call.method), ["initialize"]);
});

test("missing, permissive and symlinked endpoints fail without starting or repairing anything", async t => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(discoverDesktopRuntime(f.home), { code: "DESKTOP_CONNECTION_UNSAFE" });
  await chmod(f.directory, 0o700); await chmod(f.socket, 0o666);
  await assert.rejects(discoverDesktopRuntime(f.home), { code: "DESKTOP_CONNECTION_UNSAFE" });
  await rm(f.socket); await symlink("/tmp/nonexistent-codexteer-test", f.socket);
  await assert.rejects(discoverDesktopRuntime(f.home), { code: "DESKTOP_CONNECTION_UNSAFE" });
  await rm(f.socket);
  await assert.rejects(discoverDesktopRuntime(f.home), { code: "DESKTOP_CONNECTION_UNAVAILABLE" });
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.calls, []);
});

test("endpoint removal during a read discards its result and never switches endpoints", async t => {
  let f;
  f = await fixture(t, async request => {
    if (request.method === "thread/read") { await rm(f.socket); return { thread }; }
  });
  await assert.rejects(observeThread(ID, {}, f.dependencies()), { code: "DESKTOP_CONNECTION_CHANGED" });
  assert.equal(f.calls.filter(call => call.method === "thread/read").length, 1);
});

test("reconnect discovery cannot silently adopt a replacement private endpoint", async t => {
  const f = await fixture(t), connection = observationConnection("desktop");
  await connection.discover(f.home);
  await rm(f.socket);
  const replacement = createServer();
  t.after(() => new Promise(resolve => replacement.close(resolve)));
  replacement.listen(f.socket); await once(replacement, "listening"); await chmod(f.socket, 0o600);
  await assert.rejects(connection.discover(f.home), { code: "DESKTOP_CONNECTION_CHANGED" });
  assert.deepEqual(f.calls, []);
});

test("native pagination probes report unsupported methods consistently", async t => {
  const f = await fixture(t, request => request.method === "thread/read" ? { thread: { ...thread, historyMode: "paginated" } } : undefined);
  const report = await appServerDoctor({ threadId: ID, versions: { cli_version: "test", desktop_version: "test" }, ...f.dependencies() });
  assert.equal(report.ready, false);
  assert.equal(report.compatibility.status, "unsupported");
  assert.equal(report.runtime_compatibility.features.history_pagination.status, "unsupported");
});

test("CLI binds copied observation prompts to the selected endpoint and rejects every send path", async t => {
  const f = await fixture(t);
  const data = (await f.cli(["supervise", "prompt", ID, "--agent", "codex"])).data;
  assert.equal(data.supervisor.connection, "desktop");
  assert.match(data.prompt, /この接続は観測専用/);
  assert.doesNotMatch(data.prompt, /\n.* send /);
  const register = data.prompt.split("\n").find(line => line.includes(` supervise register ${ID} `));
  const recipientEnv = { PATH: "/no-supervisor-cli", HOME: f.home };
  await exec("/bin/sh", ["-c", register], { cwd: "/private/tmp", env: recipientEnv });
  const read = data.prompt.split("\n").find(line => line.endsWith(` read ${ID} --include-output --json`));
  const observed = JSON.parse((await exec("/bin/sh", ["-c", read], { cwd: "/private/tmp", env: recipientEnv })).stdout).data;
  assert.equal(observed.connection_mode, "desktop");
  assert.equal((await f.cli(["supervise", "status", ID])).data.observation.connection, "observed");
  const switched = read.replace("--connection desktop", "--connection shared");
  await assert.rejects(exec("/bin/sh", ["-c", switched], { cwd: "/private/tmp", env: recipientEnv }), error => JSON.parse(error.stdout).error.code === "SUPERVISOR_MISMATCH");
  await assert.rejects(exec("/bin/sh", ["-c", register.replace("--connection desktop", "--connection shared")], { cwd: "/private/tmp", env: recipientEnv }), /another connection/);
  const before = f.calls.length;
  for (const args of [["send", ID, "test"], [ID, "test"], ["send", ID, "test", "--new-turn"], ["send", ID, "test", "--backend", "ui"], ["instructions", "retract", ID, "unused", "--reason", "test"], ["desktop", "start"]]) {
    assert.equal((await f.cli(args, false)).error.code, "DESKTOP_READ_ONLY");
  }
  assert.equal(f.calls.length, before);
});
