import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { registerSupervisor, getSupervisor, assertSupervisor, assertSupervisorRegistration, controlSupervisor, recordSupervisorObservation, withSupervisedSend, listSupervisors } from "../src/supervision.mjs";
import { storePath, writeRecord } from "../src/store.mjs";

const ID = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url)), run = promisify(execFile);
const targets = [
  { thread: ID, connection: "shared", bucket: "supervisors" },
  { thread: ID, connection: "desktop", bucket: "supervisors" },
  { thread: "task_stopped_supervisor", connection: "cloud", bucket: "cloud-supervisors" },
  { thread: `durable_${ID}`, connection: "desktop-cloud", bucket: "cloud-supervisors" },
];
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/ct-supervisor-stop-");
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home };
}
async function cli(storage, args) {
  try { return JSON.parse((await run(process.execPath, [BIN, ...args, "--json"], { env: { ...process.env, CODEX_HOME: storage.home }, timeout: 10000 })).stdout); }
  catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error; }
}

for (const { thread, connection, bucket } of targets) for (const legacy of [false, true]) {
  test(`${connection}: stopped IDs never return after replacements${legacy ? " (legacy stopped record)" : ""}`, async t => {
    const storage = await fixture(t), a = randomUUID(), b = randomUUID(), options = { ...storage, connection };
    await registerSupervisor(thread, a, options);
    const stopped = await controlSupervisor(thread, "stop", storage);
    if (legacy) {
      const { stopped_session_ids, ...old } = stopped;
      await writeRecord(bucket, thread, old, storage);
    }
    await assert.rejects(registerSupervisor(thread, a, options), { code: "SUPERVISOR_STOPPED" });
    await registerSupervisor(thread, b, options);
    for (const state of ["active", "stopped"]) {
      if (state === "stopped") await controlSupervisor(thread, "stop", storage);
      const file = storePath(bucket, thread, storage.home), before = await readFile(file, "utf8");
      await assert.rejects(registerSupervisor(thread, a, options), { code: "SUPERVISOR_STOPPED" });
      await assert.rejects(assertSupervisorRegistration(thread, a, options), { code: "SUPERVISOR_STOPPED" });
      await assert.rejects(assertSupervisor(thread, a, options), { code: "SUPERVISOR_STOPPED" });
      await assert.rejects(recordSupervisorObservation(thread, a, {}, storage), { code: "SUPERVISOR_STOPPED" });
      await assert.rejects(withSupervisedSend(thread, a, () => assert.fail("stopped supervisor must not send"), options), { code: "SUPERVISOR_STOPPED" });
      assert.equal(await readFile(file, "utf8"), before, "Rejection must preserve B's record");
    }
    // Later generations preserve every earlier retirement, through pause and send writes too.
    const retired = [a, b];
    for (let generation = 0; generation < 3; generation++) {
      const next = randomUUID();
      assert.equal((await registerSupervisor(thread, next, options)).state, "active");
      await controlSupervisor(thread, "pause", storage);
      assert.equal((await registerSupervisor(thread, next, options)).state, "paused");
      await controlSupervisor(thread, "resume", storage);
      await withSupervisedSend(thread, next, async () => ({ delivery_status: "accepted" }), options);
      await assert.rejects(withSupervisedSend(thread, next, async () => { throw new Error("fixture send failure"); }, options), /fixture send failure/);
      for (const id of retired.reverse()) await assert.rejects(registerSupervisor(thread, id, options), { code: "SUPERVISOR_STOPPED" });
      await controlSupervisor(thread, "stop", storage);
      retired.push(next);
    }
  });
}

for (const { thread, connection, bucket } of targets.filter(row => row.connection !== "desktop")) {
  test(`${connection}: old bootstrap doctor/register and observation/send commands fail before connection`, async t => {
    const storage = await fixture(t), a = randomUUID(), b = randomUUID(), options = { ...storage, connection };
    await registerSupervisor(thread, a, options);
    await controlSupervisor(thread, "stop", storage);
    await registerSupervisor(thread, b, options);
    await controlSupervisor(thread, "stop", storage);
    const file = storePath(bucket, thread, storage.home), before = await readFile(file, "utf8");
    for (const command of [["doctor", "--thread", thread], ["supervise", "register", thread], ["read", thread],
      ["send", thread, "old instruction", "--based-on", "fixture", "--finding", randomUUID(), "--no-sound"]]) {
      const result = await cli(storage, ["--connection", connection, "--supervisor", a, ...command]);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "SUPERVISOR_STOPPED");
    }
    assert.equal(await readFile(file, "utf8"), before);
  });
}

test("a session stays bound across task namespaces, retirement and replacement", async t => {
  const storage = await fixture(t), session = randomUUID();
  await registerSupervisor(ID, session, storage);
  const before = await getSupervisor(ID, storage);
  for (const thread of [OTHER, "task_other_supervisor", `durable_${OTHER}`]) {
    await assert.rejects(registerSupervisor(thread, session, storage), { code: "SUPERVISOR_CONFLICT" });
    assert.equal(await getSupervisor(thread, storage), null);
  }
  assert.deepEqual(await getSupervisor(ID, storage), before);
  await controlSupervisor(ID, "stop", storage);
  await registerSupervisor(ID, randomUUID(), storage);
  await assert.rejects(registerSupervisor(OTHER, session, storage), { code: "SUPERVISOR_STOPPED" });
  await assert.rejects(assertSupervisor(OTHER, session, storage), { code: "SUPERVISOR_STOPPED" });
});

test("concurrent cross-task registration cannot bind one session twice", async t => {
  const storage = await fixture(t), session = randomUUID();
  const results = await Promise.all([ID, OTHER].map(thread => cli(storage, ["--supervisor", session, "supervise", "register", thread])));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(["RECORD_BUSY", "SUPERVISOR_CONFLICT"].includes(results.find(result => !result.ok).error.code));
  const records = await listSupervisors(storage);
  assert.equal(records.length, 1);
  const other = records[0].thread_id === ID ? OTHER : ID;
  await assert.rejects(registerSupervisor(other, session, storage), { code: "SUPERVISOR_CONFLICT" });
  assert.equal(await getSupervisor(other, storage), null);
});

test("legacy duplicate IDs remain listable and stoppable with conflicts identified", async t => {
  const storage = await fixture(t), session = randomUUID(), third = randomUUID();
  const first = await registerSupervisor(ID, session, storage);
  await registerSupervisor(third, randomUUID(), storage);
  // Simulate pre-fix data without asking the new registration path to create it.
  const { stopped_session_ids, ...legacy } = first;
  await writeRecord("supervisors", OTHER, { ...legacy, thread_id: OTHER }, storage);
  await writeRecord("supervisor-observations", session, { schema: 1, thread_id: OTHER, session_id: session, last_observed_at: new Date().toISOString() }, storage);
  const result = await cli(storage, ["supervise", "list"]);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 3);
  for (const row of result.data.filter(row => row.session_id === session)) assert.deepEqual(row.session_conflict.thread_ids, [ID, OTHER]);
  const conflict = result.data.find(row => row.thread_id === ID);
  assert.equal(conflict.observation, null);
  assert.equal(conflict.observation_error.code, "SUPERVISOR_INVALID");
  assert.equal(conflict.observation_error.thread_id, OTHER);
  assert.equal(result.data.find(row => row.thread_id === OTHER).observation.thread_id, OTHER);
  assert.equal(result.data.find(row => row.thread_id === third).session_conflict, undefined);
  await assert.rejects(withSupervisedSend(ID, session, () => assert.fail("duplicate session must not send"), storage), { code: "SUPERVISOR_CONFLICT" });
  for (const thread of [ID, OTHER]) {
    const stopped = await cli(storage, ["supervise", "stop", thread]);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.data.state, "stopped");
    assert.equal((await getSupervisor(thread, storage)).state, "stopped");
  }
  assert.equal((await cli(storage, ["supervise", "list"])).data.length, 3);
  await registerSupervisor(ID, randomUUID(), storage);
  await registerSupervisor(OTHER, randomUUID(), storage);
  await assert.rejects(registerSupervisor(third, session, storage), { code: "SUPERVISOR_STOPPED" });
});

test("invalid retirement history fails closed", async t => {
  const storage = await fixture(t), session = randomUUID(), current = await registerSupervisor(ID, session, storage);
  for (const stopped_session_ids of [null, "not-an-array", ["bad-id"], ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]]) {
    await writeRecord("supervisors", ID, { ...current, stopped_session_ids }, storage);
    await assert.rejects(registerSupervisor(ID, randomUUID(), storage), { code: "SUPERVISOR_INVALID" });
  }
});
