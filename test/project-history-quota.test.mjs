import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread, getManagedThread, updateManagedThreadCursor } from "../src/project-index.mjs";
import { syncProject, projectEvent, continueProjectSync } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";
import { readRecord, writeRecord, recordStats } from "../src/store.mjs";

const MiB = 1024 * 1024, A = "11111111-1111-4111-8111-000000000001", project = "P";
const headKey = createHash("sha256").update(project).digest("hex").slice(0, 40);
const buckets = ["project-sync-events", "project-sync-results", "work-starts"];
// A member whose cursor another sync advances mid-publication keeps a row that
// differs from the advanced one by a few fields; the check allows for either.
const SLACK = 256;
const shapes = {
  "few large events": Array.from({ length: 8 }, (_, i) => ({ id: `cmd-${i}`, turn_id: "turn-1", type: "commandExecution", command: "make test", status: "completed", exit_code: 0, output: "x".repeat(256 * 1024) })),
  "many short events": Array.from({ length: 600 }, (_, i) => ({ id: `msg-${i}`, turn_id: "turn-1", type: "agentMessage", text: "y".repeat(120) })),
};

async function fixture(t, events = []) {
  const home = await mkdtemp(tempPrefix("ct-quota-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home }, f = { home, storage, events: [...events], onRead: null };
  await registerManagedThread(A, { projectId: project, connection: "shared", syncCursor: "c0" }, storage);
  f.read = async (id, options) => {
    await f.onRead?.(options);
    return { thread_id: id, cursor: `c${f.events.length}`, events: f.events.slice(Number(options.since.slice(1))), has_more: false, title: "work",
      status: "idle", attention: [], latest_turn_id: "turn-1", latest_turn_status: "completed", active_turn_count: 0 };
  };
  f.dependencies = { storage, read: f.read, pollMs: 5, processIdentity: async pid => pid === 123 ? "owner-start" : "same-start",
    orchestratorIdentity: async () => ({ pid: 123, process_start: "owner-start" }) };
  f.sync = () => syncProject(project, {}, f.dependencies);
  f.used = async () => (await Promise.all(buckets.map(bucket => recordStats(bucket, storage)))).flat().reduce((sum, row) => sum + row.bytes, 0);
  f.state = async () => ({ used: await f.used(), files: (await Promise.all(buckets.map(bucket => recordStats(bucket, storage)))).map(rows => rows.length),
    member: await getManagedThread(A, storage), head: await readRecord("project-sync-heads", headKey, storage) });
  // Another project's history: this project's prune never removes it.
  f.fill = async total => {
    for (let left = total; left > 0; left -= MiB) await writeRecord("project-sync-events", randomUUID(), { schema: 1, project_id: "OTHER", sync_token: randomUUID(), thread_id: "other",
      event: { id: "old", type: "agentMessage", text: "z".repeat(Math.min(left, MiB)) } }, storage);
  };
  f.free = async bytes => { storage.historyLimitBytes = await f.used() + bytes; };
  return f;
}
// What one publication writes, measured where nothing limits it.
async function growth(t, prepare, publish = f => f.sync()) {
  const f = await fixture(t); await prepare(f);
  const before = await f.used(); await publish(f);
  return await f.used() - before;
}
async function published(f, page, free, before) {
  const head = await readRecord("project-sync-heads", headKey, f.storage);
  assert.equal(head.sync_token, page.sync_token); assert.equal(head.publication_pending, undefined);
  assert.equal((await continueProjectSync(page.sync_token, {}, f.storage)).sync_token, page.sync_token);
  for (const work of page.works) assert.equal((await projectEvent(work.detail_token, f.storage)).event.type, "workDetails");
  assert.ok(await f.used() - before.used <= free, "the publication stays inside the free space");
}

for (const [shape, events] of Object.entries(shapes)) {
  test(`a sync and a wait publish ${shape} whenever the records fit in the free space`, async t => {
    const runs = { sync: f => f.sync(), wait: async f => (await waitProject(project, { timeoutMs: 0 }, f.dependencies)).sync };
    for (const [run, publish] of Object.entries(runs)) {
      const need = await growth(t, f => { f.events = [...events]; }, publish);
      for (const filled of [0, 3 * MiB, 9 * MiB]) {
        const f = await fixture(t, events); await f.fill(filled); await f.free(need + SLACK);
        const before = await f.state(), page = await publish(f);
        assert.equal(page.complete, true, `${run} at ${filled} bytes used`);
        assert.equal(await f.used() - before.used, need);
        assert.equal((await getManagedThread(A, f.storage)).sync_cursor, `c${events.length}`);
        await published(f, page, need + SLACK, before);
      }
    }
  });

  test(`a publication of ${shape} that does not fit is refused before anything is written`, async t => {
    const need = await growth(t, f => { f.events = [...events]; });
    const f = await fixture(t, events); await f.fill(2 * MiB); await f.free(need - 1);
    const before = await f.state();
    for (const attempt of [1, 2]) {
      const error = await f.sync().catch(error => error);
      assert.equal(error.code, "PROJECT_HISTORY_LIMIT", `attempt ${attempt}`);
      assert.equal(error.storage_bytes, before.used); assert.equal(error.limit_bytes, before.used + need - 1);
      assert.ok(error.required_bytes >= need && error.required_bytes <= need + SLACK, `required ${error.required_bytes} for ${need} bytes of records`);
      assert.deepEqual(await f.state(), before, "no record, cursor or head changed");
    }
    await assert.rejects(waitProject(project, { timeoutMs: 0 }, f.dependencies), { code: "PROJECT_HISTORY_LIMIT" });
    assert.deepEqual(await f.state(), before);
    await f.free(need + SLACK);
    assert.equal((await f.sync()).complete, true, "the same sync publishes once the records fit");
  });
}

test("a publication is published in full or not at all when another sync moves a cursor while it publishes", async t => {
  const questions = Array.from({ length: 30 }, (_, i) => ({ id: `q-${i}`, turn_id: "turn-1", type: "agentMessage", text: "Which one? ".repeat(40), questions: ["Which?"] }));
  // The answer resolves every question, unless the cursor is refused: then the
  // row keeps them all and is larger than the row of an advanced cursor.
  const prepare = move => async f => {
    f.events = [...questions]; await f.sync();
    f.events.push({ id: "answer", turn_id: "turn-1", type: "userMessage", text: "The first." });
    let reads = 0;
    if (move) f.onRead = async () => {
      if (++reads !== 2) return;
      const member = await getManagedThread(A, f.storage);
      await updateManagedThreadCursor(A, member.sync_cursor, "moved", f.storage, member.sync_revision);
    };
  };
  const advanced = await growth(t, prepare(false)), refused = await growth(t, prepare(true));
  assert.ok(refused > advanced + 4096, "a refused cursor makes this publication larger");
  let fits = 0;
  for (const free of [advanced - 1, advanced, advanced + SLACK, refused - 1, refused, refused + SLACK]) {
    const f = await fixture(t); await prepare(true)(f); await f.free(free);
    const before = await f.state(), page = await f.sync().catch(error => error);
    if (page instanceof Error) {
      assert.equal(page.code, "PROJECT_HISTORY_LIMIT", `${free - advanced} bytes over the smaller size`);
      const after = await f.state();
      assert.deepEqual({ ...after, member: null }, { ...before, member: null }, "a refused publication wrote no record and no head");
      assert.equal(after.member.sync_revision, before.member.sync_revision + 1, "only the other sync moved the cursor");
    } else {
      fits++; assert.equal(page.works[0].error, "SYNC_CURSOR_CONFLICT"); assert.equal(page.omitted_events + page.works[0].events.length, questions.length + 1);
      await published(f, page, free, before);
    }
  }
  assert.ok(fits >= 1, "the publication fits once its larger form does");
});
