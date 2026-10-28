import { cloudTaskId } from "./cloud-id.mjs";
import { cloudThread, CloudReadClient } from "./cloud-connection.mjs";
import { readCloudTask, sendCloudTask, cloudUserRevision } from "./cloud-observe.mjs";

export async function sendCloudInput(target, message, options = {}, dependencies = {}) {
  const taskId = cloudTaskId(target), read = dependencies.read ?? readCloudTask, send = dependencies.send ?? sendCloudTask;
  if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message) > 1024 * 1024) throw Object.assign(new Error("A non-empty cloud instruction of at most 1 MiB is required."), { code: "CLOUD_OPTIONS_INVALID" });
  if (options.dryRun) return { thread_id: taskId, task_id: taskId, backend: "codex-api", execution_environment: "cloud", delivery_action: options.newTurn ? "new-turn" : "interrupt-and-follow-up",
    message_characters: [...message].length, dry_run: true, sent: false, delivery_status: "not_sent", freshness_checked: false };
  const snapshot = await read(taskId);
  const active = cloudThread(snapshot).turns.filter(turn => turn.status === "inProgress");
  if (options.newTurn ? active.length > 0 : active.length !== 1 || active[0]?.id !== snapshot.turn_id) {
    throw Object.assign(new Error(options.newTurn ? "--new-turn requires an idle cloud task." : "The cloud task has no unambiguous selected active turn. Read it again before sending."), { code: options.newTurn ? "CLOUD_TASK_BUSY" : "CLOUD_TURN_AMBIGUOUS" });
  }
  const client = new CloudReadClient({ read });
  try {
    const receipt = await send(taskId, snapshot.turn_id, message, {
      dryRun: !!options.dryRun, basedOn: snapshot.cursor, deliveryMode: options.newTurn ? "new-turn" : "steer",
      expectedUserRevision: cloudUserRevision(snapshot),
      beforeSend: current => options.beforeSend?.(cloudThread(current), client),
    });
    return { thread_id: taskId, task_id: taskId, backend: "codex-api", execution_environment: "cloud",
      message_characters: [...message].length, dry_run: !!options.dryRun, sent: !options.dryRun,
      delivery_status: options.dryRun ? "not_sent" : "accepted", delivery_action: receipt.delivery_action,
      cloud_attempt_id: receipt.attempt_id, cloud_parent_turn_id: receipt.parent_turn_id, client_message_id: options.clientMessageId,
      turn_id: null, receipt_path: receipt.receipt_path, receipt_update_required: receipt.receipt_update_required,
      turn_identity: "follow-up; read/history-check confirms the new turn", freshness_atomic: false };
  } catch (error) {
    error.cloud_attempt_id = error.attempt_id; error.cloud_parent_turn_id = error.parent_turn_id;
    error.delivery_status = error.uncertain ? "unknown" : "not_sent"; error.sent = error.uncertain ? null : false;
    throw error;
  } finally { client.close(); }
}
