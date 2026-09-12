import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { discoverRuntime, verifyControlEndpoint } from "./runtime.mjs";
import { RpcClient, RpcFailure } from "./rpc.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { ensureDesktopSubscription } from "./subscription.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { turnMetadata } from "./paged-read.mjs";

export class SendFailure extends Error {
  constructor(message, { code = "NOT_SENT", uncertain = false, threadId, rpcCode, capability, operation } = {}) {
    super(message);
    this.code = code;
    this.delivery_status = uncertain ? "unknown" : "not_sent";
    this.sent = uncertain ? null : false;
    this.thread_id = threadId;
    this.rpc_code = rpcCode;
    this.capability = capability;
    this.operation = operation;
  }
}

function activeTurn(thread) {
  const turns = thread.turns?.filter(turn => turn.status === "inProgress") ?? [];
  return thread.status?.type === "active" && turns.length === 1 ? turns[0] : null;
}

function verifyThread(thread, threadId) {
  if (thread?.id !== threadId) throw new Error("App Server returned a different task ID. Nothing was sent.");
  if (thread.canAcceptDirectInput === false) throw new Error("This task does not accept direct input.");
  if (!Array.isArray(thread.turns)) throw new Error("App Server did not return the task's turn state.");
}

export async function readSendState(client, threadId) {
  const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
  verifyThread(thread, threadId);
  if (thread.historyMode !== "paginated") {
    const full = (await client.request("thread/read", { threadId, includeTurns: true })).thread;
    verifyThread(full, threadId);
    return full;
  }
  // Steering needs turn IDs/statuses, not the potentially huge item bodies.
  // Mark these summaries incomplete so legacy --based-on checks still fetch
  // their required evidence instead of mistaking them for full history.
  const turns = (await turnMetadata(client, threadId)).map(turn => ({ ...turn, itemsView: "notLoaded" }));
  const current = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
  verifyThread(current, threadId);
  if (current.historyMode !== "paginated" || current.status?.type !== thread.status?.type) {
    throw Object.assign(new Error("The task changed while checking turn state. Read it again before sending."), { code: "STALE_OBSERVATION" });
  }
  return { ...current, turns };
}

export async function sendOnClient(client, threadId, message, { newTurn = false, subscribe, clientMessageId = randomUUID(), beforeSend } = {}) {
  const thread = await readSendState(client, threadId);
  const input = [{ type: "text", text: message }];
  if (!newTurn) {
    const turn = activeTurn(thread);
    if (!turn) throw new Error("The task has no unambiguous active turn. Use --new-turn for an idle task.");
    await beforeSend?.(thread, client);
    // Desktop uses clientId on the resulting userMessage to render external
    // steering as a user bubble instead of just an anonymous "steered" marker.
    // This is a presentation/correlation ID, not a retry/idempotency guarantee.
    const clientUserMessageId = clientMessageId;
    const accepted = await client.request("turn/steer", { threadId, expectedTurnId: turn.id, input, clientUserMessageId }, { mutation: true });
    if (accepted?.turnId !== turn.id) throw new RpcFailure("App Server returned an unexpected turn ID. Do not retry automatically.", { code: "PROTOCOL_ERROR", uncertain: true });
    return { turn_id: accepted.turnId, client_message_id: clientUserMessageId };
  }
  if (!["idle", "notLoaded"].includes(thread.status?.type) || thread.turns.some(turn => turn.status === "inProgress")) throw new Error("--new-turn requires an idle task. Nothing was sent.");
  // Resume through Desktop's long-lived connection so approval ownership
  // survives the short-lived sender. Never resume only on the sender connection.
  if (!subscribe) throw new Error("Desktop subscription support is required for --new-turn.");
  // Optional safety checks (e.g. a paged --based-on cursor) must be usable before
  // resuming, too. Validate again after resume to catch intervening user input.
  await beforeSend?.(thread, client);
  await subscribe(threadId);
  const resumed = await readSendState(client, threadId);
  if (resumed.status?.type !== "idle" || resumed.turns.some(turn => turn.status === "inProgress")) throw new Error("Task became active while resuming. Nothing was sent.");
  await beforeSend?.(resumed, client);
  const clientUserMessageId = clientMessageId;
  const accepted = await client.request("turn/start", { threadId, input, clientUserMessageId }, { mutation: true });
  if (typeof accepted?.turn?.id !== "string") throw new RpcFailure("App Server did not confirm a turn ID. Do not retry automatically.", { code: "PROTOCOL_ERROR", uncertain: true });
  return { turn_id: accepted.turn.id, client_message_id: clientUserMessageId };
}

export async function sendAppServerMessage(threadInput, message, { dryRun = false, newTurn = false, clientMessageId = randomUUID(), beforeSend, connect = RpcClient.connect, discover = discoverRuntime, subscribe = ensureDesktopSubscription, inspectControl = verifyControlEndpoint } = {}) {
  const threadId = normalizeThreadId(threadInput);
  if (typeof message !== "string" || !message.trim()) throw new Error("Message must not be empty.");
  const plan = { thread_id: threadId, backend: "app-server", delivery_action: newTurn ? "new-turn" : "steer", message_characters: [...message].length, dry_run: dryRun };
  if (dryRun) return { ...plan, sent: false, delivery_status: "not_sent" };
  let client;
  let lock;
  let result;
  const token = randomUUID();
  const operation = newTurn ? "send_new_turn" : "send";
  try {
    const { paths, state } = await discover();
    assertRuntimeOperation(state, operation);
    if (newTurn) await inspectControl(paths);
    const candidate = path.join(paths.lease, `send-${threadId}`);
    try { await mkdir(candidate, { mode: 0o700 }); } catch (error) {
      if (error.code === "EEXIST") throw new Error("Another send is in progress for this task, or a previous sender exited unexpectedly. Restart the shared Desktop after checking delivery before retrying.");
      throw error;
    }
    lock = candidate;
    await writeFile(path.join(lock, "owner"), token, { mode: 0o600 });
    client = compatibleClient(await connect(paths.socket), state);
    const checkRuntime = async () => {
      const current = await discover(); assertRuntimeOperation(current.state, operation);
      if (current.state.instance !== state.instance || current.paths.socket !== paths.socket || (newTurn && current.paths.control !== paths.control)) {
        throw Object.assign(new Error("Runtime changed before delivery. Read the target again before sending."), { code: "RUNTIME_CHANGED" });
      }
      if (newTurn) await inspectControl(current.paths);
    };
    const receipt = await sendOnClient(client, threadId, message, { newTurn, clientMessageId,
      beforeSend: async (...args) => { await beforeSend?.(...args); await checkRuntime(); },
      subscribe: async id => { await checkRuntime(); return subscribe(paths.control, id); },
    });
    result = { ...plan, ...receipt, sent: true, delivery_status: "accepted" };
    return result;
  } catch (error) {
    throw new SendFailure(error.uncertain
      ? "Delivery is unknown because App Server did not confirm receipt. Check the target task before retrying."
      : error.message, { code: error.code ?? "NOT_SENT", uncertain: error.uncertain, threadId, rpcCode: error.rpcCode, capability: error.capability, operation: error.operation });
  } finally {
    // Cleanup failure must never turn an acknowledged send into a retryable
    // error. Keep its acceptance receipt and leave any stale lock fail-closed.
    try {
      client?.close();
      if (lock && await readFile(path.join(lock, "owner"), "utf8").catch(() => null) === token) {
        await rm(lock, { recursive: true, force: true });
      }
    } catch { if (result) result.runtime_cleanup_required = true; }
  }
}
