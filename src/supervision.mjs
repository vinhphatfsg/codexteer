import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { isAlive } from "./runtime.mjs";

const failure = (message, code) => Object.assign(new Error(message), { code });
const states = new Set(["active", "paused", "stopped"]);

export function supervisorId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw failure("Invalid supervisor session ID.", "SUPERVISOR_INVALID");
  return value.toLowerCase();
}

export async function getSupervisor(threadInput, storage = {}) {
  const threadId = normalizeThreadId(threadInput), record = await readRecord("supervisors", threadId, storage);
  if (!record) return null;
  if (record.schema !== 1 || record.thread_id !== threadId || !states.has(record.state)
    || !["shared", "desktop"].includes(record.connection)
    || supervisorId(record.session_id) !== record.session_id || typeof record.owner !== "string"
    || (record.launcher_pid !== null && (!Number.isSafeInteger(record.launcher_pid) || record.launcher_pid <= 0))) {
    throw failure("Invalid supervisor state. Inspect the local record before continuing.", "SUPERVISOR_INVALID");
  }
  return record;
}

export async function assertSupervisor(threadInput, sessionInput, { sending = false, connection, ...storage } = {}) {
  const sessionId = supervisorId(sessionInput), record = await getSupervisor(threadInput, storage);
  if (!record) throw failure("Register this supervisor session before observing or sending.", "SUPERVISOR_NOT_REGISTERED");
  if (record.session_id !== sessionId) throw failure("Another supervisor session owns this task. This command belongs to an older or different session.", "SUPERVISOR_MISMATCH");
  if (connection !== undefined && record.connection !== connection) throw failure("The supervisor is registered for another connection. Keep the original command intact.", "SUPERVISOR_MISMATCH");
  if (record.state === "stopped") throw failure("This supervisor session has stopped. Start a new supervisor when needed.", "SUPERVISOR_STOPPED");
  if (record.launcher_pid !== null && !isAlive(record.launcher_pid)) throw failure("The supervisor launcher exited. Stop the stale session before starting another supervisor.", "SUPERVISOR_ORPHANED");
  if (sending && record.state === "paused") throw failure("Automatic intervention is paused. Observation can continue; only the user should resume intervention.", "SUPERVISOR_PAUSED");
  return record;
}

export async function registerSupervisor(threadInput, sessionInput, { owner = "external", launcherPid = null, connection = "shared", ...storage } = {}) {
  const threadId = normalizeThreadId(threadInput), sessionId = supervisorId(sessionInput);
  if (typeof owner !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(owner)) throw failure("Supervisor owner must be a short agent name.", "SUPERVISOR_INVALID");
  if (launcherPid !== null && (!Number.isSafeInteger(launcherPid) || launcherPid <= 0)) throw failure("Invalid supervisor launcher PID.", "SUPERVISOR_INVALID");
  if (!["shared", "desktop"].includes(connection)) throw failure("Invalid supervisor connection.", "SUPERVISOR_INVALID");
  return withStoreLock(`supervisor-${threadId}`, async () => {
    const current = await getSupervisor(threadId, storage);
    if (current?.session_id === sessionId) {
      if (current.connection !== connection) throw failure("The supervisor is registered for another connection. Keep the original command intact.", "SUPERVISOR_MISMATCH");
      return assertSupervisor(threadId, sessionId, storage);
    }
    if (current && current.state !== "stopped") throw failure("A supervisor already owns this task. Use supervise status, then stop it explicitly before replacing it.", "SUPERVISOR_CONFLICT");
    const now = new Date().toISOString();
    const record = { schema: 1, thread_id: threadId, session_id: sessionId, owner, launcher_pid: launcherPid, connection,
      state: "active", registered_at: now, updated_at: now, last_delivery: null };
    await writeRecord("supervisors", threadId, record, storage);
    return record;
  }, storage);
}

export async function controlSupervisor(threadInput, action, { expectedSession, ...storage } = {}) {
  const threadId = normalizeThreadId(threadInput);
  if (!["pause", "resume", "stop"].includes(action)) throw failure("Expected pause, resume or stop.", "SUPERVISOR_INVALID");
  return withStoreLock(`supervisor-${threadId}`, async () => {
    const record = await getSupervisor(threadId, storage);
    if (!record) throw failure("No supervisor is registered for this task.", "SUPERVISOR_NOT_REGISTERED");
    if (expectedSession && record.session_id !== supervisorId(expectedSession)) throw failure("The supervisor session changed.", "SUPERVISOR_MISMATCH");
    if (record.state === "stopped" && action !== "stop") throw failure("A stopped supervisor cannot be resumed. Start a new supervisor.", "SUPERVISOR_STOPPED");
    if (action === "resume") await assertSupervisor(threadId, record.session_id, storage);
    const updated = { ...record, state: { pause: "paused", resume: "active", stop: "stopped" }[action], updated_at: new Date().toISOString() };
    await writeRecord("supervisors", threadId, updated, storage);
    return updated;
  }, storage);
}

export async function supervisorStatus(threadInput, storage = {}) {
  const threadId = normalizeThreadId(threadInput), record = await getSupervisor(threadId, storage);
  if (!record) return { thread_id: threadId, state: "unregistered", observation: null };
  const observation = await readRecord("supervisor-observations", record.session_id, storage);
  if (observation && (observation.schema !== 1 || observation.thread_id !== threadId || observation.session_id !== record.session_id)) throw failure("Invalid supervisor observation record.", "SUPERVISOR_INVALID");
  return { ...record, launcher_alive: record.launcher_pid === null ? null : isAlive(record.launcher_pid),
    observation, observation_age_ms: observation?.last_observed_at ? Math.max(0, Date.now() - Date.parse(observation.last_observed_at)) : null };
}

export async function listSupervisors(storage = {}) {
  const records = await listRecords("supervisors", storage);
  return Promise.all(records.filter(Boolean).map(record => supervisorStatus(record.thread_id, storage)));
}

// Observation has its own record so a concurrent read never overwrites pause/stop.
// This timestamp records CLI observation, not acknowledgement by the supervising AI.
export async function recordSupervisorObservation(threadInput, sessionInput, data, storage = {}) {
  const threadId = normalizeThreadId(threadInput), sessionId = supervisorId(sessionInput);
  await assertSupervisor(threadId, sessionId, storage);
  const key = `supervisor-observe-${sessionId}`;
  try {
    return await withStoreLock(key, async () => {
      const old = await readRecord("supervisor-observations", sessionId, storage);
      const now = new Date().toISOString(), connected = data.type !== "connection" || ["watching", "recovered"].includes(data.state);
      const observed = connected ? data.last_observed_at ?? data.observed_at ?? now : old?.last_observed_at ?? null;
      const observation = { schema: 1, thread_id: threadId, session_id: sessionId, updated_at: now,
        connection: data.type === "connection" ? data.state : "observed",
        last_observed_at: old?.last_observed_at && old.last_observed_at > observed ? old.last_observed_at : observed,
        cause_code: data.cause_code ?? null };
      await writeRecord("supervisor-observations", sessionId, observation, storage);
      return true;
    }, storage);
  } catch (error) { if (error.code === "RECORD_BUSY") return false; throw error; }
}

// Diagnostics must not mask the original read/transport failure or revive a
// stopped/replaced session. State remains separate from the last observation.
export async function recordSupervisorFailure(threadId, sessionId, error, storage = {}) {
  try { await recordSupervisorObservation(threadId, sessionId, { type: "connection", state: error.watch?.state ?? "failed", cause_code: error.code ?? "OBSERVATION_FAILED" }, storage); }
  catch { /* The original failure is returned to the consumer. */ }
}

export async function withSupervisedSend(threadInput, sessionInput, send, { connection, ...storage } = {}) {
  if (sessionInput === undefined) return send();
  const threadId = normalizeThreadId(threadInput), sessionId = supervisorId(sessionInput);
  // Holding this lock through the receipt serializes pause/stop with the actual
  // mutation. A busy pause is an error, never a false acknowledgement of a stop.
  return withStoreLock(`supervisor-${threadId}`, async () => {
    const record = await assertSupervisor(threadId, sessionId, { ...storage, sending: true, connection });
    try {
      const receipt = await send();
      try { await writeRecord("supervisors", threadId, { ...record, updated_at: new Date().toISOString(), last_error: null,
        last_delivery: { message_id: receipt.message_id ?? null, status: receipt.delivery_status, at: new Date().toISOString() } }, storage); }
      catch { receipt.supervision_update_required = true; }
      return receipt;
    } catch (error) {
      try { await writeRecord("supervisors", threadId, { ...record, updated_at: new Date().toISOString(),
        last_error: { code: error.code ?? "SEND_FAILED", existing_message_id: error.existing_message_id ?? null, at: new Date().toISOString() },
        ...(error.message_id ? { last_delivery: { message_id: error.message_id, status: error.delivery_status ?? "not_sent", code: error.code, at: new Date().toISOString() } } : {}) }, storage); }
      catch { error.supervision_update_required = true; }
      throw error;
    }
  }, storage);
}
