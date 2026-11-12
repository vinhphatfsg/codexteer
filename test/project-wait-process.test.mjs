import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { mkdtemp, mkdir, chmod, rm, readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { claimRuntime } from "../src/runtime.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { listRecords } from "../src/store.mjs";
import { startAgentSession } from "../test-support/agent-session.mjs";
import { processIdentity } from "../src/project-wait.mjs";

const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const ID = "11111111-1111-4111-8111-000000000001", SESSION = "22222222-2222-4222-8222-000000000001";
const exec = promisify(execFile);

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
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await session.close();
    for (const peer of ws.clients) peer.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve));
    await lease.release(); await rm(home, { recursive: true, force: true });
  });
  await registerManagedThread(ID, { projectId: "P", connection: "shared" }, { home });
  await registerSupervisor(ID, SESSION, { home });
  const session = await startAgentSession({ home, env, bin: BIN, direct: true }); sessions.push(session);
  const other = await startAgentSession({ home, env, bin: BIN }); sessions.push(other);
  const run = (agent, args) => agent.request("run", { args });
  const cli = async args => {
    const result = await run(session, args); assert.equal(result.code, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const guard = async () => JSON.parse((await session.request("hook")).stdout);
  await cli(["project", "sync", "--project", "P", "--json"]);
  async function launchWait(agent = session) {
    const pid = await agent.request("wait", { args: ["project", "wait", "--project", "P", "--json"] });
    for (let n = 0; n < 300 && !(await listRecords("project-waits", { home })).some(record => record.pid === pid); n++) {
      await delay(10);
    }
    assert.deepEqual(JSON.parse((await run(agent, ["project", "guard", "--project", "P"])).stdout), {});
    let result;
    const closed = agent.request("result", { pid }).then(value => { result = value; return [value.code, value.signal]; });
    return { child: { pid, kill: () => agent.request("kill", { pid }) }, closed, output: () => result.stdout };
  }
  return { home, cli, guard, launchWait, thread, calls, other, session, run };
}

test("real orchestrate launch: only its own wait permits Stop; another session is blocked and cannot start a second wait", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const status = await f.cli(["project", "guard", "--project", "P", "--status", "--json"]);
  assert.equal(status.data.stop_hook, "configured");
  const waiting = await f.launchWait();
  const foreign = await f.run(f.other, ["project", "guard", "--project", "P"]);
  assert.equal(foreign.code, 0); assert.equal(JSON.parse(foreign.stdout).decision, "block");
  const busy = await f.run(f.other, ["project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
  assert.equal(busy.code, 1); assert.equal(JSON.parse(busy.stdout).error.code, "RECORD_BUSY");
  assert.match(JSON.parse(busy.stdout).error.message, /one orchestrator.*hand off/);
  assert.deepEqual(await f.guard(), {});
  await waiting.child.kill(); await waiting.closed;
  assert.equal((await f.guard()).decision, "block");
  const handedOff = await f.launchWait(f.other);
  assert.equal((await f.guard()).decision, "block", "handoff never makes the new wait belong to the old session");
  await handedOff.child.kill(); await handedOff.closed;
  t.diagnostic("checkout bin/codexteer.mjs: direct-launch own wait=allow; foreign session=block; competing wait=RECORD_BUSY; killed wait=block");
});

test("real CLI sync and wait report the calling session's Stop hook status beside the paged result", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const connection of [[], ["--connection", "desktop-cloud"]]) {
    assert.equal((await f.cli([...connection, "project", "guard", "--project", "P", "--status", "--json"])).data.stop_hook, "configured", connection.join(" "));
    const sync = await f.cli([...connection, "project", "sync", "--project", "P", "--json"]);
    assert.equal(sync.data.stop_hook, "configured", connection.join(" ")); assert.equal(sync.data.works[0].thread_id, ID);
    const { stop_hook: _hook, ...page } = sync.data;
    assert.equal(sync.data.output_bytes, Buffer.byteLength(JSON.stringify(page)), "the paged envelope keeps its own size");
    const continued = await f.cli([...connection, "project", "sync", "--continue", sync.data.sync_token, "--offset", "0", "--event-offset", "0", "--json"]);
    assert.equal(continued.data.stop_hook, "configured");
    const waited = await f.cli([...connection, "project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
    assert.equal(waited.data.timed_out, true); assert.equal(waited.data.stop_hook, "configured");
    for (const args of [["project", "sync", "--project", "P", "--json"], ["project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]]) {
      const foreign = await f.run(f.other, [...connection, ...args]);
      assert.equal(foreign.code, 0, foreign.stderr); assert.equal(JSON.parse(foreign.stdout).data.stop_hook, "unverified");
    }
  }
});

test("real CLI wait: unchanged idle attention times out without changing the sync basis", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const before = await listRecords("project-sync-heads", { home: f.home });
  const result = await f.cli(["project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
  assert.equal(result.data.changed, false); assert.equal(result.data.timed_out, true); assert.equal(result.data.sync, null);
  assert.deepEqual(await listRecords("project-sync-heads", { home: f.home }), before);
});

test("wait and owner records remain compact and never persist the orchestrator prompt", { timeout: 20000 }, async t => {
  const f = await fixture(t), waiting = await f.launchWait();
  try {
    const [record] = await listRecords("project-waits", { home: f.home });
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 1024, "process identities must not copy the launch prompt");
    assert.doesNotMatch(JSON.stringify(record), /あなたは担当|目標と委任|--settings/);
    if (process.platform === "darwin") {
      assert.match(record.owner.process_start, /:sha256:[a-f0-9]{64}$/);
      assert.match(record.process_start, /:sha256:[a-f0-9]{64}$/);
    }
    assert.deepEqual(await f.guard(), {}, "hashed identities still recognize this session's live wait");
  } finally { await waiting.child.kill(); await waiting.closed; }
});

test("a detached macOS guard warns when launchd is its parent, even with another live wait", { timeout: 20000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), waiting = await f.launchWait(), output = `${f.home}/detached-guard.json`;
  try {
    const guard = `
      const deadline = Date.now() + 5000;
      while (process.ppid !== 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      if (process.ppid !== 1) throw new Error("Guard was not adopted by launchd");
      process.argv = [process.execPath, ${JSON.stringify(BIN)}, "project", "guard", "--project", "P"];
      await import(${JSON.stringify(new URL("../bin/codexteer.mjs", import.meta.url).href)});
    `;
    // The short-lived launcher exits; its detached child waits for launchd
    // adoption before executing this checkout's real CLI.
    const launcher = `
      const { spawn } = require("node:child_process"), fs = require("node:fs");
      const out = fs.openSync(${JSON.stringify(output)}, "w", 0o600);
      const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(guard)}], { detached: true, stdio: ["ignore", out, out] });
      child.unref(); fs.closeSync(out);
    `;
    await exec(process.execPath, ["-e", launcher], { env: { ...process.env, CODEX_HOME: f.home }, timeout: 10000 });
    let text = "";
    for (let n = 0; n < 700; n++) {
      text = await readFile(output, "utf8");
      if (text.trim()) break;
      await delay(10);
    }
    const result = JSON.parse(text);
    assert.equal(result.decision, undefined);
    assert.match(result.systemMessage, /PROJECT_GUARD_OWNER_UNVERIFIED.*stop is allowed/);
    assert.deepEqual(await f.guard(), {}, "the identified owning session still has a valid wait");
  } finally { await waiting.child.kill(); await waiting.closed; }
});

test("macOS hashed identity preserves command changes, including a wait nonce", { skip: process.platform !== "darwin" }, async () => {
  const original = process.title;
  try {
    process.title = "codexteer-identity-private-goal-first";
    const first = await processIdentity(process.pid);
    assert.match(first, /:sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(first, /private-goal/);
    assert.equal(await processIdentity(process.pid), first);
    process.title = "codexteer-identity-private-goal-second";
    assert.notEqual(await processIdentity(process.pid), first, "same PID and start date with a changed nonce must not match");
  } finally { process.title = original; }
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

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitCommand = (connection, out) => `"${process.execPath}" "${BIN}" ${connection.join(" ")} project wait --project P --json > "${out}"`;

async function waitRecord(home, known) {
  let record;
  for (let n = 0; n < 500 && !record; n++) {
    record = (await listRecords("project-waits", { home })).find(row => row.pid !== known);
    if (!record) await delay(10);
  }
  assert.ok(record, "the wait registered itself");
  return record;
}

for (const [connection, change] of [[[], false], [[], true], [["--connection", "desktop-cloud"], false]]) test(`real CLI wait${connection.length ? " (Desktop Cloud CLI)" : ""} ends without publishing when the shell that launched it is killed${change ? " as a member changes" : ""}, and the next wait starts`, { timeout: 20000 }, async t => {
  const f = await fixture(t), out = `${f.home}/killed-launcher.json`;
  // A background task: the shell stays the wait's parent to report its exit code.
  const shell = spawn("/bin/sh", ["-c", `${waitCommand(connection, out)}; echo exit=$?`], { env: { ...process.env, CODEX_HOME: f.home }, stdio: "ignore" });
  let record;
  t.after(() => { for (const pid of [shell.pid, record?.pid]) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } });
  record = await waitRecord(f.home);
  assert.notEqual(record.pid, shell.pid, "the shell did not replace itself with the wait");
  const heads = await listRecords("project-sync-heads", { home: f.home });
  shell.kill("SIGKILL"); await once(shell, "close");
  if (change) f.thread.turns.push({ id: "t1", status: "completed", items: [{ id: "report", type: "agentMessage", text: "Done" }] });
  for (let n = 0; n < 500 && alive(record.pid); n++) await delay(10);
  assert.equal(alive(record.pid), false, "the wait ends soon after its launcher is gone");
  assert.deepEqual(await listRecords("project-waits", { home: f.home }), []);
  const result = JSON.parse(await readFile(out, "utf8")).data;
  assert.equal(result.reason, "launcher_exited"); assert.equal(result.changed, false); assert.equal(result.timed_out, false); assert.equal(result.sync, null);
  assert.deepEqual(await listRecords("project-sync-heads", { home: f.home }), heads, "a change nobody would be told about stays unpublished");
  const next = await f.run(f.other, [...connection, "project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
  assert.equal(next.code, 0, next.stdout); assert.equal(JSON.parse(next.stdout).data.reason, change ? "work_changed" : "timeout", "no RECORD_BUSY, and a change is still owed");
});

test("real CLI wait keeps running under a launcher that stays alive and under nohup after its shell exits", { timeout: 30000 }, async t => {
  const f = await fixture(t), env = { ...process.env, CODEX_HOME: f.home }, started = [];
  t.after(() => { for (const pid of started) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } });
  const wrapper = spawn("/bin/sh", ["-c", `${waitCommand([], `${f.home}/wrapped.json`)}; echo exit=$?`], { env, stdio: "ignore" });
  started.push(wrapper.pid);
  const wrapped = await waitRecord(f.home); started.push(wrapped.pid);
  await delay(2500);
  assert.equal(await processIdentity(wrapped.pid), wrapped.process_start, "several polls later the wrapped wait still runs");
  process.kill(wrapped.pid, "SIGKILL"); await once(wrapper, "close");
  const shell = spawn("/bin/sh", ["-c", `nohup ${waitCommand([], `${f.home}/nohup.json`)} 2>&1 &`], { env, stdio: "ignore" });
  await once(shell, "close");
  const detached = await waitRecord(f.home, wrapped.pid); started.push(detached.pid);
  await delay(2500);
  assert.equal(await processIdentity(detached.pid), detached.process_start, "a wait detached on purpose outlives the shell that started it");
  assert.equal((await readFile(`${f.home}/nohup.json`, "utf8")).trim(), "", "and has returned nothing");
});

test("real CLI wait started with nohup ends when the shell that launched it exits later", { timeout: 30000 }, async t => {
  const f = await fixture(t), env = { ...process.env, CODEX_HOME: f.home }, out = `${f.home}/late.json`;
  // nohup blocks the hangup signal. It does not keep the shell as the parent.
  const shell = spawn("/bin/sh", ["-c", `nohup ${waitCommand([], out)} 2>/dev/null & sleep 2`], { env, stdio: "ignore" });
  const record = await waitRecord(f.home);
  t.after(() => { for (const pid of [shell.pid, record.pid]) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } });
  assert.equal(await processIdentity(record.pid), record.process_start, "the wait runs while its shell lives");
  await once(shell, "close");
  for (let n = 0; n < 300 && (await listRecords("project-waits", { home: f.home })).length; n++) await delay(10);
  assert.deepEqual(await listRecords("project-waits", { home: f.home }), [], "the record goes within seconds of the shell");
  let result;
  for (let n = 0; n < 300 && !result; n++) { try { result = JSON.parse(await readFile(out, "utf8")).data; } catch { await delay(10); } }
  assert.equal(result.reason, "launcher_exited"); assert.equal(result.sync, null); assert.deepEqual(result.unreadable, []);
});

for (const connection of [[], ["--connection", "desktop-cloud"]]) test(`real CLI wait${connection.length ? " (Desktop Cloud CLI)" : ""} ends with exit 1 when its agent session dies, and the next session's wait starts`, { timeout: 20000 }, async t => {
  const f = await fixture(t), dir = `${f.home}/dying-agent`, out = `${dir}/wait.json`, code = `${dir}/wait.code`;
  await mkdir(dir);
  // A session that runs wait through a shell, so the wait outlives it as an orphan.
  const command = `"${process.execPath}" "${BIN}" ${connection.join(" ")} project wait --project P --json > "${out}"; echo $? > "${code}"`;
  await writeFile(`${dir}/claude`, `#!${process.execPath}\nrequire("node:child_process").spawn("/bin/sh", ["-c", ${JSON.stringify(command)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const agent = spawn(process.execPath, [`${dir}/claude`], { env: { ...process.env, CODEX_HOME: f.home }, stdio: "ignore" });
  let record;
  t.after(() => { for (const pid of [agent.pid, record?.pid]) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } });
  for (let n = 0; n < 500 && !record; n++) { record = (await listRecords("project-waits", { home: f.home }))[0]; if (!record) await delay(10); }
  assert.equal(record?.owner?.pid, agent.pid, "the wait belongs to the session that started it");
  agent.kill("SIGKILL"); await once(agent, "close");
  let exit = "";
  for (let n = 0; n < 1000 && !exit; n++) { exit = await readFile(code, "utf8").catch(() => ""); if (!exit) await delay(10); }
  assert.equal(exit.trim(), "1", "an orphaned wait exits instead of holding the project");
  const result = JSON.parse(await readFile(out, "utf8")).data;
  assert.equal(result.reason, "owner_exited"); assert.equal(result.changed, false); assert.equal(result.timed_out, false);
  assert.deepEqual(await listRecords("project-waits", { home: f.home }), []);
  const next = await f.run(f.other, [...connection, "project", "wait", "--project", "P", "--timeout-ms", "0", "--json"]);
  assert.equal(next.code, 0, next.stdout); assert.equal(JSON.parse(next.stdout).data.reason, "timeout", "no RECORD_BUSY for the resumed session");
});
