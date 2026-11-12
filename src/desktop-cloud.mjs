import { createHash, randomUUID } from "node:crypto";
import { connectDesktopCloud, desktopCloudEnvironments } from "./desktop-cloud-api.mjs";
import { cloudModelsOnClient, resolveCloudModelSelection, validateCloudModelOptions } from "./desktop-cloud-models.mjs";
import { desktopCloudId, desktopCloudLink } from "./desktop-cloud-id.mjs";
import { getManagedThread } from "./project-index.mjs";
import { fetchThread, turnObservation } from "./observe.mjs";
import { turnEvidence, turnRuns } from "./attention-coverage.mjs";
import { newestTurn, turnStatuses } from "./desktop-cloud-read.mjs";
import { readRecord, writeRecord, storePath, withStoreLock, listRecords } from "./store.mjs";
const failure = (message, code = "DESKTOP_CLOUD_OPTIONS_INVALID", uncertain = false) => Object.assign(new Error(message), { code, uncertain });
const hash = value => createHash("sha256").update(value).digest("hex");
export async function desktopCloudReceipt(attempt, storage = {}) {
  if (!/^[a-f0-9-]{36}$/.test(attempt ?? "")) throw failure("Invalid creation attempt ID.");
  const receipt = await readRecord("desktop-cloud-creations", attempt, storage);
  if (!receipt || receipt.attempt_id !== attempt) throw failure("Creation receipt not found.", "DESKTOP_CLOUD_CREATION_RECEIPT_NOT_FOUND");
  return receipt;
}
export async function createDesktopCloudTask(selector, prompt, options = {}, dependencies = {}) {
  const attemptId = options.attemptId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw failure("Invalid creation attempt ID.");
  if (options.dryRun) return createTask(selector, prompt, { ...options, attemptId }, dependencies);
  return withStoreLock(`desktop-cloud-create-${attemptId}`, () => createTask(selector, prompt, { ...options, attemptId }, dependencies), dependencies);
}
async function createTask(selector, prompt, options = {}, { environments = desktopCloudEnvironments, connect = connectDesktopCloud, ...storage } = {}) {
  validateCloudModelOptions(options);
  if (options.project !== undefined) throw failure("Creation cannot currently register a Desktop project for a newly allocated Cloud environment. No chat was created. Use doctor --thread TARGET --project PROJECT to check an existing task's executor-bound assignment API.", "DESKTOP_CLOUD_PROJECT_UNAVAILABLE");
  if (typeof selector !== "string" || !selector.trim() || typeof prompt !== "string" || !prompt.trim()) throw failure("An --environment ID or exact name and initial instruction are required.");
  if (options.title !== undefined && (typeof options.title !== "string" || !options.title.trim() || options.title.length > 1000)) throw failure("Invalid --title.");
  const matches = (await environments()).environments.filter(row => row.id === selector || row.name === selector);
  if (matches.length !== 1) throw failure("Select exactly one accessible environment configuration.");
  const selected = matches[0], attempt = options.attemptId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw failure("Invalid creation attempt ID.");
  const previous = !options.dryRun && await readRecord("desktop-cloud-creations", attempt, storage);
  if (previous) {
    const notDispatched = previous.creation_status === "not_created" && previous.creation_dispatched === false && previous.sent === false && previous.thread_id == null;
    const sameRequest = previous.environment_config_id === selected.id && previous.prompt_sha256 === hash(prompt) && previous.title === (options.title ?? null)
      && previous.model_options?.model === (options.model ?? null) && previous.model_options?.thinking === (options.thinking ?? null)
      && (!options.modelSelection || !previous.model_selection || options.modelSelection.model === previous.model_selection.model && options.modelSelection.thinking === previous.model_selection.thinking);
    if (!notDispatched || !sameRequest) throw failure("This creation attempt already has a receipt. Reconcile it without creating or sending again.", "DESKTOP_CLOUD_CREATION_PENDING");
    if (previous.model_selection) options = { ...options, modelSelection: previous.model_selection };
  }
  let client, receipt = { schema: 1, attempt_id: attempt, environment_config_id: selected.id, environment_name: selected.name, connection_mode: "desktop-cloud",
    title: options.title ?? null, model_options: { model: options.model ?? null, thinking: options.thinking ?? null }, creation_dispatched: false,
    project_membership: "not_requested", creation_status: "not_created", delivery_status: "not_sent", sent: false, prompt_sha256: hash(prompt), dry_run: !!options.dryRun }, creating = false, dispatched = false;
  if (!options.dryRun) receipt.receipt_path = storePath("desktop-cloud-creations", attempt, storage.home);
  const save = () => writeRecord("desktop-cloud-creations", attempt, receipt, storage);
  try {
    client = await connect();
    const models = await cloudModelsOnClient(client);
    receipt.model_selection = await resolveCloudModelSelection(options, { ...storage, models });
    if (options.dryRun) return receipt;
    receipt.creation_status = "dispatching"; receipt.creation_dispatched = true; await save(); creating = true; dispatched = true;
    const result = await client.request("thread/start", { model: receipt.model_selection.model, serviceName: "codex_cloud", threadSource: "user", pluginsMcp: { productSku: "codex" },
      config: { "features.mcp_app_ui": true, model_reasoning_effort: receipt.model_selection.thinking }, environments: [{ environmentConfigId: selected.id }], deferredEnvironment: true, ephemeral: false }, { mutation: true });
    receipt = { ...receipt, creation_status: "created", thread_id: desktopCloudId(result.thread.id), deep_link: desktopCloudLink(result.thread.id) }; creating = false; await save();
    if (options.title) await client.request("thread/name/set", { threadId: receipt.thread_id, name: options.title }, { mutation: true });
    const { sendTrackedMessage } = await import("./journal.mjs");
    const sent = await sendTrackedMessage(receipt.thread_id, prompt, { newTurn: true, connection: "desktop-cloud" }, { ...storage,
      send: (target, text, settings) => sendDesktopCloudInput(target, text, { ...settings, expectedEnvironmentConfigId: selected.id, initialModelSelection: receipt.model_selection }, { ...storage, connect: async () => ({ request: (...args) => client.request(...args), close() {} }) }) });
    receipt = { ...receipt, ...sent }; await save(); return receipt;
  } catch (error) {
    receipt.creation_dispatched = dispatched;
    if (!dispatched) receipt.creation_status = "not_created";
    if (creating) receipt.creation_status = error.uncertain !== false ? "unknown" : "not_created";
    if (error.delivery_status) Object.assign(receipt, { delivery_status: error.delivery_status, sent: error.sent });
    if (error.message_id) Object.assign(receipt, { message_id: error.message_id, client_message_id: error.client_message_id });
    receipt.error_code = error.code ?? "DESKTOP_CLOUD_FAILED";
    if (!options.dryRun) { try { await save(); } catch { error.receipt_update_required = true; } }
    Object.assign(error, { execution_environment: "cloud", creation_status: receipt.creation_status, creation_dispatched: dispatched, thread_id: receipt.thread_id, attempt_id: attempt, receipt_path: receipt.receipt_path, sent: receipt.sent, delivery_status: receipt.delivery_status }); throw error;
  } finally { try { client?.close(); } catch { receipt.runtime_cleanup_required = true; } }
}
// A send needs the task's status, environment and newest turn, not its history.
// The newest turn is the steer candidate, and turn/steer checks expectedTurnId.
// It is marked notLoaded so that a v1 --based-on check still reads the history.
async function sendState(client, id) {
  const { thread } = await client.request("thread/read", { threadId: id, includeTurns: false }), newest = await newestTurn(client, id);
  if (thread?.id !== id) throw failure("Cannot verify the task.", "DESKTOP_CLOUD_PROTOCOL_ERROR");
  return { ...thread, turns: newest ? [{ ...newest, items: [], itemsView: "notLoaded" }] : [] };
}

export async function sendDesktopCloudInput(target, text, { dryRun = false, newTurn = false, clientMessageId = randomUUID(), beforeSend, expectedEnvironmentConfigId, initialModelSelection } = {}, { connect = connectDesktopCloud, ...storage } = {}) {
  const id = desktopCloudId(target);
  if (typeof text !== "string" || !text.trim()) throw failure("A non-empty message is required.");
  const plan = { thread_id: id, deep_link: desktopCloudLink(id), client_message_id: clientMessageId, backend: "desktop-cloud", connection_mode: "desktop-cloud", delivery_action: newTurn ? "new-turn" : "steer", dry_run: dryRun, message_characters: [...text].length };
  if (dryRun) return { ...plan, sent: false, delivery_status: "not_sent" };
  return withStoreLock(`desktop-cloud-send-${id}`, async () => {
    const pending = (await listRecords("desktop-cloud-sends", storage)).find(row => row.thread_id === id && row.delivery_status === "unknown" && !row.resolution);
    if (pending) throw Object.assign(failure(`An earlier Desktop Cloud delivery is unknown and is never replayed automatically. Run history check ${id} ${pending.client_message_id}; if it stays unconfirmed, the user (not a supervisor) can release it with history mark ${id} ${pending.client_message_id} --resolve-unknown --note TEXT.`, "DESKTOP_CLOUD_DELIVERY_PENDING"), { existing_message_id: pending.client_message_id });
    let client, dispatching = false, receipt = { ...plan, prompt_sha256: hash(text), sent: false, delivery_status: "not_sent" };
    const save = () => writeRecord("desktop-cloud-sends", clientMessageId, receipt, storage);
    try {
      client = await connect();
      // The turns decide, as they do for the member's project row: a thread
      // status left active after its last turn ended does not refuse a new
      // turn. The newest turn alone cannot show that an older turn still
      // runs, so that case is proved from every turn's status.
      const thread = await sendState(client, id), turns = turnObservation(thread.turns), evidence = turnEvidence(turns), active = thread.turns;
      const ended = async () => { const all = await turnStatuses(client, id); return !!all && turnEvidence(turnObservation(all)) === "none"; };
      const startable = !turnRuns(turns) && (thread.status?.type === "idle" || (thread.status?.type === "active" && evidence === "none" && await ended()));
      if (newTurn ? !startable : evidence !== "running") throw failure("The task state does not match the requested send. Read it again; idle continuation requires --new-turn.", "STALE_OBSERVATION");
      const environments = thread.environments;
      if (!Array.isArray(environments) || environments.length !== 1 || typeof environments[0].environmentId !== "string" || !environments[0].environmentId.startsWith("ccarenv_") || typeof environments[0].environmentConfigId !== "string") throw failure("Cannot verify the task's Cloud environment.");
      const managed = await getManagedThread(id, storage);
      if ((expectedEnvironmentConfigId && environments[0].environmentConfigId !== expectedEnvironmentConfigId) || (managed?.environment_config_id && environments[0].environmentConfigId !== managed.environment_config_id)) throw failure("The managed task environment route changed. Nothing was sent.", "DESKTOP_CLOUD_ROUTE_MISMATCH");
      if (initialModelSelection !== undefined) {
        validateCloudModelOptions(initialModelSelection);
        if (!newTurn || !expectedEnvironmentConfigId || thread.turns.length !== 0 || !initialModelSelection.model || !initialModelSelection.thinking) throw failure("Initial model settings require a verified, empty new Cloud thread.");
      }
      await beforeSend?.(thread, client);
      receipt.delivery_status = "unknown"; await save(); dispatching = true;
      const params = { threadId: id, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: clientMessageId };
      const result = await client.request(newTurn ? "turn/start" : "turn/steer", newTurn ? { ...params, environments, deferredEnvironment: true,
        ...(initialModelSelection === undefined ? {} : { model: initialModelSelection.model, effort: initialModelSelection.thinking }) } : { ...params, expectedTurnId: active[0].id }, { mutation: true });
      const turnId = newTurn ? result?.turn?.id : result?.turnId;
      if (typeof turnId !== "string" || (!newTurn && turnId !== active[0].id)) throw failure("Cloud did not confirm the expected turn. Inspect history before another send.", "DESKTOP_CLOUD_PROTOCOL_ERROR", true);
      receipt = { ...receipt, turn_id: turnId, sent: true, delivery_status: "accepted" };
      try { await save(); } catch { receipt.receipt_update_required = true; } return receipt;
    } catch (error) {
      const unknown = dispatching && error.uncertain !== false;
      receipt = { ...receipt, sent: unknown ? null : false, delivery_status: unknown ? "unknown" : "not_sent", error_code: error.code ?? "DESKTOP_CLOUD_FAILED" };
      try { await save(); } catch { error.receipt_update_required = true; }
      Object.assign(error, { uncertain: unknown, sent: receipt.sent, delivery_status: receipt.delivery_status }); throw error;
    } finally { try { client?.close(); } catch { receipt.runtime_cleanup_required = true; } }
  }, storage);
}
export async function listDesktopCloudTasks(options = {}, { connect = connectDesktopCloud } = {}) {
  if (!Number.isInteger(options.limit ?? 20) || options.limit < 1 || options.limit > 100) throw failure("--limit must be 1..100.");
  const client = await connect();
  try { const data = await client.request("thread/list", { limit: options.limit ?? 20, ...(options.cursor ? { cursor: options.cursor } : {}) });
    if (!Array.isArray(data?.data)) throw failure("Invalid task inventory.");
    return { threads: data.data.map(row => ({ thread_id: desktopCloudId(`durable_${row.id}`), deep_link: desktopCloudLink(`durable_${row.id}`), title: row.name ?? null, status: row.status })), next_cursor: data.nextCursor ?? null };
  } finally { try { client.close(); } catch { /* Do not mask the read result. */ } }
}

export async function confirmDesktopCloudDelivery(entry, verification, storage = {}) {
  if (verification.status !== "stored" || entry.delivery_status === "not_sent") return;
  const id = desktopCloudId(entry.thread_id);
  return withStoreLock(`desktop-cloud-send-${id}`, async () => {
    const receipt = await readRecord("desktop-cloud-sends", entry.client_message_id, storage);
    if (!receipt || receipt.thread_id !== id || receipt.prompt_sha256 !== hash(entry.wire_text) || receipt.delivery_status === "not_sent") return;
    await writeRecord("desktop-cloud-sends", entry.client_message_id, { ...receipt, delivery_status: "accepted", sent: true, turn_id: verification.turn_id, delivery_verification: "stored" }, storage);
  }, storage);
}
export async function resolveDesktopCloudDelivery(target, clientMessageId, resolution, storage = {}) {
  const id = desktopCloudId(target);
  return withStoreLock(`desktop-cloud-send-${id}`, async () => {
    const receipt = await readRecord("desktop-cloud-sends", clientMessageId, storage);
    if (receipt?.thread_id !== id || receipt.delivery_status !== "unknown" || receipt.resolution) throw failure("This message has no unresolved unknown Desktop Cloud delivery.");
    const updated = { ...receipt, resolution }; await writeRecord("desktop-cloud-sends", clientMessageId, updated, storage); return updated;
  }, storage);
}

// Read-only recovery: a local receipt alone cannot prove initial delivery.
export async function reconcileDesktopCloudCreation(record, { connect = connectDesktopCloud, ...storage } = {}) {
  let receipt;
  try { receipt = await desktopCloudReceipt(record.attempt_id, storage); }
  catch (error) { if (error.code === "DESKTOP_CLOUD_CREATION_RECEIPT_NOT_FOUND") return null; throw error; }
  if (receipt.environment_config_id !== record.environment_config_id || receipt.prompt_sha256 !== record.prompt_sha256) throw failure("Creation receipt does not match its environment and prompt.", "WORK_RECONCILE_MISMATCH");
  if (record.model_selection && (receipt.model_selection?.model !== record.model_selection.model || receipt.model_selection?.thinking !== record.model_selection.thinking)) throw failure("Creation receipt does not match the reserved model and effort.", "WORK_RECONCILE_MISMATCH");
  if (!receipt.thread_id) return null;
  const client = await connect();
  try {
    const thread = await fetchThread(client, receipt.thread_id);
    if (thread.environments?.length !== 1 || thread.environments[0].environmentConfigId !== record.environment_config_id) throw failure("Recovered task has another environment.", "WORK_RECONCILE_MISMATCH");
    const matches = thread.turns.flatMap(turn => turn.items ?? []).filter(item => item.type === "userMessage"
      && hash((item.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n")) === record.prompt_sha256
      // Desktop Cloud may store the message without its client ID; the journal
      // then proves delivery by the accepted turn and the message digest.
      && (!receipt.client_message_id || item.clientId === receipt.client_message_id || (item.clientId == null && receipt.message_id)));
    if (matches.length !== 1) return null;
    if (receipt.message_id) {
      const { reconcileMessages } = await import("./journal.mjs");
      const results = await reconcileMessages(receipt.thread_id, receipt.message_id, storage, { connect });
      if (results.length !== 1 || results[0].verification?.status !== "stored") return null;
    }
    await writeRecord("desktop-cloud-creations", record.attempt_id, { ...receipt, delivery_status: "accepted", sent: true, delivery_verification: "stored" }, storage);
    return { thread_id: receipt.thread_id, attempt_id: record.attempt_id, environment_config_id: record.environment_config_id,
      ...(receipt.model_selection ? { model_selection: receipt.model_selection } : {}),
      prompt_sha256: record.prompt_sha256, delivery_status: "accepted", delivery_verification: "stored" };
  } finally { client.close(); }
}
