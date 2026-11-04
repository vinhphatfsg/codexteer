import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { claimRuntime } from "../src/runtime.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { listRecords } from "../src/store.mjs";

const exec = promisify(execFile), BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const ID = "11111111-1111-4111-8111-000000000001", SESSION = "22222222-2222-4222-8222-000000000001";

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-wait-proc-")), env = { ...process.env, CODEX_HOME: home };
  const lease = await claimRuntime(home, { server_pid: process.pid, desktop_connected: true });
  const http = createServer(), ws = new WebSocketServer({ server: http });
  const thread = { id: ID, historyMode: "aggregate", status: { type: "idle" }, turns: [{ id: "t0", status: "completed", items: [{ id: "q0", type: "agentMessage", text: "Awaiting answer", questions: ["Answer?"] }] }] };
  const calls = [];
  ws.on("connection", peer => peer.on("message", bytes => {
    const request = JSON.parse(bytes); if (request.id == null) return;
    calls.push(request.method);
    const result = request.method === "initialize" ? {} : request.method === "thread/read" ? { thread } : null;
    peer.send(JSON.stringify(result === null ? { id: request.id, error: { code: -32601, message: "Unavailable" } } : { id: request.id, result }));
  }));
  http.listen(lease.paths.socket); await once(http, "listening"); await chmod(lease.paths.socket, 0o600);
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve));
    await lease.release(); await rm(home, { recursive: true, force: true });
  });
  await registerManagedThread(ID, { projectId: "P", connection: "shared" }, { home });
  await registerSupervisor(ID, SESSION, { home });
  const cli = async args => JSON.parse((await exec(process.execPath, [BIN, ...args], { env, timeout: 10000 })).stdout);
  const guard = () => cli(["project", "guard", "--project", "P"]);
  await cli(["project", "sync", "--project", "P", "--json"]);
  async function launchWait() {
    const child = spawn(process.execPath, [BIN, "project", "wait", "--project", "P", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = once(child, "close");
    for (let n = 0; n < 300 && !(await listRecords("project-waits", { home })).some(record => record.pid === child.pid); n++) {
      assert.equal(child.exitCode, null, stderr); await delay(10);
    }
    assert.deepEqual(await guard(), {}, stderr);
    return { child, closed, output: () => stdout };
  }
  return { home, cli, guard, launchWait, thread, calls };
}

test("real CLI wait: unchanged idle attention times out without changing the sync basis", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const before = await listRecords("project-sync-heads", { home: f.home });
  const result = await f.cli(["project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
  assert.equal(result.data.changed, false); assert.equal(result.data.timed_out, true); assert.equal(result.data.sync, null);
  assert.deepEqual(await listRecords("project-sync-heads", { home: f.home }), before);
});

test("real CLI wait: a fresh Desktop turn after idle awaiting an answer wakes the background command", { timeout: 20000 }, async t => {
  const f = await fixture(t), waiting = await f.launchWait();
  // Desktop can start and finish the next turn entirely between wait polls.
  f.thread.turns.push({ id: "t1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Done" }] });
  assert.deepEqual(await waiting.closed, [0, null]);
  assert.equal(JSON.parse(waiting.output()).data.changed, true);
});

test("real CLI wait: a published change is not returned twice", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.thread.turns.push({ id: "t1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Done" }] });
  const args = ["project", "wait", "--project", "P", "--timeout-ms", "0", "--json"];
  assert.equal((await f.cli(args)).data.changed, true);
  const second = await f.cli(args); assert.equal(second.data.changed, false); assert.equal(second.data.timed_out, true);
});

test("real CLI background wait changes Stop guard decisions and SIGKILL leaves an inert record", { timeout: 20000 }, async t => {
  const { home, cli, guard, launchWait, thread, calls } = await fixture(t);
  assert.equal((await guard()).decision, "block");
  const first = await launchWait();
  // Desktop can start and finish the next turn entirely between wait polls.
  thread.turns.push({ id: "t1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Done" }] });
  assert.deepEqual(await first.closed, [0, null]);
  assert.equal(JSON.parse(first.output()).data.changed, true);
  assert.equal((await guard()).decision, "block");
  const crashed = await launchWait(); crashed.child.kill("SIGKILL"); await crashed.closed;
  assert.ok((await listRecords("project-waits", { home })).some(record => record.pid === crashed.child.pid));
  assert.equal((await guard()).decision, "block", "a dead wait record must not permit stop");
  await cli(["project", "control", "stop", "--project", "P", "--all", "--json"]);
  assert.deepEqual(await guard(), {});
  assert.ok(calls.every(method => ["initialize", "thread/read"].includes(method)), "backend calls remain observation only");
  t.diagnostic("bin/codexteer.mjs: no wait=block; live wait=allow; reported turn=block; SIGKILL record=block; all stopped=allow");
});
