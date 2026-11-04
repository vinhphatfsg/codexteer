import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";
import { cloudConnection } from "../src/cloud-connection.mjs";
import { observeThread } from "../src/observe.mjs";
import { registerManagedThread, getManagedThread } from "../src/project-index.mjs";
import { syncProject, projectEvent } from "../src/project-sync.mjs";
import { waitProject } from "../src/project-wait.mjs";

const task = "task_fixture_wait", assistant = suffix => `${task}~assttrn_${suffix}`, user = suffix => `${task}~usertrn_${suffix}`;
const turn = (id, role, status, text = "") => ({ turn_id: id, role, status, commands: [], progress: [], messages: text ? [{ text }] : [] });

async function fixture(t, metadataOnly) {
  const home = await mkdtemp(tempPrefix("ct-wait-web-cloud-")); t.after(() => rm(home, { recursive: true, force: true }));
  const snapshot = { task_id: task, title: "Fixture", status: "in_progress", turn_id: assistant("first"), current_turn_id: assistant("first"),
    turns: [turn(user("first"), "user", null, "Initial order"), turn(assistant("first"), "assistant", "in_progress")] };
  const connection = cloudConnection({ read: async () => structuredClone(snapshot) });
  const read = async (id, options) => {
    const page = await observeThread(id, options, connection);
    // Also exercise the metadata fallback independently of the turn-event path.
    return metadataOnly ? { ...page, events: page.events.filter(event => event.type !== "turn") } : page;
  };
  const storage = { home }, dependencies = { storage, read, pollMs: 5, processIdentity: async () => "same-start" };
  await registerManagedThread(task, { projectId: "cloud-wait", connection: "cloud" }, storage);
  await syncProject("cloud-wait", {}, dependencies);
  return { snapshot, storage, dependencies, wait: () => waitProject("cloud-wait", { timeoutMs: 0 }, dependencies) };
}

for (const metadataOnly of [false, true]) for (const outcome of ["completed", "failed", "cancelled"]) {
  test(`Web Cloud ${metadataOnly ? "metadata" : "events"}: synthetic user completion does not wake wait; assistant ${outcome} does`, async t => {
    const f = await fixture(t, metadataOnly), before = await getManagedThread(task, f.storage);
    f.snapshot.turns.push(turn(user("followup"), "user", null, "Additional input"));
    const inputOnly = await f.wait();
    assert.equal(inputOnly.changed, false, "completed synthetic user turn is input, not worker completion");
    assert.equal(inputOnly.timed_out, true);
    assert.deepEqual(await getManagedThread(task, f.storage), before, "user input must not consume the reviewed baseline");
    f.snapshot.turns[1].status = outcome; f.snapshot.status = outcome;
    if (!metadataOnly) {
      // Keep the synthetic user as the latest turn: a real assistant end must
      // still be detected from its updated event when metadata points at input.
      f.snapshot.turns[1].messages.push({ text: "Assistant report" });
    } else {
      // Give the real execution the latest position to prove the independent
      // latest-turn fallback still wakes for actual assistant completion.
      f.snapshot.turns.push(turn(assistant("followup"), "assistant", outcome, "Assistant report"));
    }
    const ended = await f.wait();
    assert.equal(ended.changed, true); assert.equal(ended.reason, "work_changed"); assert.equal(ended.sync.complete, true);
    const report = ended.sync.works[0].events.find(event => event.type === "agentMessage");
    assert.equal((await projectEvent(report.token, f.storage)).event.text, "Assistant report");
    assert.equal((await f.wait()).timed_out, true, "assistant end is not returned twice");
  });
}
