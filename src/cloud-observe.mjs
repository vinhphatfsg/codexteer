import { createHash, randomUUID } from "node:crypto";
import { cloudApi, cloudCredentials } from "./cloud-api.mjs";
import { cloudTaskId } from "./cloud-id.mjs";
import { readRecord, storePath, withStoreLock, writeRecord } from "./store.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code, execution_environment: "cloud" });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validTurn = (task, value) => typeof value === "string" && value.startsWith(`${task}~`) && /^(?:usertrn|assttrn)_[A-Za-z0-9_-]{1,200}$/.test(value.slice(task.length + 1));
export const cloudUserRevision = snapshot => digest(snapshot.turns.filter(turn => turn.role === "user").map(turn => ({ id: turn.turn_id, parent: turn.parent_turn_id, messages: turn.messages })));

function texts(items) {
  return (Array.isArray(items) ? items : []).filter(item => item?.type === "message").map(item => ({
    role: typeof item.role === "string" ? item.role : null,
    text: (Array.isArray(item.content) ? item.content : []).flatMap(part => typeof part === "string" ? [part]
      : part?.content_type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"),
  })).filter(item => item.text);
}

function publicProgress(items) {
  return (Array.isArray(items) ? items : []).flatMap(item => {
    const role = item?.role ?? item?.author?.role;
    if (role !== "assistant" || ![undefined, null, "commentary"].includes(item.channel)
      || item.type === "reasoning" || (item.recipient != null && item.recipient !== "all") || item.metadata?.is_visually_hidden_from_conversation === true
      || (item.metadata?.reasoning_status != null && item.metadata?.is_thinking_preamble_message !== true)) return [];
    let text;
    if (Array.isArray(item.content)) text = texts([{ ...item, type: "message" }])[0]?.text;
    else if (["text", "multimodal_text"].includes(item.content?.content_type) && Array.isArray(item.content.parts)) text = item.content.parts.filter(part => typeof part === "string").join("");
    if (!text) return [];
    return [{ ...(typeof item.id === "string" && item.id.length <= 512 && !/[\x00-\x1f]/u.test(item.id) ? { id: item.id } : {}), role: "assistant", text }];
  });
}

function progress(turn) {
  const items = publicProgress(turn.worklog?.messages), seen = new Set(items.flatMap(item => item.id === undefined ? [] : [item.id]));
  const latest = new Map();
  for (const event of [...(turn.thread_events?.events ?? []), ...(turn.app_server_events?.events ?? [])]) {
    const item = event?.params?.item;
    if (!["item/started", "item/completed"].includes(event?.method) || item?.type !== "agentMessage" || item.phase !== "commentary"
      || typeof item.id !== "string" || !item.id || item.id.length > 512 || /[\x00-\x1f]/u.test(item.id) || typeof item.text !== "string" || !item.text) continue;
    latest.set(item.id, { id: item.id, role: "assistant", text: item.text });
  }
  return [...items, ...[...latest.values()].filter(item => !seen.has(item.id))];
}

function commands(turn) {
  const latest = new Map();
  for (const event of [...(turn.thread_events?.events ?? []), ...(turn.app_server_events?.events ?? [])]) {
    const item = event?.params?.item;
    if (!["item/started", "item/completed"].includes(event?.method) || item?.type !== "commandExecution" || typeof item.id !== "string") continue;
    latest.set(item.id, { id: item.id, status: typeof item.status === "string" ? item.status : "unknown",
      command: typeof item.command === "string" ? item.command : null, output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
      exit_code: Number.isInteger(item.exitCode) ? item.exitCode : null });
  }
  return [...latest.values()];
}

export async function readCloudTask(target, settings = {}, { request = cloudApi } = {}) {
  const taskId = cloudTaskId(target);
  if (settings.timeoutMs !== undefined && (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 600000)) throw failure("CLOUD_OPTIONS_INVALID", "--timeout-ms must be 1000..600000.");
  const timeoutMs = settings.timeoutMs ?? 120000, deadline = Date.now() + timeoutMs;
  const details = await request(`tasks/${taskId}`, { timeoutMs, ...(settings.signal ? { signal: settings.signal } : {}) });
  if (deadline - Date.now() < 1) throw failure("CLOUD_TIMEOUT", "Cloud history deadline expired.");
  const history = await request(`tasks/${taskId}/turns`, { timeoutMs: deadline - Date.now(), ...(settings.signal ? { signal: settings.signal } : {}) });
  const current = details.current_assistant_turn;
  if (details.task?.id !== taskId || current?.role !== "assistant" || !validTurn(taskId, current?.id) || !current.id.startsWith(`${taskId}~assttrn_`) || !history.turn_mapping || typeof history.turn_mapping !== "object" || Array.isArray(history.turn_mapping)) {
    throw failure("CLOUD_PROTOCOL_UNVERIFIED", "Cloud did not confirm the requested task and its turn history.");
  }
  if (details.task.current_turn_id !== history.current_turn_id || !history.turn_mapping[current.id]) throw failure("CLOUD_STATE_CHANGED", "Cloud changed while reading. Read again before sending.");
  const nodes = Object.entries(history.turn_mapping);
  if (nodes.length > 10000 || nodes.some(([id, node]) => !validTurn(taskId, id) || node?.turn?.id !== id || (node.parent != null && !validTurn(taskId, node.parent)))) {
    throw failure("CLOUD_PROTOCOL_UNVERIFIED", "Cloud history contains an unrecognized turn identity.");
  }
  const turns = nodes.map(([id, node]) => ({ turn_id: id, parent_turn_id: node.parent ?? null,
    role: node.turn.role, status: node.turn.turn_status ?? null, created_at: node.turn.created_at ?? null,
    messages: texts(node.turn.input_items ?? node.turn.output_items),
    progress: progress(node.turn),
    commands: commands(node.turn),
  })).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.turn_id.localeCompare(b.turn_id));
  const snapshot = { task_id: taskId, turn_id: current.id, current_turn_id: history.current_turn_id, status: current.turn_status ?? "unknown",
    title: typeof details.task.title === "string" && details.task.title.length <= 2000 ? details.task.title : null, turns };
  return { backend: "codex-api", execution_environment: "cloud", ...snapshot,
    history_scope: "all-returned-turns", url: `https://chatgpt.com/codex/tasks/${taskId}` };
}

export async function sendCloudTask(target, expectedTurn, prompt, settings = {}, dependencies = {}) {
  const taskId = cloudTaskId(target);
  if (settings.timeoutMs !== undefined && (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1000 || settings.timeoutMs > 600000)) throw failure("CLOUD_OPTIONS_INVALID", "--timeout-ms must be 1000..600000.");
  if (!validTurn(taskId, expectedTurn) || typeof settings.expectedUserRevision !== "string" || !/^[a-f0-9]{64}$/.test(settings.expectedUserRevision) || !["steer", "new-turn"].includes(settings.deliveryMode)) throw failure("CLOUD_OPTIONS_INVALID", "Cloud delivery requires the exact parent turn, user-input revision and delivery mode.");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 1024 * 1024) throw failure("CLOUD_OPTIONS_INVALID", "A non-empty instruction of at most 1 MiB is required.");
  const request = dependencies.request ?? cloudApi, read = dependencies.read ?? readCloudTask;
  const write = dependencies.write ?? writeRecord, load = dependencies.load ?? readRecord, lock = dependencies.lock ?? withStoreLock;
  // Pin one official account for the read/compare/send sequence. Never refresh
  // or automatically retry an unknown submission against a different account.
  const auth = dependencies.request ? null : await cloudCredentials();
  const api = (route, options = {}) => request(route, { ...options, ...(auth ? { credentials: async () => auth } : {}) });
  try { return await lock(`cloud-send-${taskId}`, async () => {
    const observation = await read(taskId, { timeoutMs: settings.timeoutMs }, { request: api });
    if (observation.turn_id !== expectedTurn || cloudUserRevision(observation) !== settings.expectedUserRevision) throw failure("CLOUD_STATE_CHANGED", "Cloud task or user input changed after observation. Read again; no message was sent.");
    const active = ["in_progress", "pending", "queued", "running"].includes(observation.status);
    if (settings.deliveryMode === "steer" ? !active : !["completed", "failed", "cancelled"].includes(observation.status)) {
      throw failure(active ? "CLOUD_TASK_BUSY" : "CLOUD_TASK_IDLE", settings.deliveryMode === "steer"
        ? "The task has no active turn. Use --new-turn to continue an idle cloud task."
        : "A new turn requires a finished cloud turn. Nothing was sent.");
    }
    const previous = await load("cloud-send-heads", taskId);
    const safelyUnsent = previous?.submission_status === "not_sent" && previous.dispatch_started === false;
    if (previous && !safelyUnsent && (previous.submission_status !== "accepted" || previous.parent_turn_id === expectedTurn)) throw Object.assign(failure("CLOUD_DUPLICATE_SEND", "An accepted or uncertain send needs inspection before another send. Use history check <TASK> --attempt <ATTEMPT_ID>; do not resend."), { attempt_id: previous.attempt_id, receipt_path: previous.receipt_path });
    const attemptId = randomUUID();
    const receipt = { execution_environment: "cloud", backend: "codex-api", task_id: taskId, parent_turn_id: expectedTurn,
      attempt_id: attemptId, receipt_path: storePath("cloud-messages", attemptId), user_revision: settings.expectedUserRevision,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"), prompt_hash_encoding: "utf8", message_characters: [...prompt].length,
      delivery_action: active ? "interrupt-and-follow-up" : "new-turn", parent_status: observation.status, submission_status: "not_sent", dry_run: !!settings.dryRun };
    await settings.beforeSend?.(observation);
    if (settings.dryRun) return receipt;
    const dispatched = { ...receipt, submission_status: "dispatching" };
    try {
      await write("cloud-messages", attemptId, receipt);
      // Finish receipt persistence before reserving the head. There must be no
      // fallible persistence between the reservation and the single POST.
      await write("cloud-messages", attemptId, dispatched);
      await write("cloud-send-heads", taskId, dispatched);
    } catch {
      const unsent = { ...receipt, dispatch_started: false, error_code: "CLOUD_PERSISTENCE_FAILED" };
      try { await write("cloud-send-heads", taskId, previous ?? unsent); }
      catch { unsent.reservation_cleanup_required = true; unsent.receipt_update_required = true; }
      try { await write("cloud-messages", attemptId, unsent); }
      catch { unsent.receipt_update_required = true; }
      throw Object.assign(failure("CLOUD_PERSISTENCE_FAILED", "Cloud send records could not be prepared. No request was sent. Inspect the receipt and reservation before an explicit retry."), unsent, { uncertain: false });
    }
    let response;
    try {
      response = await api("tasks", { timeoutMs: settings.timeoutMs, body: {
        follow_up: { task_id: taskId, turn_id: expectedTurn, environment_mode: "code" },
        input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: prompt }] }],
      } });
      if ((response.task?.id ?? response.id) !== taskId) throw failure("CLOUD_PROTOCOL_UNVERIFIED", "Cloud did not confirm the same task after follow-up.");
      receipt.submission_status = "accepted";
    } catch (error) {
      receipt.submission_status = "unknown";
      receipt.error_code = error.code ?? "CLOUD_SEND_FAILED";
      try { await write("cloud-messages", attemptId, receipt); } catch { receipt.receipt_update_required = true; }
      throw Object.assign(failure(receipt.error_code, "Cloud follow-up outcome is unknown. Read this task and inspect the receipt before retrying; no automatic retry was made."), receipt, { uncertain: true });
    }
    try { await write("cloud-messages", attemptId, receipt); await write("cloud-send-heads", taskId, receipt); } catch { receipt.receipt_update_required = true; }
    return receipt;
  }); } finally { if (auth) auth.token = ""; }
}

export async function cloudSendReceipt(attemptId, { load = readRecord, taskId } = {}) {
  if (typeof attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)) throw failure("CLOUD_OPTIONS_INVALID", "A cloud send attempt UUID is required.");
  const receipt = await load("cloud-messages", attemptId);
  if (!receipt) throw failure("CLOUD_RECEIPT_NOT_FOUND", "Cloud send receipt was not found.");
  if (taskId !== undefined && cloudTaskId(receipt.task_id) !== cloudTaskId(taskId)) throw failure("CLOUD_TARGET_CONFLICT", "The send attempt belongs to another cloud task.");
  return receipt;
}

export async function reconcileCloudSend(attemptId, { read = readCloudTask, load = readRecord, write = writeRecord, lock = withStoreLock, taskId: expectedTask } = {}) {
  const receipt = await cloudSendReceipt(attemptId, { load, taskId: expectedTask });
  const taskId = cloudTaskId(receipt.task_id);
  return lock(`cloud-send-${taskId}`, async () => {
    if (receipt.submission_status === "not_sent" && receipt.dispatch_started === false) {
      if ((await load("cloud-send-heads", taskId))?.attempt_id === attemptId) await write("cloud-send-heads", taskId, receipt);
      return { ...receipt, delivery_verification: "not_sent", retry_safe: true, reservation_cleanup_required: false };
    }
    const snapshot = await read(taskId);
    const matches = snapshot.turns.filter(turn => turn.role === "user" && turn.parent_turn_id === receipt.parent_turn_id
      && turn.messages.some(message => createHash("sha256").update(message.text).digest("hex") === receipt.prompt_sha256));
    if (matches.length !== 1) return { ...receipt, delivery_verification: "not_observed", retry_safe: false };
    Object.assign(receipt, { submission_status: "accepted", delivery_verification: "stored", user_turn_id: matches[0].turn_id });
    await write("cloud-messages", attemptId, receipt);
    if ((await load("cloud-send-heads", taskId))?.attempt_id === attemptId) await write("cloud-send-heads", taskId, receipt);
    return receipt;
  });
}
