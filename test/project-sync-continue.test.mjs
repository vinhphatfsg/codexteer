import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread } from "../src/project-index.mjs";
import { registerSupervisor } from "../src/supervision.mjs";
import { syncProject } from "../src/project-sync.mjs";

const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, session = n => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const MEMBERS = 84;

// Every member reports once, so the first result needs many pages.
async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-continue-")); t.after(() => rm(home, { recursive: true, force: true }));
  const storage = { home };
  for (let n = 1; n <= MEMBERS; n++) {
    await registerManagedThread(uuid(n), { projectId: "P", connection: "shared", syncCursor: "c0" }, storage);
    await registerSupervisor(uuid(n), session(n), storage);
  }
  const read = async (id, options) => ({ thread_id: id, cursor: "c1", has_more: false, title: `work ${id.slice(-2)}`, status: "idle", attention: [],
    latest_turn_id: "turn", latest_turn_status: "completed", active_turn_count: 0,
    events: options.since === "c0" ? [{ id: "report", type: "agentMessage", text: `report of ${id} `.repeat(20) }] : [] });
  const first = await syncProject("P", {}, { storage, read });
  const cli = (connection, args) => {
    const result = spawnSync(process.execPath, ["bin/codexteer.mjs", ...connection, ...args],
      { cwd: new URL("../", import.meta.url), env: { ...process.env, CODEX_HOME: home }, encoding: "utf8" });
    return { status: result.status, ...JSON.parse(result.stdout) };
  };
  return { first, cli };
}

for (const connection of [[], ["--connection", "desktop-cloud"]]) {
  const name = connection.length ? "Desktop Cloud CLI" : "local CLI";

  test(`${name}: a continuation without both offsets is refused instead of repeating the first page`, async t => {
    const f = await fixture(t), token = f.first.continuation_token;
    assert.ok(f.first.works.length < MEMBERS && token, "the first page leaves members for a continuation");
    for (const offsets of [[], ["--offset", String(f.first.next_offset)], ["--event-offset", "0"]]) {
      const refused = f.cli(connection, ["project", "sync", "--continue", token, ...offsets, "--json"]);
      assert.equal(refused.ok, false, `${offsets.join(" ") || "no offsets"} must not return a page`); assert.notEqual(refused.status, 0);
      assert.equal(refused.error.code, "PROJECT_SYNC_OFFSET_REQUIRED");
      assert.match(refused.error.message, /--offset.*--event-offset.*next_offset.*next_event_offset/);
    }
    const again = f.cli(connection, ["project", "sync", "--continue", token, "--offset", "0", "--event-offset", "0", "--json"]);
    assert.equal(again.status, 0); assert.deepEqual(again.data.works, f.first.works, "naming the start reads the first page again");
  });

  test(`${name}: each page names the exact next call, and following it reads every member once`, async t => {
    const f = await fixture(t), seen = f.first.works.map(work => work.thread_id);
    let page = f.first, pages = 1;
    while (page.continuation_token) {
      assert.equal(page.continuation_command, `codexteer project sync --continue ${page.continuation_token} --offset ${page.next_offset} --event-offset ${page.next_event_offset} --json`);
      const next = f.cli(connection, page.continuation_command.split(" ").slice(1));
      assert.equal(next.status, 0, JSON.stringify(next.error));
      assert.equal(next.data.continuation_offset, page.next_offset, "the page starts where the one before it ended");
      page = next.data; pages++; seen.push(...page.works.map(work => work.thread_id));
      assert.ok(pages <= MEMBERS, "the continuation advances");
    }
    assert.equal(page.continuation_command, null, "the last page has no next call");
    assert.deepEqual(seen, Array.from({ length: MEMBERS }, (_, n) => uuid(n + 1)));
    assert.ok(pages > 2);
  });
}
