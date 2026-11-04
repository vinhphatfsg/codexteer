import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { registerManagedThread, getManagedThread, listManagedThreads } from "../src/project-index.mjs";
import { registerSupervisor, controlSupervisor, getSupervisor, withSupervisedSend, dispatchExternalEffect } from "../src/supervision.mjs";
import { sendTrackedMessage } from "../src/journal.mjs";
import { acquireResource, resourceStatus } from "../src/resource.mjs";
import { createCheckpoint } from "../src/checkpoint.mjs";
import { sendDesktopUiMessage } from "../src/desktop-ui-send.mjs";

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

test("raw sends reject every managed task until work tell supplies freshness, while unmanaged sends remain compatible", async t => {
  const { home } = await fixture(t), counter = { count: 0 }, send = accepted(counter);
  for (const [thread, body, extra = {}] of [[ACTIVE, "active"], [PAUSED, "paused"], [PAUSED, "paused new turn", { newTurn: true }], [STOPPED, "stopped"]]) {
    await assert.rejects(sendTrackedMessage(thread, body, { connection: "shared", ...extra }, { home, send }), { code: "MANAGED_INTERVENTION_REQUIRED" });
  }
  for (const thread of [ACTIVE, PAUSED, STOPPED]) {
    await assert.rejects(sendTrackedMessage(thread, "supervisor bypass", { connection: "shared", supervisor: sessions[thread], basedOn: "cursor", finding: "finding", internal: true, workTell: true }, { home, send }), { code: "MANAGED_INTERVENTION_REQUIRED" });
  }
  assert.equal(counter.count, 0, "managed raw sends never reach delivery");
  const unmanaged = await sendTrackedMessage(UNMANAGED, "legacy", { connection: "shared" }, { home, send });
  assert.equal(unmanaged.delivery_status, "accepted"); assert.equal(counter.count, 1);
  assert.equal((await getSupervisor(STOPPED, { home })).state, "stopped", "implicit mutation never replaces a stopped supervisor");
});

test("other thread-bound mutations use the managed supervisor boundary", async t => {
  const { home } = await fixture(t), input = path.join(home, "input.txt"); await writeFile(input, "fixture");
  await assert.rejects(acquireResource("paused-resource", { owner: "fixture", threadId: PAUSED, connection: "shared", home }), { code: "SUPERVISOR_PAUSED" });
  assert.equal((await resourceStatus("paused-resource", { home })).state, "available");
  await assert.rejects(createCheckpoint(PAUSED, "paused-checkpoint", { paths: [input], connection: "shared", home }), { code: "SUPERVISOR_PAUSED" });
  await assert.rejects(createCheckpoint(STOPPED, "stopped-checkpoint", { paths: [input], connection: "shared", home }), { code: "SUPERVISOR_STOPPED" });
});

test("pause/stop serialize with managed delivery and acknowledged stop blocks later dispatch", async t => {
  const { home } = await fixture(t); let release, enteredResolve, dispatches = 0;
  const entered = new Promise(resolve => { enteredResolve = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const send = async () => { enteredResolve(); await gate; dispatches++; return { delivery_status: "accepted" }; };
  const pending = withSupervisedSend(ACTIVE, sessions[ACTIVE], send, { home, connection: "shared" });
  await entered;
  await assert.rejects(controlSupervisor(ACTIVE, "pause", { home }), { code: "RECORD_BUSY" });
  await assert.rejects(controlSupervisor(ACTIVE, "stop", { home }), { code: "RECORD_BUSY" });
  assert.equal((await getSupervisor(ACTIVE, { home })).state, "active", "busy control is not an acknowledgement");
  release(); await pending; assert.equal(dispatches, 1);
  assert.equal((await controlSupervisor(ACTIVE, "stop", { home })).state, "stopped");
  await assert.rejects(withSupervisedSend(ACTIVE, sessions[ACTIVE], send, { home, connection: "shared" }), { code: "SUPERVISOR_STOPPED" });
  assert.equal(dispatches, 1, "no delivery starts after acknowledged stop");
});

test("Desktop UI delivery rejects managed active paused stopped and new-turn routes before dispatch", async t => {
  const { home } = await fixture(t); let dispatches = 0; const send = async () => { dispatches++; return { sent: true }; };
  for (const [thread, options] of [[ACTIVE, {}], [PAUSED, { newTurn: true }], [STOPPED, {}]]) {
    await assert.rejects(sendDesktopUiMessage(thread, "message", { connection: "shared", ...options }, { home }, { send }), { code: "MANAGED_UI_UNSUPPORTED" });
  }
  assert.equal(dispatches, 0);
  await sendDesktopUiMessage(UNMANAGED, "legacy shorthand", { connection: "shared", newTurn: true }, { home }, { send });
  assert.equal(dispatches, 1);
});

test("managed paired command/exec is unsupported without an acceptance receipt", async t => {
  const { home } = await fixture(t); let dispatches = 0;
  await assert.rejects(dispatchExternalEffect(ACTIVE, undefined, "paired-command", async () => { dispatches++; }, { home, connection: "shared" }), { code: "MANAGED_PAIRED_COMMAND_UNSUPPORTED" });
  assert.equal(dispatches, 0);
});
