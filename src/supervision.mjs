import { isDesktopCloudTask } from "./desktop-cloud-id.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { targetHost, remoteReadOnly, remoteTransport, isControlTransport } from "./target.mjs";
import { normalizeTaskId, isCloudTask } from "./task-id.mjs";
import { isAlive } from "./runtime.mjs";

const failure = (message, code) => Object.assign(new Error(message), { code });
const states = new Set(["active", "paused", "stopped"]);
const supervisorBucket = id => (isCloudTask(id) || isDesktopCloudTask(id)) ? "cloud-supervisors" : "supervisors";
function launcherAlive(record) {
  if (record.launcher_pid === null) return null;
  try { return isAlive(record.launcher_pid); }
  catch (error) {
    if (error.code === "PERMISSION_DENIED") throw failure("Cannot verify the supervisor launcher process. This execution sandbox may deny process inspection; no liveness was inferred.", "PERMISSION_DENIED");
    throw error;
  }
}

export function supervisorId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw failure("Invalid supervisor session ID.", "SUPERVISOR_INVALID");
  return value.toLowerCase();
}

// Keep retired generations in the same atomic record as the current owner.
// A legacy stopped record contributes its ID even before its first rewrite.
function stoppedSessionIds(record) {
  return [...new Set([...(record?.stopped_session_ids ?? []), ...(record?.state === "stopped" ? [record.session_id] : [])])];
}

function assertNotStopped(record, sessionId) {
  if (stoppedSessionIds(record).includes(sessionId)) throw failure("This supervisor session has stopped. Start a new supervisor when needed.", "SUPERVISOR_STOPPED");
}

async function supervisorRecords(storage) {
  return (await Promise.all([listRecords("supervisors", storage), listRecords("cloud-supervisors", storage)])).flat().filter(Boolean);
}

async function assertSessionBinding(threadId, sessionId, storage) {
  const others = (await supervisorRecords(storage)).filter(record => record.thread_id !== threadId);
  // A stopped ID stays retired even when a caller changes its target task.
  for (const record of others) assertNotStopped(record, sessionId);
  if (others.some(record => record.session_id === sessionId)) throw failure("This supervisor session is already registered for another task. Start a new supervisor for this task.", "SUPERVISOR_CONFLICT");
}

export async function getSupervisor(threadInput, storage = {}) {
  const threadId = normalizeTaskId(threadInput), record = await readRecord(supervisorBucket(threadId), threadId, storage);
  if (!record) return null;
  if (record.schema !== 1 || record.thread_id !== threadId || !states.has(record.state)
    || !["shared", "desktop", "cloud", "desktop-cloud"].includes(record.connection)
    || supervisorId(record.session_id) !== record.session_id || typeof record.owner !== "string"
    || (record.stopped_session_ids !== undefined && (!Array.isArray(record.stopped_session_ids)
      || record.stopped_session_ids.some(id => supervisorId(id) !== id)))
    || (record.launcher_pid !== null && (!Number.isSafeInteger(record.launcher_pid) || record.launcher_pid <= 0))) {
    throw failure("Invalid supervisor state. Inspect the local record before continuing.", "SUPERVISOR_INVALID");
  }
  return record;
}

export async function assertSupervisor(threadInput, sessionInput, { sending = false, connection, ...storage } = {}) {
  const threadId = normalizeTaskId(threadInput), sessionId = supervisorId(sessionInput), record = await getSupervisor(threadId, storage);
  assertNotStopped(record, sessionId);
  await assertSessionBinding(threadId, sessionId, storage);
  if (!record) throw failure("Register this supervisor session before observing or sending.", "SUPERVISOR_NOT_REGISTERED");
  if (record.session_id !== sessionId) throw failure("Another supervisor session owns this task. This command belongs to an older or different session.", "SUPERVISOR_MISMATCH");
  if (connection !== undefined && record.connection !== connection) throw failure("The supervisor is registered for another connection. Keep the original command intact.", "SUPERVISOR_MISMATCH");
  if (targetHost() !== "local" && (record.remote_transport ?? "native") !== remoteTransport()) throw failure("The supervisor belongs to a different remote transport. Keep the generated route intact.", "SUPERVISOR_MISMATCH");
  if (launcherAlive(record) === false) throw failure("The supervisor launcher exited. Stop the stale session before starting another supervisor.", "SUPERVISOR_ORPHANED");
  if (sending && record.state === "paused") throw failure("Automatic intervention is paused. Observation can continue; only the user should resume intervention.", "SUPERVISOR_PAUSED");
  return record;
}

// Read-only bootstrap check shared by doctor and registration. Registration
// repeats it under the task lock; a successful doctor does not reserve an ID.
export async function assertSupervisorRegistration(threadInput, sessionInput, { connection, ...storage } = {}) {
  const threadId = normalizeTaskId(threadInput), sessionId = supervisorId(sessionInput), current = await getSupervisor(threadId, storage);
  assertNotStopped(current, sessionId);
  await assertSessionBinding(threadId, sessionId, storage);
  if (current?.session_id === sessionId) return assertSupervisor(threadInput, sessionId, { connection, ...storage });
  if (current && current.state !== "stopped") throw failure("A supervisor already owns this task. Use supervise status, then stop it explicitly before replacing it.", "SUPERVISOR_CONFLICT");
  return current;
}

export async function registerSupervisor(threadInput, sessionInput, { owner = "external", launcherPid = null, connection = "shared", ...storage } = {}) {
  const threadId = normalizeTaskId(threadInput), sessionId = supervisorId(sessionInput);
  if (typeof owner !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(owner)) throw failure("Supervisor owner must be a short agent name.", "SUPERVISOR_INVALID");
  if (launcherPid !== null && (!Number.isSafeInteger(launcherPid) || launcherPid <= 0)) throw failure("Invalid supervisor launcher PID.", "SUPERVISOR_INVALID");
  if (!["shared", "desktop", "cloud", "desktop-cloud"].includes(connection)) throw failure("Invalid supervisor connection.", "SUPERVISOR_INVALID");
  // Registrations take the namespace-wide lock before the task lock. Stop,
  // pause and sends only take the task lock and never acquire in reverse order.
  return withStoreLock("supervisor-registration", () => withStoreLock(`supervisor-${threadId}`, async () => {
    const current = await assertSupervisorRegistration(threadId, sessionId, { connection, ...storage });
    if (current?.session_id === sessionId) return current;
    const now = new Date().toISOString();
    const record = { schema: 1, thread_id: threadId, session_id: sessionId, owner, launcher_pid: launcherPid, connection,
      state: "active", stopped_session_ids: stoppedSessionIds(current), registered_at: now, updated_at: now, last_delivery: null };
    await writeRecord(supervisorBucket(threadId), threadId, record, storage);
    return record;
  }, storage), storage);
}

export async function controlSupervisor(threadInput, action, { expectedSession, ...storage } = {}) {
  const threadId = normalizeTaskId(threadInput);
  if (!["pause", "resume", "stop"].includes(action)) throw failure("Expected pause, resume or stop.", "SUPERVISOR_INVALID");
  return withStoreLock(`supervisor-${threadId}`, async () => {
    const record = await getSupervisor(threadId, storage);
    if (!record) throw failure("No supervisor is registered for this task.", "SUPERVISOR_NOT_REGISTERED");
    if (targetHost() !== "local" && (record.remote_transport ?? "native") !== remoteTransport()) throw failure("Keep the registered remote transport when controlling this supervisor. No state was changed.", "SUPERVISOR_MISMATCH");
    if (expectedSession && record.session_id !== supervisorId(expectedSession)) throw failure("The supervisor session changed.", "SUPERVISOR_MISMATCH");
    if (record.state === "stopped" && action !== "stop") throw failure("A stopped supervisor cannot be resumed. Start a new supervisor.", "SUPERVISOR_STOPPED");
    if (action === "resume") await assertSupervisor(threadId, record.session_id, storage);
    const updated = { ...record, state: { pause: "paused", resume: "active", stop: "stopped" }[action], updated_at: new Date().toISOString() };
    updated.stopped_session_ids = stoppedSessionIds(updated);
    await writeRecord(supervisorBucket(threadId), threadId, updated, storage);
    return updated;
  }, storage);
}

export async function supervisorStatus(threadInput, { allowObservationConflict = false, ...storage } = {}) {
  const threadId = normalizeTaskId(threadInput), record = await getSupervisor(threadId, storage);
  if (!record) return { thread_id: threadId, state: "unregistered", observation: null };
  let observation = await readRecord("supervisor-observations", record.session_id, storage), observationError;
  if (allowObservationConflict && observation?.schema === 1 && observation.session_id === record.session_id && observation.thread_id !== threadId) {
    observationError = { code: "SUPERVISOR_INVALID", message: "The observation belongs to another task.", thread_id: observation.thread_id };
    observation = null;
  }
  if (observation && (observation.schema !== 1 || observation.thread_id !== threadId || observation.session_id !== record.session_id)) throw failure("Invalid supervisor observation record.", "SUPERVISOR_INVALID");
  return { ...record, launcher_alive: launcherAlive(record), ...(observationError ? { observation_error: observationError } : {}),
    observation, observation_age_ms: observation?.last_observed_at ? Math.max(0, Date.now() - Date.parse(observation.last_observed_at)) : null };
}

export async function listSupervisors(storage = {}) {
  const records = await supervisorRecords(storage);
  return Promise.all(records.map(async record => {
    const status = await supervisorStatus(record.thread_id, { ...storage, allowObservationConflict: true });
    const conflicts = records.filter(other => other.session_id === record.session_id).map(other => other.thread_id);
    return conflicts.length > 1 ? { ...status, session_conflict: { thread_ids: conflicts.sort() } } : status;
  }));
}

// Observation has its own record so a concurrent read never overwrites pause/stop.
// This timestamp records CLI observation, not acknowledgement by the supervising AI.
export async function recordSupervisorObservation(threadInput, sessionInput, data, storage = {}) {
  const threadId = normalizeTaskId(threadInput), sessionId = supervisorId(sessionInput);
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

export async function withSupervisedMutation(threadInput, sessionInput, mutate, { connection, ...storage } = {}) {
  if (targetHost() !== "local" && !isControlTransport()) throw remoteReadOnly();
  if (sessionInput === undefined) return mutate();
  const threadId = normalizeTaskId(threadInput), sessionId = supervisorId(sessionInput);
  // Holding this lock through the receipt serializes pause/stop with the actual
  // mutation. A busy pause is an error, never a false acknowledgement of a stop.
  return withStoreLock(`supervisor-${threadId}`, async () => {
    const record = await assertSupervisor(threadId, sessionId, { ...storage, sending: true, connection });
    return mutate(record);
  }, storage);
}

export async function withSupervisedSend(threadInput, sessionInput, send, { connection, ...storage } = {}) {
  return withSupervisedMutation(threadInput, sessionInput, async record => {
    if (!record) return send();
    const threadId = record.thread_id;
    try {
      const receipt = await send();
      try { await writeRecord(supervisorBucket(threadId), threadId, { ...record, updated_at: new Date().toISOString(), last_error: null,
        last_delivery: { message_id: receipt.message_id ?? null, status: receipt.delivery_status, at: new Date().toISOString() } }, storage); }
      catch { receipt.supervision_update_required = true; }
      return receipt;
    } catch (error) {
      try { await writeRecord(supervisorBucket(threadId), threadId, { ...record, updated_at: new Date().toISOString(),
        last_error: { code: error.code ?? "SEND_FAILED", existing_message_id: error.existing_message_id ?? null, at: new Date().toISOString() },
        ...(error.message_id ? { last_delivery: { message_id: error.message_id, status: error.delivery_status ?? "not_sent", code: error.code, at: new Date().toISOString() } } : {}) }, storage); }
      catch { error.supervision_update_required = true; }
      throw error;
    }
  }, { connection, ...storage });
}
