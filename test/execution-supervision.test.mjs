import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";
import { acquireResource, renewResource, releaseResource, resourceStatus, runWithResource } from "../src/resource.mjs";
import { runCommand } from "../src/runner.mjs";
import { createCheckpoint, getCheckpoint, runCheckpoint } from "../src/checkpoint.mjs";

const THREAD = "11111111-1111-4111-8111-666666666666", SESSION = "22222222-2222-4222-8222-666666666666";
async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-execution-")), cwd = `${home}/project`; await mkdir(cwd); await writeFile(`${cwd}/input`, "x");
  t.after(() => rm(home, { recursive: true, force: true }));
  await registerManagedThread(THREAD, { projectId: "fixture", connection: "shared" }, { home });
  await registerSupervisor(THREAD, SESSION, { home, owner: "fixture", connection: "shared" });
  return { home, cwd };
}

test("acknowledged pause before local resource dispatch starts no process and public bypass flags are inert", async t => {
  const f = await fixture(t), marker = `${f.home}/dispatched`, argv = [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'x')", marker];
  await assert.rejects(runWithResource("local", argv, { ...f, owner: "fixture", threadId: THREAD, connection: "shared" }, {
    execute: async (args, options) => { await controlSupervisor(THREAD, "pause", f); return runCommand(args, { ...options, home: f.home, supervisionHeld: true }); },
  }), { code: "SUPERVISOR_PAUSED" });
  assert.equal(existsSync(marker), false); assert.equal((await resourceStatus("local", f)).state, "released");
  await assert.rejects(runCommand(argv, { ...f, threadId: THREAD, connection: "shared", supervisionHeld: true }), { code: "SUPERVISOR_PAUSED" });
  assert.equal(existsSync(marker), false);
});

test("renew derives its managed thread from the lease while release remains cleanup", async t => {
  const f = await fixture(t), lease = await acquireResource("lease", { ...f, owner: "fixture", threadId: THREAD, connection: "shared", ttlMs: 5000 });
  const expiry = lease.expires_at; await controlSupervisor(THREAD, "pause", f);
  await assert.rejects(renewResource("lease", lease.token, { home: f.home, ttlMs: 6000 }), { code: "SUPERVISOR_PAUSED" });
  assert.equal((await resourceStatus("lease", f)).lease.expires_at, expiry);
  await releaseResource("lease", lease.token, f); assert.equal((await resourceStatus("lease", f)).state, "released");
});

test("an accepted resource run renews and completes after pause, while a new run is refused", async t => {
  const f = await fixture(t); let startedResolve; const started = new Promise(resolve => { startedResolve = resolve; });
  const running = runWithResource("accepted", [process.execPath, "-e", "setTimeout(()=>{},1500)"], { ...f, owner: "fixture", threadId: THREAD, connection: "shared", ttlMs: 1000 }, {
    execute: (args, options) => runCommand(args, { ...options, home: f.home, onStart: pid => { startedResolve(pid); } }),
  });
  await started; let paused;
  for (let i = 0; i < 100 && !paused; i++) try { paused = await controlSupervisor(THREAD, "pause", f); } catch (error) { if (error.code !== "RECORD_BUSY") throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(paused.state, "paused");
  await assert.rejects(runWithResource("new", [process.execPath, "-e", ""], { ...f, owner: "fixture", threadId: THREAD, connection: "shared" }), { code: "SUPERVISOR_PAUSED" });
  const result = await running; assert.equal(result.error, null); assert.equal(result.lease_error, null); assert.equal(result.released, true);
});

test("checkpoint releases supervisor lock after dispatch and saves accepted completion after stop", async t => {
  const f = await fixture(t), cp = await createCheckpoint(THREAD, "fixture", { ...f, paths: ["input"], connection: "shared" });
  const ready = `${f.home}/ready`, release = `${f.home}/release`, completed = `${f.home}/completed`;
  // Completion is impossible until the parent releases the barrier after stop.
  const script = "const fs=require('fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);fs.writeFileSync(process.argv[3],'completed')}},5)";
  const running = runCheckpoint(THREAD, cp.id, [process.execPath, "-e", script, ready, release, completed], { ...f, connection: "shared", timeoutMs: 10000 });
  t.after(() => writeFile(release, "cleanup").catch(() => {}));
  for (let i = 0; i < 1000 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(existsSync(ready), true);
  for (let i = 0; i < 100 && !(await getCheckpoint(THREAD, cp.id, f)).runs.some(run => run.status === "running"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  let stopped;
  for (let i = 0; i < 100 && !stopped; i++) try { stopped = await controlSupervisor(THREAD, "stop", f); } catch (error) { if (error.code !== "RECORD_BUSY") throw error; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(stopped.state, "stopped");
  assert.equal(existsSync(completed), false, "completion has not happened at stop acknowledgement");
  assert.equal((await getCheckpoint(THREAD, cp.id, f)).runs.at(-1).status, "running");
  await writeFile(release, "release after stop");
  const result = await running; assert.equal(result.status, "completed");
  assert.equal((await getCheckpoint(THREAD, cp.id, f)).runs.at(-1).status, "completed");
});
