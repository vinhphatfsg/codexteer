import { randomUUID } from "node:crypto";
import { normalizeThreadId } from "./thread-id.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { collectEvidence } from "./evidence.mjs";
import { decodeCursor, digest } from "./observe.mjs";
import { verifyCheckpoint } from "./checkpoint.mjs";

const failure = (message, code) => Object.assign(new Error(message), { code });
const ratings = ["useful", "unnecessary", "incorrect", "unrated"];
const text = (value, label, max = 8000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw failure(`${label} requires non-empty text (up to ${max} characters).`, "FINDING_INVALID");
  return value;
};
// A cursor can advance because our own intervention appeared as a userMessage.
// It is observation context, never sufficient evidence for another intervention.
const contextHash = record => digest({ condition: record.condition, evidence: record.evidence });

export async function getFinding(threadInput, id, storage = {}) {
  const threadId = normalizeThreadId(threadInput), record = await readRecord("findings", id, storage);
  if (!record || record.schema !== 1 || record.id !== id || record.thread_id !== threadId) throw failure("Finding not found for this task.", "FINDING_NOT_FOUND");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !["open", "resolved", "dismissed"].includes(record.disposition)
    || !Array.isArray(record.evidence) || typeof record.condition !== "string" || !ratings.includes(record.evaluation?.rating)) throw failure("Invalid finding record.", "FINDING_INVALID");
  return record;
}

export async function findingMessages(record, storage = {}) {
  return (await listRecords("messages", storage)).filter(message => message?.schema === 1 && message.thread_id === record.thread_id
    && message.metadata?.finding_id === record.id && message.metadata?.finding_revision === record.revision)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function createFinding(threadInput, { key, title, condition, evidence = [], basedOn, ...storage }) {
  const threadId = normalizeThreadId(threadInput);
  if (typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(key)) throw failure("--key requires a stable short identifier for this concern.", "FINDING_INVALID");
  text(title, "--title", 240); text(condition, "--condition");
  const refs = await collectEvidence(evidence), observed = basedOn ? decodeCursor(basedOn, threadId) : null;
  return withStoreLock(`message-${threadId}`, async () => {
    const existing = (await listRecords("findings", storage)).find(record => record?.thread_id === threadId && record.key === key);
    if (existing) return { ...await findingStatus(threadId, existing.id, storage), reused: true };
    const now = new Date().toISOString();
    const record = { schema: 1, id: randomUUID(), thread_id: threadId, key, title, condition, revision: 1,
      evidence: refs, based_on: basedOn ?? null, user_revision: observed?.user_revision ?? null, disposition: "open", resolution: null,
      evaluation: { rating: "unrated" }, revisions: [], created_at: now, updated_at: now };
    await writeRecord("findings", record.id, record, storage);
    return { ...record, status: "open", messages: [], verification: null, reused: false };
  }, storage);
}

export async function assertFindingSend(threadInput, id, storage = {}) {
  const record = await getFinding(threadInput, id, storage);
  if (record.disposition !== "open") throw failure("This finding is closed. Reopen it with new evidence or a changed requirement before sending again.", "FINDING_CLOSED");
  // The journal is the reservation: even a crash before writing a receipt leaves
  // an unknown attempt here. Never infer not-sent from a missing response.
  const previous = (await findingMessages(record, storage)).find(message => message.delivery_status !== "not_sent");
  if (previous) throw Object.assign(failure("This finding revision already has a pending or accepted intervention. Check its history; do not resend it.", "DUPLICATE_INTERVENTION"), { existing_message_id: previous.id });
  return record;
}

export async function findingStatus(threadInput, id, storage = {}) {
  const record = await getFinding(threadInput, id, storage), entries = await findingMessages(record, storage);
  const messages = entries.map(entry => ({ id: entry.id, delivery_status: entry.delivery_status, attempt_state: entry.attempt_state,
    response: entry.response, stored: entry.verification?.status ?? "unchecked" }));
  const latest = entries.filter(entry => entry.delivery_status !== "not_sent").at(-1);
  let status = record.disposition, verification = null;
  if (record.disposition === "open" && latest) status = latest.delivery_status === "unknown" ? "delivery_unknown"
    : latest.response?.status === "applied" ? "awaiting_verification" : "awaiting_response";
  if (record.resolution?.checkpoint_id) {
    try {
      const current = await verifyCheckpoint(record.thread_id, record.resolution.checkpoint_id, storage);
      verification = { valid: current.valid === true && current.latest_run?.id === record.resolution.run_id && current.snapshot.digest === record.resolution.input_digest,
        checkpoint_id: current.id, run_id: current.latest_run?.id ?? null, inputs_current: current.inputs_current,
        checked_at: new Date().toISOString(), condition_assessment: "explicit_report" };
    } catch (error) { verification = { valid: false, checkpoint_id: record.resolution.checkpoint_id, error_code: error.code ?? "CHECKPOINT_UNAVAILABLE", condition_assessment: "explicit_report" }; }
    if (!verification.valid && record.disposition === "resolved") status = "needs_review";
  }
  return { ...record, status, messages, verification };
}

export async function listFindings(threadInput, { all = false, limit = 50, ...storage } = {}) {
  const threadId = normalizeThreadId(threadInput);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw failure("--limit must be between 1 and 1000.", "FINDING_INVALID");
  const records = (await listRecords("findings", storage)).filter(record => record?.thread_id === threadId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  // Recheck closed resolutions too: changed inputs make them unresolved again.
  const findings = [];
  for (const record of records) {
    const current = await findingStatus(threadId, record.id, storage);
    if (all || !["resolved", "dismissed"].includes(current.status)) findings.push(current);
  }
  return { thread_id: threadId, findings: findings.slice(0, limit), total: findings.length, has_more: findings.length > limit };
}

async function changeFinding(threadInput, id, update, storage) {
  const threadId = normalizeThreadId(threadInput);
  return withStoreLock(`message-${threadId}`, async () => {
    const record = await getFinding(threadId, id, storage);
    const updated = { ...await update(record), updated_at: new Date().toISOString() };
    await writeRecord("findings", id, updated, storage);
    return findingStatus(threadId, id, storage);
  }, storage);
}

async function knownDelivery(record, storage) {
  if ((await findingMessages(record, storage)).some(entry => entry.delivery_status === "unknown")) throw failure("Delivery is unknown. Reconcile the existing message before closing or revising this finding.", "FINDING_DELIVERY_UNKNOWN");
}

export async function resolveFinding(threadInput, id, { checkpoint, note, ...storage }) {
  text(note, "--note");
  if (!checkpoint) throw failure("Resolution requires a --checkpoint and an explicit --note explaining how its result satisfies the condition.", "FINDING_INVALID");
  return changeFinding(threadInput, id, async record => {
    await knownDelivery(record, storage);
    const verified = await verifyCheckpoint(record.thread_id, checkpoint, storage);
    if (!verified.valid) throw failure("The checkpoint is not currently valid. Verify current inputs and a successful run before resolving.", "STALE_CHECKPOINT");
    return { ...record, disposition: "resolved", resolution: { checkpoint_id: checkpoint, run_id: verified.latest_run.id,
      input_digest: verified.snapshot.digest, note, basis: "explicit_report", at: new Date().toISOString() } };
  }, storage);
}

export async function dismissFinding(threadInput, id, { reason, ...storage }) {
  text(reason, "--reason");
  return changeFinding(threadInput, id, async record => {
    await knownDelivery(record, storage);
    return { ...record, disposition: "dismissed", resolution: { reason, basis: "explicit_report", at: new Date().toISOString() } };
  }, storage);
}

export async function reopenFinding(threadInput, id, { reason, evidence, basedOn, condition, ...storage }) {
  const threadId = normalizeThreadId(threadInput);
  text(reason, "--reason"); if (condition !== undefined) text(condition, "--condition");
  const refs = evidence === undefined ? undefined : await collectEvidence(evidence);
  const observed = basedOn === undefined ? undefined : decodeCursor(basedOn, threadId);
  return changeFinding(threadId, id, async record => {
    await knownDelivery(record, storage);
    const updated = { ...record, condition: condition ?? record.condition, evidence: refs ?? record.evidence, based_on: basedOn ?? record.based_on, user_revision: observed?.user_revision ?? record.user_revision };
    if (contextHash(record) === contextHash(updated)) throw failure("Reopening requires changed evidence or a changed resolution condition. A new reason or cursor alone does not authorize a duplicate intervention; reflect a changed user requirement in the condition.", "FINDING_UNCHANGED");
    return { ...updated, revision: record.revision + 1, disposition: "open", resolution: null, evaluation: { rating: "unrated" },
      revisions: [...record.revisions, { revision: record.revision, condition: record.condition, evidence: record.evidence,
        based_on: record.based_on, user_revision: record.user_revision, resolution: record.resolution, evaluation: record.evaluation, reason, at: new Date().toISOString() }] };
  }, storage);
}

export async function evaluateFinding(threadInput, id, { rating, reason, ...storage }) {
  if (!ratings.includes(rating) || rating === "unrated") throw failure("--rating must be useful, unnecessary or incorrect.", "FINDING_INVALID");
  text(reason, "--reason");
  return changeFinding(threadInput, id, async record => ({ ...record, evaluation: { rating, reason, basis: "explicit_report", at: new Date().toISOString() } }), storage);
}

export async function findingStats(threadInput, storage = {}) {
  const threadId = normalizeThreadId(threadInput), records = (await listRecords("findings", storage)).filter(record => record?.thread_id === threadId);
  const counts = Object.fromEntries(ratings.map(rating => [rating, 0]));
  let sent = 0;
  for (const entry of records) {
    const record = await getFinding(threadId, entry.id, storage);
    counts[record.evaluation.rating]++;
    if ((await findingMessages(record, storage)).some(message => message.delivery_status !== "not_sent")) sent++;
  }
  const evaluated = records.length - counts.unrated;
  return { thread_id: threadId, scope: "current_finding_revisions_including_unsent_candidates", total: records.length,
    sent_or_unknown: sent, unsent_candidates: records.length - sent, ratings: counts, evaluated,
    useful_fraction: evaluated ? counts.useful / evaluated : null };
}
