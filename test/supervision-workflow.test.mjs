import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerSupervisor, assertSupervisor, controlSupervisor, supervisorStatus, recordSupervisorObservation, withSupervisedSend } from "../src/supervision.mjs";
import { createFinding, getFinding, findingStatus, listFindings, resolveFinding, dismissFinding, reopenFinding, evaluateFinding, findingStats } from "../src/findings.mjs";
import { sendTrackedMessage, getMessage, listMessages, markMessage } from "../src/journal.mjs";
import { createCheckpoint, runCheckpoint } from "../src/checkpoint.mjs";
import { readSnapshot, observeThread } from "../src/observe.mjs";
import { storePath, writeRecord } from "../src/store.mjs";

const ID = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const BIN = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
const thread = () => ({ id: ID, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn", status: "inProgress", items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "test this" }] }] }] });
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/ct-workflow-");
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home };
}
const create = (storage, key = "timeout-contract") => createFinding(ID, { ...storage, key, title: "Timeout contract", condition: "The timeout regression test passes" });

test("a supervisor is bound to one task and session; pause preserves observation and stop prevents revival", async t => {
  const storage = await fixture(t), session = randomUUID(), next = randomUUID();
  assert.equal((await supervisorStatus(ID, storage)).state, "unregistered");
  await registerSupervisor(ID, session, { ...storage, owner: "codex" });
  await assert.rejects(assertSupervisor(OTHER, session, storage), { code: "SUPERVISOR_NOT_REGISTERED" });
  await assert.rejects(registerSupervisor(ID, next, storage), { code: "SUPERVISOR_CONFLICT" });
  await controlSupervisor(ID, "pause", storage);
  assert.equal((await registerSupervisor(ID, session, storage)).state, "paused", "Bootstrap retries must not resume intervention");
  await recordSupervisorObservation(ID, session, { observed_at: new Date().toISOString() }, storage);
  assert.ok((await supervisorStatus(ID, storage)).observation.last_observed_at);
  await assert.rejects(assertSupervisor(ID, session, { ...storage, sending: true }), { code: "SUPERVISOR_PAUSED" });
  await controlSupervisor(ID, "resume", storage);
  await assertSupervisor(ID, session, { ...storage, sending: true });
  await controlSupervisor(ID, "stop", storage);
  await assert.rejects(registerSupervisor(ID, session, storage), { code: "SUPERVISOR_STOPPED" });
  await assert.rejects(controlSupervisor(ID, "resume", storage), { code: "SUPERVISOR_STOPPED" });
  await registerSupervisor(ID, next, storage);
  await assert.rejects(assertSupervisor(ID, session, storage), { code: "SUPERVISOR_MISMATCH" });
});

test("pause and sends serialize; a busy pause never falsely reports success", async t => {
  const storage = await fixture(t), session = randomUUID();
  await registerSupervisor(ID, session, storage);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const pending = withSupervisedSend(ID, session, async () => { entered(); await wait; return { message_id: "receipt", delivery_status: "accepted" }; }, storage);
  await started;
  await assert.rejects(controlSupervisor(ID, "pause", storage), { code: "RECORD_BUSY" });
  await recordSupervisorObservation(ID, session, { observed_at: new Date().toISOString() }, storage);
  release(); await pending;
  await controlSupervisor(ID, "pause", storage);
  let sends = 0;
  await assert.rejects(withSupervisedSend(ID, session, async () => { sends++; }, storage), { code: "SUPERVISOR_PAUSED" });
  assert.equal(sends, 0);
  assert.equal((await supervisorStatus(ID, storage)).last_delivery.status, "accepted");
  assert.equal(await withSupervisedSend(ID, undefined, async () => "explicit manual send", storage), "explicit manual send");
});

test("supervised sends require findings and reviewed cursors, and duplicate accepted interventions are blocked", async t => {
  const storage = await fixture(t), session = randomUUID(), finding = await create(storage);
  await registerSupervisor(ID, session, storage);
  const basedOn = readSnapshot(thread()).cursor;
  let sends = 0;
  const runtime = { ...storage, send: async (_, body, options) => {
    await options.beforeSend(thread()); sends++;
    assert.match(body, /解決条件:/);
    return { sent: true, delivery_status: "accepted", client_message_id: options.clientMessageId };
  } };
  await assert.rejects(sendTrackedMessage(ID, "fix", { supervisor: session, finding: finding.id }, runtime), { code: "SUPERVISOR_OBSERVATION_REQUIRED" });
  await assert.rejects(sendTrackedMessage(ID, "fix", { supervisor: session, basedOn }, runtime), { code: "SUPERVISOR_FINDING_REQUIRED" });
  const receipt = await sendTrackedMessage(ID, "fix", { supervisor: session, finding: finding.id, basedOn }, runtime);
  const record = await getMessage(ID, receipt.message_id, storage);
  assert.equal(record.metadata.finding_revision, 1); assert.equal(record.metadata.supervisor_id, session);
  await assert.rejects(sendTrackedMessage(ID, "same concern, different text", { finding: finding.id }, runtime), { code: "DUPLICATE_INTERVENTION" });
  assert.equal(sends, 1);
  await assert.rejects(sendTrackedMessage(ID, "managed duplicate", { supervisor: session, finding: finding.id, basedOn }, runtime), { code: "DUPLICATE_INTERVENTION", existing_message_id: receipt.message_id });
  const duplicateStatus = await supervisorStatus(ID, storage);
  assert.equal(duplicateStatus.last_delivery.status, "accepted");
  assert.equal(duplicateStatus.last_delivery.message_id, receipt.message_id);
  assert.equal(duplicateStatus.last_error.code, "DUPLICATE_INTERVENTION");
  assert.equal((await findingStatus(ID, finding.id, storage)).status, "awaiting_response");
  await markMessage(ID, receipt.message_id, { ...storage, status: "applied", note: "The worker reports a fix", evidence: ["https://example.test/result"] });
  assert.equal((await findingStatus(ID, finding.id, storage)).status, "awaiting_verification");
  await assert.rejects(reopenFinding(ID, finding.id, { ...storage, reason: "try again" }), { code: "FINDING_UNCHANGED" });
  const changed = thread(); changed.turns[0].items.push({ id: "our-message", type: "userMessage", content: [{ type: "text", text: "fix" }] });
  await assert.rejects(reopenFinding(ID, finding.id, { ...storage, reason: "The cursor advanced", basedOn: readSnapshot(changed).cursor }), { code: "FINDING_UNCHANGED" });
  const reopened = await reopenFinding(ID, finding.id, { ...storage, reason: "The user added a requirement", condition: "Timeout and cancellation tests pass" });
  assert.equal(reopened.revision, 2);
  await sendTrackedMessage(ID, "new requirement", { finding: finding.id }, runtime);
  assert.equal(sends, 2);
});

test("finding evidence is revalidated before a mutation and stale evidence does not reserve a retry", async t => {
  const storage = await fixture(t), file = `${storage.home}/evidence.txt`;
  await writeFile(file, "first");
  const finding = await createFinding(ID, { ...storage, key: "file", title: "Changed evidence", condition: "Fix the observed failure", evidence: [file] });
  await writeFile(file, "changed");
  let sends = 0;
  const runtime = { ...storage, send: async (_, __, options) => { await options.beforeSend(thread()); sends++; return { sent: true, delivery_status: "accepted" }; } };
  await assert.rejects(sendTrackedMessage(ID, "fix", { finding: finding.id }, runtime), { code: "STALE_EVIDENCE" });
  assert.equal(sends, 0);
  assert.equal((await listMessages(ID, storage))[0].delivery_status, "not_sent");
  await reopenFinding(ID, finding.id, { ...storage, evidence: [file], reason: "Rechecked the changed file" });
  await sendTrackedMessage(ID, "fix current evidence", { finding: finding.id }, runtime);
  assert.equal(sends, 1);
});

test("observation failures preserve the last successful read and direct launcher crashes require explicit recovery", async t => {
  const storage = await fixture(t), session = randomUUID(), originalHome = process.env.CODEX_HOME;
  await registerSupervisor(ID, session, storage);
  const at = new Date().toISOString();
  await recordSupervisorObservation(ID, session, { observed_at: at }, storage);
  process.env.CODEX_HOME = storage.home;
  try {
    await assert.rejects(observeThread(ID, { supervisor: session }, { discover: async () => { throw Object.assign(new Error("offline"), { code: "CONNECTION_FAILED" }); } }), { code: "CONNECTION_FAILED" });
  } finally { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; }
  const status = await supervisorStatus(ID, storage);
  assert.equal(status.observation.connection, "failed"); assert.equal(status.observation.last_observed_at, at);
  await controlSupervisor(ID, "stop", storage);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const next = randomUUID();
  await registerSupervisor(ID, next, { ...storage, launcherPid: exited.pid });
  assert.equal((await supervisorStatus(ID, storage)).launcher_alive, false);
  await assert.rejects(assertSupervisor(ID, next, storage), { code: "SUPERVISOR_ORPHANED" });
  await assert.rejects(controlSupervisor(ID, "resume", storage), { code: "SUPERVISOR_ORPHANED" });
  await controlSupervisor(ID, "stop", storage);
  await registerSupervisor(ID, randomUUID(), storage);
});

test("unknown delivery and a journaled crash reservation cannot be silently retried or closed", async t => {
  const storage = await fixture(t), finding = await create(storage);
  await assert.rejects(sendTrackedMessage(ID, "fix", { finding: finding.id }, { ...storage, send: async () => {
    throw Object.assign(new Error("lost receipt"), { uncertain: true, delivery_status: "unknown" });
  } }));
  await assert.rejects(sendTrackedMessage(ID, "fix", { finding: finding.id }, { ...storage, send: async () => assert.fail("must not send") }), { code: "DUPLICATE_INTERVENTION" });
  await assert.rejects(reopenFinding(ID, finding.id, { ...storage, reason: "new facts", condition: "different" }), { code: "FINDING_DELIVERY_UNKNOWN" });
  await assert.rejects(dismissFinding(ID, finding.id, { ...storage, reason: "ignore" }), { code: "FINDING_DELIVERY_UNKNOWN" });
  assert.equal((await findingStatus(ID, finding.id, storage)).status, "delivery_unknown");
  const crashed = await create(storage, "crashed"), id = randomUUID();
  await writeRecord("messages", id, { schema: 1, id, thread_id: ID, created_at: new Date().toISOString(), metadata: { finding_id: crashed.id, finding_revision: 1 }, delivery_status: "unknown", attempt_state: "prepared" }, storage);
  await assert.rejects(sendTrackedMessage(ID, "recover", { finding: crashed.id }, { ...storage, send: async () => assert.fail("must not send") }), { code: "DUPLICATE_INTERVENTION" });
});

test("rejected sends remain retryable, previews do not reserve findings, and keys reuse the same concern", async t => {
  const storage = await fixture(t), finding = await create(storage);
  assert.equal((await create(storage)).id, finding.id);
  await assert.rejects(getFinding(OTHER, finding.id, storage), { code: "FINDING_NOT_FOUND" });
  await sendTrackedMessage(ID, "preview", { finding: finding.id, dryRun: true }, { ...storage, send: async () => ({ sent: false, delivery_status: "not_sent" }) });
  assert.equal((await listMessages(ID, storage)).length, 0);
  await assert.rejects(sendTrackedMessage(ID, "first", { finding: finding.id }, { ...storage, send: async () => { throw new Error("not sent"); } }));
  const receipt = await sendTrackedMessage(ID, "retry", { finding: finding.id }, { ...storage, send: async () => ({ sent: true, delivery_status: "accepted" }) });
  assert.equal(receipt.sent, true);
});

test("resolution pins a successful checkpoint run; changed inputs or another run need review", async t => {
  const storage = await fixture(t), finding = await create(storage), source = `${storage.home}/input.txt`;
  await writeFile(source, "one");
  const checkpoint = await createCheckpoint(ID, "test", { ...storage, paths: [source] });
  await assert.rejects(resolveFinding(ID, finding.id, { ...storage, checkpoint: checkpoint.id, note: "not run" }), { code: "STALE_CHECKPOINT" });
  await runCheckpoint(ID, checkpoint.id, [process.execPath, "-e", "process.exit(0)"], storage);
  const resolved = await resolveFinding(ID, finding.id, { ...storage, checkpoint: checkpoint.id, note: "The scoped test verifies the timeout contract" });
  assert.equal(resolved.status, "resolved"); assert.equal(resolved.resolution.basis, "explicit_report");
  assert.equal((await listFindings(ID, storage)).total, 0);
  await runCheckpoint(ID, checkpoint.id, [process.execPath, "-e", "process.exit(0)"], storage);
  assert.equal((await findingStatus(ID, finding.id, storage)).status, "needs_review", "A later run does not inherit an earlier condition assessment");
  await resolveFinding(ID, finding.id, { ...storage, checkpoint: checkpoint.id, note: "Reviewed the new run" });
  await writeFile(source, "two");
  assert.equal((await findingStatus(ID, finding.id, storage)).status, "needs_review");
  assert.equal((await listFindings(ID, storage)).total, 1);
});

test("evaluation reports its denominator and leaves unsent candidates and unreviewed findings explicit", async t => {
  const storage = await fixture(t), first = await create(storage), second = await create(storage, "second");
  assert.equal((await findingStats(ID, storage)).useful_fraction, null);
  await evaluateFinding(ID, first.id, { ...storage, rating: "useful", reason: "The concern reproduced" });
  const stats = await findingStats(ID, storage);
  assert.equal(stats.evaluated, 1); assert.equal(stats.ratings.unrated, 1); assert.equal(stats.unsent_candidates, 2); assert.equal(stats.useful_fraction, 1);
  await evaluateFinding(ID, second.id, { ...storage, rating: "incorrect", reason: "The existing contract already covers this" });
  assert.equal((await findingStats(ID, storage)).useful_fraction, 0.5);
});

test("unsafe supervisor files fail closed and managed control commands cannot resume themselves", async t => {
  const storage = await fixture(t), session = randomUUID();
  await registerSupervisor(ID, session, storage);
  const invocation = spawnSync(process.execPath, [BIN, "--supervisor", session, "supervise", "resume", ID, "--json"], { env: { ...process.env, CODEX_HOME: storage.home }, encoding: "utf8" });
  assert.equal(JSON.parse(invocation.stdout).error.code, "SUPERVISOR_CONTROL_FORBIDDEN");
  const file = storePath("supervisors", ID, storage.home);
  await chmod(file, 0o644);
  await assert.rejects(assertSupervisor(ID, session, storage), /Unsafe local state/);
  await rm(file); await writeFile(`${storage.home}/outside.json`, "{}"); await symlink(`${storage.home}/outside.json`, file);
  await assert.rejects(assertSupervisor(ID, session, storage), /Unsafe local state/);
});
