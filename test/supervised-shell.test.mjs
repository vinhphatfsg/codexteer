import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { withTarget } from "../src/target.mjs";
import { registerSupervisor, assertSupervisor, controlSupervisor, getSupervisor } from "../src/supervision.mjs";
import { runRemoteShellCommand } from "../src/remote-io.mjs";
import { runWithResource, resourceStatus } from "../src/resource.mjs";

const HOST = "remote-control:env_fixture", ID = "11111111-1111-4111-8111-111111111111", SESSION = "22222222-2222-4222-8222-222222222222";
const scope = fn => withTarget(HOST, undefined, fn, { transport: "paired" });
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/ct-supervised-shell-");
  t.after(() => rm(home, { recursive: true, force: true }));
  await registerSupervisor(ID, SESSION, { home, owner: "fixture", connection: "shared" });
  let dispatched = 0, command;
  const client = { close() {}, async request(method, args) {
    if (method === "thread/shellCommand") { dispatched++; command = args.command; return {}; }
    assert.equal(method, "thread/read");
    return { thread: { id: ID, status: { type: "idle" }, turns: command ? [{ id: "fixture-turn", status: "completed", items: [{ id: "fixture-command", type: "commandExecution", command,
      status: "completed", exitCode: 0, aggregatedOutput: `${command.match(/CODEXTEER_EXEC_[a-f0-9-]{36}/)[0]}:0\n` }] }] : [] } };
  } };
  const dependencies = { route: () => ({ discover: async () => ({ paths: { socket: "fake", home } }), connect: async () => client }) };
  const options = { threadId: ID, shell: "posix", supervisor: SESSION, connection: "shared" };
  return { home, client, dependencies, options, get dispatched() { return dispatched; } };
}

for (const action of ["pause", "stop"]) test(`acknowledged ${action} between preflight and shell dispatch prevents execution`, t => scope(async () => {
  const f = await fixture(t);
  await assertSupervisor(ID, SESSION, { home: f.home, connection: "shared", sending: true });
  // The real path can await a lease, a checkpoint snapshot, a connection, and
  // onStart after the CLI check. Interleave control at the final async hook.
  await assert.rejects(runRemoteShellCommand(["fixture-program"], { ...f.options, onStart: () => controlSupervisor(ID, action, { home: f.home }) }, f.dependencies),
    { code: action === "pause" ? "SUPERVISOR_PAUSED" : "SUPERVISOR_STOPPED" });
  assert.equal(f.dispatched, 0);
}));

test("resource execution carries the supervisor binding and releases a refused shell lease", t => scope(async () => {
  const f = await fixture(t);
  await assert.rejects(runWithResource("fixture-resource", ["fixture-program"], { home: f.home, owner: "fixture", threadId: ID,
    supervisor: SESSION, connection: "shared", execBackend: "thread-shell", remoteShell: "posix" }, {
    execute: (argv, options) => {
      assert.equal(options.supervisor, SESSION); assert.equal(options.connection, "shared");
      return runRemoteShellCommand(argv, { ...options, shell: options.remoteShell, onStart: () => controlSupervisor(ID, "pause", { home: f.home }) }, f.dependencies);
    },
  }), { code: "SUPERVISOR_PAUSED" });
  assert.equal(f.dispatched, 0);
  assert.equal((await resourceStatus("fixture-resource", { home: f.home })).state, "released");
}));

test("active and unbound shell controls retain completion without changing message delivery state", t => scope(async () => {
  for (const bound of [true, false]) {
    const f = await fixture(t);
    const result = await runRemoteShellCommand(["fixture-program"], { ...f.options, supervisor: bound ? SESSION : undefined }, f.dependencies);
    assert.equal(result.exit_code, 0); assert.equal(f.dispatched, 1);
    assert.equal((await getSupervisor(ID, { home: f.home })).last_delivery, null);
  }
}));

test("pause/stop cannot acknowledge during shell dispatch, but can succeed after acceptance", t => scope(async () => {
  const f = await fixture(t), original = f.client.request.bind(f.client);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.client.request = async (method, args) => {
    if (method === "thread/shellCommand") { enter(); await gate; }
    return original(method, args);
  };
  const running = runRemoteShellCommand(["fixture-program"], f.options, f.dependencies);
  try {
    await entered;
    for (const action of ["pause", "stop"]) await assert.rejects(controlSupervisor(ID, action, { home: f.home }), { code: "RECORD_BUSY" });
  } finally { release(); }
  assert.equal((await running).exit_code, 0);
  assert.equal((await controlSupervisor(ID, "pause", { home: f.home })).state, "paused");
  assert.equal(f.dispatched, 1);
}));

test("unknown shell receipt releases the supervisor lock and retains the resource lease without replay", t => scope(async () => {
  const f = await fixture(t), original = f.client.request.bind(f.client);
  let attempts = 0;
  f.client.request = async (method, args) => {
    if (method === "thread/shellCommand") { attempts++; throw Object.assign(new Error("fixture receipt lost"), { code: "CONNECTION_FAILED", uncertain: true }); }
    return original(method, args);
  };
  await assert.rejects(runWithResource("unknown", ["fixture-program"], { home: f.home, owner: "fixture", threadId: ID,
    supervisor: SESSION, connection: "shared", execBackend: "thread-shell", remoteShell: "posix" }, {
    execute: (argv, options) => runRemoteShellCommand(argv, { ...options, shell: options.remoteShell }, f.dependencies),
  }), error => error.uncertain === true && error.lease_retained === true);
  assert.equal(attempts, 1);
  assert.equal((await resourceStatus("unknown", { home: f.home })).state, "held");
  assert.equal((await controlSupervisor(ID, "stop", { home: f.home })).state, "stopped");
}));

test("shell dispatch revalidates session and connection, and cancellation after preparation", t => scope(async () => {
  for (const mismatch of [{ supervisor: "33333333-3333-4333-8333-333333333333" }, { connection: "desktop" }]) {
    const f = await fixture(t);
    await assert.rejects(runRemoteShellCommand(["fixture-program"], { ...f.options, ...mismatch }, f.dependencies), { code: "SUPERVISOR_MISMATCH" });
    assert.equal(f.dispatched, 0);
  }
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(runRemoteShellCommand(["fixture-program"], { ...f.options, signal: controller.signal, onStart: async () => { controller.abort(); } }, f.dependencies), { code: "CANCELLED" });
  assert.equal(f.dispatched, 0);
}));
