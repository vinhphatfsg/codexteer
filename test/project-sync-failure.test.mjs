import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { completedCloudThread } from "../test-support/fixtures/desktop-cloud-completed.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { readSnapshot } from "../src/observe.mjs";
import { syncProject } from "../src/project-sync.mjs";
import { readRecord, writeRecord } from "../src/store.mjs";
const key = createHash("sha256").update("failure-fixture").digest("hex").slice(0, 40);
async function fixture(t, thread = completedCloudThread(), consumed = false) {
  const home = await mkdtemp(tempPrefix("ct-failure-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, cursor = readSnapshot(consumed ? thread : { ...thread, turns: [] }).cursor;
  await registerManagedThread(thread.id, { projectId: "failure-fixture", connection: "desktop-cloud", environmentConfigId: "fixture-config", syncCursor: cursor }, storage);
  return { storage, thread, read: async (_id, options) => readSnapshot(thread, options) };
}

test("a completed Desktop Cloud turn keeps nonzero command outcomes without treating them as worker failures", async t => {
  const f = await fixture(t), result = await syncProject("failure-fixture", {}, f);
  assert.equal(result.complete, true); assert.equal(result.works[0].attention, "review");
  assert.notEqual(result.works[0].group, "対応が必要");
  assert.ok(result.works[0].events.some(e => e.event_id === "search"));
  assert.ok(result.works[0].events.some(e => e.event_id === "probe"));
  assert.deepEqual((await readRecord("project-sync-heads", key, f.storage)).unresolved_attention, {});
  assert.equal((await syncProject("failure-fixture", {}, f)).works[0].attention, "review");
});

test("actual failed turns and explicit backend failures still require attention", async t => {
  for (const kind of ["turn", "systemError", "failed"]) {
    const thread = completedCloudThread();
    if (kind === "turn") thread.turns[0].status = "failed";
    else thread.status.type = kind;
    const f = await fixture(t, thread), result = await syncProject("failure-fixture", {}, f);
    assert.equal(result.works[0].attention, "failure", kind); assert.equal(result.works[0].group, "対応が必要", kind);
  }
});

test("unknown backend state, missing attention and incomplete reads stay unknown", async t => {
  for (const kind of ["status", "attention", "incomplete"]) {
    const thread = completedCloudThread();
    thread.status = kind === "status" ? { type: "unknown", activeFlags: [] } : kind === "attention" ? { type: "active" } : thread.status;
    const f = await fixture(t, thread);
    if (kind === "incomplete") f.read = async () => { throw Object.assign(new Error("unavailable"), { code: "THREAD_NOT_FOUND" }); };
    const result = await syncProject("failure-fixture", {}, f);
    assert.equal(result.works[0].attention, "unknown", kind); assert.equal(result.works[0].group, "未確認", kind);
  }
});

test("persisted proven command-only false positives are reclassified without resolving questions or turn failures", async t => {
  for (const remaining of [null, "human", "failure", "unknown"]) {
    const f = await fixture(t, completedCloudThread(), true);
    const entries = [["search", { attention: "failure", reason: { failure_event: true }, events: [{ token: "11111111-1111-4111-8111-000000000001", type: "commandExecution" }] }]];
    if (remaining) entries.push(["real", { attention: remaining === "unknown" ? "failure" : remaining, reason: { [remaining === "human" ? "question_event" : "failure_event"]: true }, events: [{ token: "22222222-2222-4222-8222-000000000002", type: remaining === "human" ? "agentMessage" : remaining === "failure" ? "turn" : "unknown", status: "failed" }] }]);
    await writeRecord("project-sync-heads", key, { sync_token: "previous", unresolved_attention: { [f.thread.id]: { attention: "failure", entries } } }, f.storage);
    const result = await syncProject("failure-fixture", {}, f);
    assert.equal(result.works[0].attention, remaining ?? "review");
    const head = await readRecord("project-sync-heads", key, f.storage);
    assert.equal(head.unresolved_attention[f.thread.id]?.entries.some(([id]) => id === "search") ?? false, false);
    if (remaining) assert.ok(result.works[0].events.some(e => e.token === entries[1][1].events[0].token));
  }
});
