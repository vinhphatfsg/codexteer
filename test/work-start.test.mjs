import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink, rename } from "node:fs/promises";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { startWork, readRepositoryPolicy, composeWorkOrder } from "../src/work-start.mjs";
import { getManagedThread } from "../src/project-index.mjs";
import { getSupervisor } from "../src/supervision.mjs";
import { acquireResource, resourceStatus } from "../src/resource.mjs";
import { listRecords } from "../src/store.mjs";
import { historyBucket } from "../src/project-history.mjs";

const THREAD = "11111111-1111-4111-8111-555555555555";
async function fixture(t, policy = "方針 ${notExpanded} $(also_not_expanded)\r\n末尾\n") {
  const root = await mkdtemp(tempPrefix("ct-work-root-")), home = await mkdtemp(tempPrefix("ct-work-home-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  if (policy !== null) await writeFile(path.join(root, "CODEXTEER.md"), policy);
  const counts = { create: 0, read: 0 }, deps = { storage: { home },
    create: async input => { counts.create++; return { thread_id: THREAD, project_id: input.project, attempt_id: input.attemptId }; },
    reconcile: async record => ({ thread_id: THREAD, backend_project_id: "project-one", attempt_id: record.attempt_id, prompt_sha256: record.prompt_sha256 }),
    read: async () => { counts.read++; return { cursor: "cursor-one", status: "active", has_more: false, omitted_older_events: 0 }; } };
  return { root, home, counts, deps };
}

test("policy bytes occur exactly once without interpolation and absence is explicit", async t => {
  const f = await fixture(t), policy = await readRepositoryPolicy(f.root), prompt = composeWorkOrder("実装する", policy);
  assert.equal(prompt.split(policy.text).length - 1, 1); assert.match(prompt, /\$\{notExpanded\} \$\(also_not_expanded\)/);
  assert.equal(policy.sha256.length, 64);
  const missing = await fixture(t, null), result = await startWork({ project: "project-one", title: "モデル名なし", order: "実装する", root: missing.root }, missing.deps);
  assert.equal(result.policy.present, false);
  const records = await import("../src/store.mjs").then(m => m.listRecords(historyBucket("work-starts", "project-one"), { home: missing.home }));
  assert.match(records[0].prompt, /No repository policy file was found/);
  assert.doesNotMatch(records[0].prompt, /Claude|GPT|Gemini/);
});

test("policy rejects symlinks, special files, oversized content, and invalid UTF-8", async t => {
  const f = await fixture(t, null), target = path.join(f.root, "real"); await writeFile(target, "x"); await symlink(target, path.join(f.root, "CODEXTEER.md"));
  await assert.rejects(readRepositoryPolicy(f.root), { code: "POLICY_FILE_UNSAFE" }); await rm(path.join(f.root, "CODEXTEER.md"));
  await writeFile(path.join(f.root, "CODEXTEER.md"), Buffer.alloc(65537)); await assert.rejects(readRepositoryPolicy(f.root), { code: "POLICY_FILE_TOO_LARGE" });
  await writeFile(path.join(f.root, "CODEXTEER.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x78])); await assert.rejects(readRepositoryPolicy(f.root), { code: "POLICY_FILE_ENCODING" });
  await writeFile(path.join(f.root, "CODEXTEER.md"), Buffer.from([0xc3, 0x28])); await assert.rejects(readRepositoryPolicy(f.root), { code: "POLICY_FILE_ENCODING" });
});

test("policy same-FD read rejects a pathname replaced by a symlink after open", async t => {
  const f = await fixture(t), file = path.join(f.root, "CODEXTEER.md"), old = path.join(f.root, "old"), target = path.join(f.root, "target");
  await writeFile(target, "replacement");
  await assert.rejects(readRepositoryPolicy(f.root, { afterOpen: async () => { await rename(file, old); await symlink(target, file); } }), { code: "POLICY_FILE_CHANGED" });
});

test("concurrent identical starts create one child and persist supervision, membership, and cursor", async t => {
  const f = await fixture(t), input = { project: "project-one", title: "担当", order: "実装する", root: f.root };
  const settled = await Promise.allSettled([startWork(input, f.deps), startWork(input, f.deps)]);
  const fulfilled = settled.filter(row => row.status === "fulfilled"), rejected = settled.filter(row => row.status === "rejected");
  assert.equal(fulfilled.length, 1); assert.equal(rejected.length, 1); assert.equal(rejected[0].reason.code, "RECORD_BUSY");
  assert.equal(fulfilled[0].value.stage, "observed"); assert.equal(f.counts.create, 1);
  assert.equal((await getSupervisor(THREAD, { home: f.home })).state, "active");
  assert.equal((await getManagedThread(THREAD, { home: f.home })).sync_cursor, undefined);
});

test("membership is visible before supervisor binding and mutations fail closed in that window", async t => {
  const f = await fixture(t); let checked = false;
  f.deps.hook = async name => {
    if (name !== "membership_registered") return;
    checked = true;
    await assert.rejects(acquireResource("window", { owner: "fixture", threadId: THREAD, connection: "shared", home: f.home }), { code: "MANAGED_SUPERVISOR_REQUIRED" });
    assert.equal((await resourceStatus("window", { home: f.home })).state, "available");
  };
  const result = await startWork({ project: "project-one", title: "登録順", order: "実装する", root: f.root }, f.deps);
  assert.equal(checked, true); assert.equal(result.stage, "observed");
});

test("a lost create response is reconciled read-only and never dispatched twice", async t => {
  const f = await fixture(t), original = f.deps.create; let first = true, reconciles = 0;
  f.deps.create = async input => { const created = await original(input); if (first) { first = false; throw Object.assign(new Error("receipt lost"), { code: "CONNECTION_FAILED" }); } return created; };
  f.deps.reconcile = async record => { reconciles++; return { thread_id: THREAD, backend_project_id: "project-one", attempt_id: record.attempt_id, prompt_sha256: record.prompt_sha256 }; };
  const input = { project: "project-one", title: "応答不明", order: "実装する", root: f.root };
  await assert.rejects(startWork(input, f.deps), { code: "CONNECTION_FAILED" });
  const result = await startWork(input, f.deps); assert.equal(result.stage, "observed");
  assert.equal(f.counts.create, 1); assert.equal(reconciles, 1);
});

test("successful reconciliation clears failure metadata before persisting the known child", async t => {
  for (const knownThread of [false, true]) {
    const f = await fixture(t), original = f.deps.create, input = { project: "project-one", title: "recovered", order: "implement", root: f.root };
    f.deps.create = async value => {
      await original(value);
      throw Object.assign(new Error("response lost"), { code: "CONNECTION_FAILED", creation_dispatched: true,
        creation_status: knownThread ? "created" : "unknown", sent: false, ...(knownThread ? { thread_id: THREAD } : {}) });
    };
    await assert.rejects(startWork(input, f.deps), { code: "CONNECTION_FAILED", stage: "create_unknown" });
    const [failed] = await listRecords(historyBucket("work-starts", "project-one"), f.deps.storage);
    for (const key of ["create_error", "create_failure", "known_thread_id"]) assert.equal(Object.hasOwn(failed, key), true);
    const reconcile = f.deps.reconcile;
    f.deps.reconcile = async () => null;
    await assert.rejects(startWork(input, f.deps), { code: "WORK_CREATE_UNKNOWN" });
    assert.deepEqual((await listRecords(historyBucket("work-starts", "project-one"), f.deps.storage))[0], failed);
    f.deps.reconcile = reconcile;
    f.deps.hook = async name => { if (name === "membership_registered") throw Object.assign(new Error("interrupted"), { code: "INJECTED_CRASH" }); };
    await assert.rejects(startWork(input, f.deps), { code: "INJECTED_CRASH" });
    const [recovered] = await listRecords(historyBucket("work-starts", "project-one"), f.deps.storage);
    assert.equal(recovered.stage, "child_known"); assert.equal(recovered.thread_id, THREAD);
    for (const key of ["create_error", "create_failure", "known_thread_id"]) assert.equal(Object.hasOwn(recovered, key), false);
    delete f.deps.hook;
    const result = await startWork(input, f.deps);
    assert.equal(result.stage, "observed"); assert.equal(result.attempt_id, failed.attempt_id);
    assert.equal(f.counts.create, 1);
  }
});

test("only explicit and consistent pre-dispatch proof permits another creation call", async t => {
  const proof = { creation_status: "not_created", creation_dispatched: false, sent: false };
  for (const fields of [proof, { ...proof, creation_dispatched: undefined }, { ...proof, creation_status: undefined },
    { ...proof, sent: undefined }, { ...proof, creation_dispatched: true }, { ...proof, creation_status: "unknown" },
    { ...proof, creation_status: "created" }, { ...proof, sent: true }, { ...proof, thread_id: THREAD }, {}]) {
    const f = await fixture(t), input = { project: "project-one", title: "proof", order: "implement", root: f.root }, original = f.deps.create;
    const code = fields === proof ? "ARBITRARY_PREFLIGHT_FAILURE" : "DESKTOP_PERMISSION_UNVERIFIED";
    f.deps.create = async () => { throw Object.assign(new Error("blocked"), { code, ...fields }); };
    f.deps.reconcile = async () => null;
    await assert.rejects(startWork(input, f.deps), { code });
    const [before] = await listRecords(historyBucket("work-starts", "project-one"), f.deps.storage);
    f.deps.create = original;
    if (fields === proof) {
      assert.equal(before.stage, "create_not_dispatched");
      const result = await startWork(input, f.deps);
      assert.equal(result.attempt_id, before.attempt_id); assert.equal(result.stage, "observed");
      const [after] = await listRecords(historyBucket("work-starts", "project-one"), f.deps.storage);
      for (const key of ["create_error", "create_failure", "known_thread_id"]) assert.equal(Object.hasOwn(after, key), false);
    } else {
      assert.equal(before.stage, "create_unknown");
      await assert.rejects(startWork(input, f.deps), { code: "WORK_CREATE_UNKNOWN" });
      assert.equal(f.counts.create, 0);
    }
  }
});

test("reconciliation rejects ambiguous, mismatched, and malformed candidates", async t => {
  for (const [name, candidate, code] of [
    ["ambiguous", record => [{ thread_id: THREAD, backend_project_id: record.project_id, attempt_id: record.attempt_id, prompt_sha256: record.prompt_sha256 }, { thread_id: "11111111-1111-4111-8111-777777777777", backend_project_id: record.project_id, attempt_id: record.attempt_id, prompt_sha256: record.prompt_sha256 }], "WORK_RECONCILE_CONFLICT"],
    ["project", record => ({ thread_id: THREAD, backend_project_id: "wrong", attempt_id: record.attempt_id, prompt_sha256: record.prompt_sha256 }), "WORK_RECONCILE_MISMATCH"],
    ["digest", record => ({ thread_id: THREAD, backend_project_id: record.project_id, attempt_id: record.attempt_id, prompt_sha256: "0".repeat(64) }), "WORK_RECONCILE_MISMATCH"],
    ["malformed", () => ({ thread_id: THREAD }), "WORK_RECONCILE_MISMATCH"],
  ]) {
    const f = await fixture(t), input = { project: "project-one", title: `reconcile ${name}`, order: "実装する", root: f.root };
    f.deps.create = async value => { await f.deps.storage; throw Object.assign(new Error("lost"), { code: "CONNECTION_FAILED" }); };
    await assert.rejects(startWork(input, f.deps), { code: "CONNECTION_FAILED" }); f.deps.reconcile = candidate;
    await assert.rejects(startWork(input, f.deps), { code });
  }
});

test("initial observation refuses a non-advancing cursor", async t => {
  const f = await fixture(t); f.deps.read = async () => ({ cursor: "same", status: "active", has_more: true, omitted_older_events: 0 });
  await assert.rejects(startWork({ project: "project-one", title: "stalled", order: "実装する", root: f.root }, f.deps), { code: "WORK_INITIAL_READ_STALLED" });
});

test("work start never replaces a stopped managed supervisor", async t => {
  const f = await fixture(t), input = { project: "project-one", title: "stopped", order: "実装する", root: f.root };
  f.deps.hook = async name => { if (name === "membership_registered") { const { registerSupervisor, controlSupervisor } = await import("../src/supervision.mjs"); await registerSupervisor(THREAD, "22222222-2222-4222-8222-999999999999", { home: f.home, owner: "fixture", connection: "shared" }); await controlSupervisor(THREAD, "stop", { home: f.home }); } };
  await assert.rejects(startWork(input, f.deps), { code: "MANAGED_SUPERVISOR_STOPPED" });
  assert.equal((await getSupervisor(THREAD, { home: f.home })).state, "stopped");
});

for (const boundary of ["attempt_saved", "before_create_rpc", "create_returned", "child_saved", "membership_registered", "index_updated", "supervisor_registered", "initial_read"]) {
  test(`fault recovery at ${boundary} never creates more than one child`, async t => {
    const f = await fixture(t), input = { project: "project-one", title: `担当 ${boundary}`, order: "実装する", root: f.root };
    let crashed = false; f.deps.hook = async name => { if (!crashed && name === boundary) { crashed = true; throw Object.assign(new Error("crash"), { code: "INJECTED_CRASH" }); } };
    await assert.rejects(startWork(input, f.deps), { code: "INJECTED_CRASH" }); delete f.deps.hook;
    const result = await startWork(input, f.deps); assert.equal(result.stage, "observed"); assert.ok(f.counts.create <= 1, `${boundary}: ${f.counts.create}`);
  });
}

test("stop after work-start preflight is atomically rejected inside supervisor registration", async t => {
  const f = await fixture(t), { registerSupervisor, controlSupervisor } = await import("../src/supervision.mjs");
  let arrived, release;
  const entered = new Promise(r => { arrived = r; }), barrier = new Promise(r => { release = r; });
  f.deps.hook = async name => { if (name === "before_supervisor_registration") { arrived(); await barrier; } };
  const pending = startWork({ project: "project-one", title: "atomic stop", order: "implement", root: f.root }, f.deps);
  const checked = assert.rejects(pending, { code: "MANAGED_SUPERVISOR_STOPPED" });
  await entered;
  await registerSupervisor(THREAD, "22222222-2222-4222-8222-999999999999", { home: f.home });
  await controlSupervisor(THREAD, "stop", { home: f.home });
  release(); await checked;
  assert.equal((await getSupervisor(THREAD, { home: f.home })).state, "stopped");
});
