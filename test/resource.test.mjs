import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { acquireResource, releaseResource, renewResource, resourceStatus, runWithResource } from "../src/resource.mjs";

async function fixture(t) { const home = await mkdtemp("/private/tmp/cs-resource-"); t.after(() => rm(home, { recursive: true, force: true })); return { home }; }

test("leases exclude another owner and record conditions without interpreting them as permissions", async t => {
  const f = await fixture(t); let now = 100000;
  const a = await acquireResource("screen", { ...f, now: () => now, owner: "claude-code", condition: "user permission recorded", ttlMs: 1000 });
  await assert.rejects(acquireResource("screen", { ...f, now: () => now, owner: "codex" }), { code: "RESOURCE_BUSY" });
  assert.equal((await resourceStatus("screen", { ...f, now: () => now })).lease.condition, "user permission recorded");
  now += 1001;
  assert.equal((await resourceStatus("screen", { ...f, now: () => now })).state, "expired");
  const b = await acquireResource("screen", { ...f, now: () => now, owner: "codex" });
  await assert.rejects(releaseResource("screen", a.token, f), /does not match/);
  await assert.rejects(renewResource("screen", a.token, f), /no longer owned/);
  await releaseResource("screen", b.token, f);
  assert.equal((await resourceStatus("screen", f)).state, "released");
});

test("resource run holds and renews the lease, releases it on command failure", async t => {
  const f = await fixture(t);
  const running = runWithResource("unity", [process.execPath, "-e", "setTimeout(()=>process.exit(3),1500)"], { ...f, owner: "codex", ttlMs: 1000 });
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(acquireResource("unity", { ...f, owner: "claude-code" }), error => ["RESOURCE_BUSY", "RECORD_BUSY"].includes(error.code));
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await resourceStatus("unity", f)).state, "held");
  const result = await running;
  assert.equal(result.exit_code, 3); assert.equal(result.valid, false); assert.equal(result.released, true);
  assert.equal((await resourceStatus("unity", f)).state, "released");
});

test("loss of lease stops only the command started by resource run", async t => {
  const f = await fixture(t);
  const running = runWithResource("git", [process.execPath, "-e", "setTimeout(()=>{},20000)"], { ...f, owner: "codex", ttlMs: 1000 });
  await new Promise(r => setTimeout(r, 100));
  const old = (await resourceStatus("git", f)).lease;
  await releaseResource("git", old.token, f);
  const replacement = await acquireResource("git", { ...f, owner: "other" });
  const result = await running;
  assert.equal(result.valid, false); assert.ok(result.lease_error); assert.equal(result.signal, "SIGTERM");
  assert.equal((await resourceStatus("git", f)).lease.token, replacement.token);
});

test("concurrent claims have at most one winner and a busy run executes nothing", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([acquireResource("one", { ...f, owner: "a" }), acquireResource("one", { ...f, owner: "b" })]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const marker = `${f.home}/should-not-exist`;
  await assert.rejects(runWithResource("one", [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'bad')", marker], { ...f, owner: "c" }), { code: "RESOURCE_BUSY" });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("unknown remote execution retains its lease instead of allowing a competing run", async t => {
  const f = await fixture(t);
  await assert.rejects(runWithResource("unknown", ["remote-program"], { ...f, owner: "original" }, {
    execute: async () => { throw Object.assign(new Error("lost command completion"), { code: "CONNECTION_FAILED", uncertain: true }); },
  }), error => error.lease_retained === true && error.remote_execution_status === "unknown");
  assert.equal((await resourceStatus("unknown", f)).state, "held");
  await assert.rejects(acquireResource("unknown", { ...f, owner: "other" }), { code: "RESOURCE_BUSY" });
});

test("a bound supervisor's resource commands require its --thread and the same supervisor state as run", async t => {
  const { spawnSync } = await import("node:child_process"), { existsSync } = await import("node:fs");
  const { registerSupervisor, controlSupervisor } = await import("../src/supervision.mjs");
  const f = await fixture(t), THREAD = "33333333-3333-4333-8333-333333333333", OTHER = "44444444-4444-4444-8444-444444444444";
  const SESSION = "55555555-5555-4555-8555-555555555555", STRANGER = "66666666-6666-4666-8666-666666666666";
  const cli = args => { const r = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } }); return { status: r.status, ...JSON.parse(r.stdout) }; };
  const marker = `${f.home}/ran`, run = [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'x')", marker];
  const commands = token => ({ acquire: ["acquire", "lock", "--owner", "sup"], renew: ["renew", "lock", "--token", token], release: ["release", "lock", "--token", token], status: ["status", "lock"], list: ["list"], run: ["run", "other-lock", "--owner", "sup", "--", ...run] });
  const as = (session, thread, command) => cli(["--supervisor", session, "resource", ...(thread ? ["--thread", thread] : []), ...command]);
  await registerSupervisor(THREAD, SESSION, f);
  for (const command of Object.values(commands("fixture-token"))) assert.equal(as(SESSION, undefined, command).error?.code, "SUPERVISOR_CONTROL_FORBIDDEN", command.join(" "));
  const acquired = as(SESSION, THREAD, commands().acquire);
  assert.equal(acquired.ok, true); assert.equal(acquired.data.thread_id, THREAD);
  const token = acquired.data.token, active = commands(token);
  for (const name of ["renew", "status", "list"]) assert.equal(as(SESSION, THREAD, active[name]).ok, true, name);
  for (const [session, thread, code] of [[STRANGER, THREAD, "SUPERVISOR_MISMATCH"], [STRANGER, OTHER, "SUPERVISOR_NOT_REGISTERED"], [SESSION, OTHER, "SUPERVISOR_CONFLICT"]]) {
    for (const [name, command] of Object.entries(active)) assert.equal(as(session, thread, command).error?.code, code, `${code} ${name}`);
  }
  await controlSupervisor(THREAD, "pause", f);
  for (const name of ["acquire", "renew", "run"]) assert.equal(as(SESSION, THREAD, active[name]).error?.code, "SUPERVISOR_PAUSED", name);
  assert.equal(existsSync(marker), false);
  assert.equal((await resourceStatus("other-lock", f)).state, "available");
  for (const name of ["status", "list", "release"]) assert.equal(as(SESSION, THREAD, active[name]).ok, true, name);
  assert.equal((await resourceStatus("lock", f)).state, "released");
  await controlSupervisor(THREAD, "resume", f);
  assert.equal(as(SESSION, THREAD, active.run).ok, true); assert.equal(existsSync(marker), true);
  const held = as(SESSION, THREAD, active.acquire).data.token;
  await controlSupervisor(THREAD, "stop", f);
  for (const [name, command] of Object.entries(commands(held))) assert.equal(as(SESSION, THREAD, command).error?.code, "SUPERVISOR_STOPPED", name);
  assert.equal((await resourceStatus("lock", f)).state, "held");
});
