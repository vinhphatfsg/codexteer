import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread, listManagedThreads, managedMembershipDigest } from "../src/project-index.mjs";
import { registerSupervisor, getSupervisor, controlSupervisor, dispatchExternalEffect } from "../src/supervision.mjs";
import { controlProject } from "../src/project-control.mjs";
import { withStoreLock, listRecords } from "../src/store.mjs";
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const session = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
async function fixture(t, count = 3) {
  const home = await mkdtemp(tempPrefix("ct-control-")); t.after(() => rm(home, { recursive: true, force: true }));
  for (let n = 1; n <= count; n++) { await registerManagedThread(id(n), { projectId: "P", connection: "shared" }, { home }); await registerSupervisor(id(n), session(n), { home }); }
  return { home };
}
const barrier = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

test("project control reports changed/already and never resumes stopped work", async t => {
  const f = await fixture(t), members = await listManagedThreads("P", f);
  const paused = await controlProject("P", "pause", { all: true }, f);
  assert.deepEqual([paused.requested, paused.changed, paused.already, paused.failed, paused.complete], [3, 3, 0, 0, true]);
  assert.equal(paused.membership_digest, managedMembershipDigest(members));
  assert.equal((await controlProject("P", "pause", { all: true }, f)).already, 3);
  assert.equal((await controlProject("P", "resume", { work: id(1) }, f)).changed, 1);
  assert.equal((await controlProject("P", "resume", { work: id(1) }, f)).already, 1);
  assert.equal((await controlProject("P", "stop", { all: true }, f)).changed, 3);
  const before = await getSupervisor(id(1), f);
  assert.equal((await controlProject("P", "stop", { all: true }, f)).already, 3);
  assert.deepEqual(await getSupervisor(id(1), f), before, "idempotent stop does not rewrite the record");
  const resume = await controlProject("P", "resume", { all: true }, f);
  assert.equal(resume.failed, 3); assert.ok(resume.results.every(r => r.code === "SUPERVISOR_STOPPED"));
  assert.equal((await listRecords("supervisors", f)).length, 3, "no project supervisor is created");
});

test("project control preserves partial success, busy and missing bindings and retry semantics", async t => {
  const f = await fixture(t);
  await registerManagedThread(id(4), { projectId: "P", connection: "shared" }, f);
  const result = await withStoreLock(`supervisor-${id(2)}`, () => controlProject("P", "stop", { all: true }, f), f);
  assert.deepEqual([result.requested, result.changed, result.already, result.failed, result.complete], [4, 2, 0, 2, false]);
  assert.equal(result.results.find(r => r.thread_id === id(2)).code, "RECORD_BUSY");
  assert.equal(result.results.find(r => r.thread_id === id(4)).code, "SUPERVISOR_NOT_REGISTERED");
  const retry = await controlProject("P", "stop", { all: true }, f);
  assert.deepEqual([retry.changed, retry.already, retry.failed], [1, 2, 1]);
  assert.equal(retry.membership_digest, result.membership_digest);
  assert.equal((await controlProject("P", "stop", { work: id(1) }, f)).membership_digest, managedMembershipDigest([(await listManagedThreads("P", f))[0]]));
});

test("a dispatch barrier makes stop busy until its receipt, and acknowledged stop prevents later effects", async t => {
  const f = await fixture(t, 1), entered = barrier(), release = barrier(); let effects = 0;
  const pending = dispatchExternalEffect(id(1), session(1), "local-spawn", async () => { entered.release(); await release.promise; effects++; }, f);
  await entered.promise;
  const busy = await controlProject("P", "stop", { all: true }, f); assert.equal(busy.failed, 1); assert.equal(busy.results[0].code, "RECORD_BUSY");
  release.release(); await pending;
  assert.equal((await controlProject("P", "stop", { all: true }, f)).changed, 1);
  await assert.rejects(dispatchExternalEffect(id(1), session(1), "local-spawn", () => { effects++; }, f), { code: "SUPERVISOR_STOPPED" });
  assert.equal(effects, 1);
});

test("target snapshot digest changes with membership and holds no project lock across supervisor control", async t => {
  const f = await fixture(t, 1), key = createHash("sha256").update("P").digest("hex").slice(0, 40);
  const entered = barrier(), release = barrier();
  const publication = withStoreLock(`project-sync-${key}`, async () => { entered.release(); await release.promise; }, f);
  await entered.promise;
  let result;
  try { result = await controlProject("P", "pause", { all: true }, f); }
  finally { release.release(); await publication; }
  assert.equal(result.changed, 1);
  await registerManagedThread(id(2), { projectId: "P", connection: "shared" }, f); await registerSupervisor(id(2), session(2), f);
  const next = await controlProject("P", "stop", { all: true }, f);
  assert.equal(next.requested, 2); assert.notEqual(next.membership_digest, result.membership_digest);
});

test("invalid scope and mismatched connection never mutate another work", async t => {
  const f = await fixture(t, 1);
  for (const options of [{}, { all: true, work: id(1) }]) await assert.rejects(controlProject("P", "stop", options, f), { code: "PROJECT_CONTROL_INVALID" });
  await assert.rejects(controlProject("P", "stop", { work: id(9) }, f), { code: "PROJECT_CONTROL_UNMANAGED" });
  const dc = "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000003";
  await registerManagedThread(dc, { projectId: "P", connection: "desktop-cloud", environmentConfigId: "fixture-config" }, f);
  await registerSupervisor(dc, session(2), { ...f, connection: "cloud" });
  const result = await controlProject("P", "pause", { work: dc }, f);
  assert.equal(result.results[0].code, "SUPERVISOR_MISMATCH"); assert.equal((await getSupervisor(dc, f)).state, "active");
  const cli = spawnSync(process.execPath, ["bin/codexteer.mjs", "--supervisor", session(1), "project", "control", "stop", "--project", "P", "--all", "--json"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } });
  assert.equal(JSON.parse(cli.stdout).error.code, "SUPERVISOR_CONTROL_FORBIDDEN");
  assert.equal((await getSupervisor(id(1), f)).state, "active");
  const correct = "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000004";
  await registerManagedThread(correct, { projectId: "P", connection: "desktop-cloud", environmentConfigId: "fixture-config" }, f);
  await registerSupervisor(correct, session(3), { ...f, connection: "desktop-cloud" });
  assert.equal((await controlProject("P", "pause", { work: correct }, f)).changed, 1);
  assert.equal((await getSupervisor(correct, f)).state, "paused");
});

test("local and Desktop Cloud CLI return partial results with nonzero exit and ok:false", async t => {
  for (const connection of ["shared", "desktop-cloud"]) {
    const f = await fixture(t, 2);
    const result = await withStoreLock(`supervisor-${id(2)}`, async () => spawnSync(process.execPath,
      ["bin/codexteer.mjs", "--connection", connection, "project", "control", "stop", "--project", "P", "--all", "--json"],
      { encoding: "utf8", env: { ...process.env, CODEX_HOME: f.home } }), f);
    assert.equal(result.status, 1); const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false); assert.equal(output.data.changed, 1); assert.equal(output.data.failed, 1);
    assert.equal(output.data.results.find(r => r.thread_id === id(2)).code, "RECORD_BUSY");
  }
});
