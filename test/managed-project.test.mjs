import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread, getManagedThread, listManagedThreads } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor, getSupervisor } from "../src/supervision.mjs";
import { sendTrackedMessage } from "../src/journal.mjs";
import { acquireResource, resourceStatus } from "../src/resource.mjs";
import { createCheckpoint } from "../src/checkpoint.mjs";

const ACTIVE = "11111111-1111-4111-8111-111111111111";
const PAUSED = "22222222-2222-4222-8222-222222222222";
const STOPPED = "33333333-3333-4333-8333-333333333333";
const UNMANAGED = "11111111-1111-4111-8111-444444444444";
const sessions = {
  [ACTIVE]: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  [PAUSED]: "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb",
  [STOPPED]: "aaaaaaaa-aaaa-4aaa-8aaa-cccccccccccc",
};

async function fixture(t) {
  const home = await mkdtemp(tempPrefix("ct-managed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const threadId of [ACTIVE, PAUSED, STOPPED]) {
    await registerManagedThread(threadId, { projectId: "project-fixture", backendProjectId: "desktop-project", connection: "shared", creationAttemptId: `attempt-${threadId}` }, { home });
    await registerSupervisor(threadId, sessions[threadId], { owner: "fixture", connection: "shared", home });
  }
  await controlSupervisor(PAUSED, "pause", { home });
  await controlSupervisor(STOPPED, "stop", { home });
  return { home };
}

const accepted = counter => async (_thread, _message, options) => {
  await options.beforeSend?.(); counter.count++;
  return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-fixture" };
};

test("thin project membership stores route data without duplicating supervisor state", async t => {
  const { home } = await fixture(t), record = await getManagedThread(ACTIVE, { home });
  assert.equal(record.thread_id, ACTIVE); assert.equal(record.project_id, "project-fixture"); assert.equal(record.connection, "shared");
  for (const field of ["state", "supervisor_state", "session_id", "generation"]) assert.equal(Object.hasOwn(record, field), false);
  assert.deepEqual((await listManagedThreads("project-fixture", { home })).map(row => row.thread_id), [ACTIVE, PAUSED, STOPPED]);
});

test("raw sends bind managed active tasks, reject paused/stopped tasks, and leave unmanaged sends unchanged", async t => {
  const { home } = await fixture(t), counter = { count: 0 }, send = accepted(counter);
  const active = await sendTrackedMessage(ACTIVE, "active", { connection: "shared" }, { home, send });
  assert.equal(active.delivery_status, "accepted"); assert.equal(counter.count, 1);
  await assert.rejects(sendTrackedMessage(PAUSED, "paused", { connection: "shared" }, { home, send }), { code: "SUPERVISOR_PAUSED" });
  await assert.rejects(sendTrackedMessage(PAUSED, "paused new turn", { connection: "shared", newTurn: true }, { home, send }), { code: "SUPERVISOR_PAUSED" });
  await assert.rejects(sendTrackedMessage(STOPPED, "stopped", { connection: "shared" }, { home, send }), { code: "SUPERVISOR_STOPPED" });
  assert.equal(counter.count, 1, "refused managed sends never reach delivery");
  const unmanaged = await sendTrackedMessage(UNMANAGED, "legacy", { connection: "shared" }, { home, send });
  assert.equal(unmanaged.delivery_status, "accepted"); assert.equal(counter.count, 2);
  assert.equal((await getSupervisor(STOPPED, { home })).state, "stopped", "implicit mutation never replaces a stopped supervisor");
});

test("other thread-bound mutations use the managed supervisor boundary", async t => {
  const { home } = await fixture(t), input = path.join(home, "input.txt"); await writeFile(input, "fixture");
  await assert.rejects(acquireResource("paused-resource", { owner: "fixture", threadId: PAUSED, connection: "shared", home }), { code: "SUPERVISOR_PAUSED" });
  assert.equal((await resourceStatus("paused-resource", { home })).state, "available");
  await assert.rejects(createCheckpoint(PAUSED, "paused-checkpoint", { paths: [input], connection: "shared", home }), { code: "SUPERVISOR_PAUSED" });
  await assert.rejects(createCheckpoint(STOPPED, "stopped-checkpoint", { paths: [input], connection: "shared", home }), { code: "SUPERVISOR_STOPPED" });
});

test("pause/stop serialize with implicit managed delivery and acknowledged stop blocks later dispatch", async t => {
  const { home } = await fixture(t); let release, enteredResolve, dispatches = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const send = async (_thread, _message, options) => {
    enteredResolve(); await gate; await options.beforeSend?.(); dispatches++;
    return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId, turn_id: "turn-race" };
  };
  const pending = sendTrackedMessage(ACTIVE, "racing", { connection: "shared" }, { home, send });
  await entered;
  await assert.rejects(controlSupervisor(ACTIVE, "pause", { home }), { code: "RECORD_BUSY" });
  await assert.rejects(controlSupervisor(ACTIVE, "stop", { home }), { code: "RECORD_BUSY" });
  assert.equal((await getSupervisor(ACTIVE, { home })).state, "active", "busy control is not an acknowledgement");
  release(); await pending; assert.equal(dispatches, 1);
  assert.equal((await controlSupervisor(ACTIVE, "stop", { home })).state, "stopped");
  await assert.rejects(sendTrackedMessage(ACTIVE, "after stop", { connection: "shared" }, { home, send }), { code: "SUPERVISOR_STOPPED" });
  assert.equal(dispatches, 1, "no delivery starts after acknowledged stop");
});
