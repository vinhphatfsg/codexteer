import { randomUUID } from "node:crypto";
import { sendAppServerMessage } from "./app-server.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { digest, fetchThread } from "./observe.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { discoverRuntime } from "./runtime.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { RpcClient } from "./rpc.mjs";
import { prepareDirective } from "./directive.mjs";
import { assertSupervisor, withSupervisedSend } from "./supervision.mjs";

export async function getMessage(threadInput, id, options = {}) {
  const threadId = normalizeThreadId(threadInput);
  const entry = await readRecord("messages", id, options);
  if (!entry || entry.thread_id !== threadId || entry.id !== id || entry.schema !== 1) throw new Error("Message record not found for this task.");
  return entry;
}

export function messageSummary(entry, includeText = false) {
  const { body, wire_text, ...data } = entry;
  return includeText ? { ...data, body, wire_text } : data;
}

export async function listMessages(threadInput, { includeText = false, pending = false, ...options } = {}) {
  const threadId = normalizeThreadId(threadInput);
  return (await listRecords("messages", options)).filter(e => e?.thread_id === threadId && (!pending || !["applied", "dismissed"].includes(e.response?.status)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(e => messageSummary(e, includeText));
}

export function instructionStates(entries, now = Date.now()) {
  const states = new Map(entries.map(e => [e.id, { ...e, instruction_status: e.delivery_status === "not_sent" ? "not_sent" : e.delivery_status !== "accepted" ? "pending_delivery" : e.metadata?.retracts ? "withdrawal_notice" : e.metadata?.expires_at && Date.parse(e.metadata.expires_at) <= now ? "expired" : "active" }]));
  for (const entry of entries) {
    const target = states.get(entry.metadata?.supersedes ?? entry.metadata?.retracts);
    if (!target) continue;
    if (entry.delivery_status === "accepted") Object.assign(target, { instruction_status: entry.metadata.retracts ? "retracted" : "superseded", replaced_by: entry.id });
    else if (entry.delivery_status !== "not_sent") target.pending_change_ids = [...target.pending_change_ids ?? [], entry.id];
  }
  return [...states.values()];
}

export async function listInstructions(threadInput, { all = false, ...options } = {}) {
  const threadId = normalizeThreadId(threadInput), entries = instructionStates(await listMessages(threadId, { ...options, includeText: true }));
  return { thread_id: threadId, instructions: entries.filter(e => all || e.instruction_status === "active"), pending_changes: entries.filter(e => e.instruction_status === "pending_delivery") };
}

async function validateReplacement(threadId, options, storage) {
  const targetId = options.supersedes ?? options.retracts;
  if (!targetId) return;
  await getMessage(threadId, targetId, storage);
  const entries = instructionStates(await listMessages(threadId, { ...storage, includeText: true }));
  const target = entries.find(e => e.id === targetId);
  if (!["active", "expired"].includes(target.instruction_status) || target.pending_change_ids?.length) throw new Error("Target instruction is inactive or has an unresolved delivery. Check history before replacing it.");
}

export async function sendTrackedMessage(threadInput, body, options = {}, { send = sendAppServerMessage, ...storage } = {}) {
  const threadId = normalizeThreadId(threadInput);
  if (options.supervisor && !options.basedOn) throw Object.assign(new Error("Supervised sends require --based-on from a completed read."), { code: "SUPERVISOR_OBSERVATION_REQUIRED" });
  if (options.supervisor && !options.finding && !options.retracts) throw Object.assign(new Error("Supervised sends require --finding so pending interventions can be tracked and deduplicated."), { code: "SUPERVISOR_FINDING_REQUIRED" });
  if (options.dryRun) {
    if (options.supervisor) await assertSupervisor(threadId, options.supervisor, { ...storage, sending: true, connection: options.connection });
    await validateReplacement(threadId, options, storage);
    const prepared = await prepareDirective(threadId, body, options, "preview", storage);
    return { ...await send(threadId, prepared.wireText, options), ...(prepared.metadata ? { metadata: prepared.metadata, freshness_checked: false } : {}) };
  }
  return withSupervisedSend(threadId, options.supervisor, () => withStoreLock(`message-${threadId}`, async () => {
    await validateReplacement(threadId, options, storage);
    const id = randomUUID(), created = new Date().toISOString();
    const prepared = await prepareDirective(threadId, body, options, id, storage);
    const beforeSend = async (...args) => {
      await prepared.beforeSend?.(...args);
      if (options.supervisor) await assertSupervisor(threadId, options.supervisor, { ...storage, sending: true, connection: options.connection });
    };
    let entry = { schema: 1, id, client_message_id: id, thread_id: threadId, created_at: created, updated_at: created, body, wire_text: prepared.wireText, metadata: prepared.metadata,
      message_sha256: digest(prepared.wireText), delivery_status: "unknown", sent: null, attempt_state: "prepared", response: { status: "unreported" } };
    await writeRecord("messages", id, entry, storage);
    try {
      const receipt = await send(threadId, prepared.wireText, { ...options, clientMessageId: id, beforeSend });
      entry = { ...entry, ...receipt, id, attempt_state: "finished", updated_at: new Date().toISOString() };
      try { await writeRecord("messages", id, entry, storage); } catch { return { ...receipt, message_id: id, journal_update_required: true }; }
      return { ...receipt, message_id: id };
    } catch (error) {
      entry = { ...entry, sent: Object.hasOwn(error, "sent") ? error.sent : error.uncertain ? null : false, delivery_status: error.delivery_status ?? (error.uncertain ? "unknown" : "not_sent"), attempt_state: "finished", updated_at: new Date().toISOString(), error_code: error.code ?? "NOT_SENT" };
      try { await writeRecord("messages", id, entry, storage); } catch { error.journal_update_required = true; }
      error.client_message_id = id; error.message_id = id;
      error.delivery_status = entry.delivery_status; error.sent = entry.sent;
      throw error;
    }
  }, storage), { ...storage, connection: options.connection });
}

export async function reconcileMessages(threadInput, id, options = {}, { discover = discoverRuntime, connect = RpcClient.connect } = {}) {
  const threadId = normalizeThreadId(threadInput);
  // Validate the local target before connecting.
  if (id) await getMessage(threadId, id, options);
  const { paths, state } = await discover();
  assertRuntimeOperation(state, "history_check");
  const client = compatibleClient(await connect(paths.socket), state);
  try {
    const thread = await fetchThread(client, threadId);
    return await withStoreLock(`message-${threadId}`, async () => {
      const entries = id ? [await getMessage(threadId, id, options)] : await listMessages(threadId, { ...options, includeText: true });
      const items = thread.turns.flatMap(t => t.items.map(i => ({ ...i, turn_id: t.id })));
      const result = [];
      for (const entry of entries) {
        const matches = items.filter(i => i.type === "userMessage" && i.clientId === entry.client_message_id);
        const matchingText = matches.length === 1 && digest(matches[0].content.filter(c => c.type === "text").map(c => c.text).join("\n")) === entry.message_sha256;
        const verification = { status: matchingText ? "stored" : matches.length ? "conflict" : "not_observed", checked_at: new Date().toISOString(), matching_items: matches.length };
        if (matchingText) Object.assign(verification, { item_id: matches[0].id, turn_id: matches[0].turn_id });
        const updated = { ...entry, verification, updated_at: verification.checked_at, ...(matchingText ? { delivery_status: "accepted", sent: true, turn_id: matches[0].turn_id } : {}) };
        await writeRecord("messages", entry.id, updated, options);
        result.push(messageSummary(updated, options.includeText));
      }
      return result;
    }, options);
  } finally { client.close(); }
}

export async function markMessage(threadInput, id, { status, note, evidence = [], by = "local", ...options }) {
  const threadId = normalizeThreadId(threadInput);
  if (!["acknowledged", "applied", "dismissed"].includes(status) || !note?.trim() || !by?.trim()) throw new Error("mark requires --status acknowledged|applied|dismissed and a non-empty --note.");
  if (status === "applied" && !evidence.length) throw new Error("applied requires --evidence (a test result, diff or artifact reference).");
  return withStoreLock(`message-${threadId}`, async () => {
    const entry = await getMessage(threadId, id, options);
    const response = { status, note, evidence, reported_by: by, reported_at: new Date().toISOString(), basis: "explicit_report" };
    const updated = { ...entry, response, reports: [...entry.reports ?? [], response], updated_at: response.reported_at };
    await writeRecord("messages", id, updated, options);
    return messageSummary(updated);
  }, options);
}
