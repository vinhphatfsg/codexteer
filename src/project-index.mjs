import { createHash } from "node:crypto";
import { normalizeTaskId } from "./task-id.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";
import { hostFields } from "./target.mjs";

const bucket = "project-index";
const connections = new Set(["shared", "desktop", "cloud", "desktop-cloud"]);
const transports = new Set(["native", "control", "paired"]);
const fail = (message, code = "PROJECT_INDEX_INVALID") => Object.assign(new Error(message), { code });
const optionalString = value => value === undefined || value === null || (typeof value === "string" && value.length > 0);

function key(threadId) {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 40);
}

function validate(record, threadId) {
  if (!record || record.schema !== 1 || record.thread_id !== threadId || typeof record.project_id !== "string" || !record.project_id
    || !connections.has(record.connection) || !optionalString(record.host_id)
    || (record.remote_transport !== undefined && record.remote_transport !== null && !transports.has(record.remote_transport))
    || !optionalString(record.environment_config_id) || !optionalString(record.backend_project_id) || !optionalString(record.creation_attempt_id)
    || (record.policy_sha256 !== undefined && record.policy_sha256 !== null && !/^[a-f0-9]{64}$/.test(record.policy_sha256))
    || (record.sync_revision !== undefined && (!Number.isSafeInteger(record.sync_revision) || record.sync_revision < 0))
    || !optionalString(record.sync_cursor)) throw fail("Invalid managed project membership. Inspect the local project index before continuing.");
  for (const forbidden of ["state", "supervisor_state", "session_id", "generation"]) {
    if (Object.hasOwn(record, forbidden)) throw fail("Project membership must not duplicate supervisor control state.");
  }
  return record;
}

// Lock order: a project-index lock protects only this membership write and is
// always released before any supervisor/message lock is acquired. No code may
// hold a project-index lock while calling supervision or delivery operations.
export async function registerManagedThread(threadInput, membership, storage = {}) {
  const threadId = normalizeTaskId(threadInput);
  if (!membership || typeof membership !== "object" || Array.isArray(membership)) throw fail("Managed project membership is required.");
  const record = validate({ schema: 1, thread_id: threadId, project_id: membership.projectId, connection: membership.connection,
    ...(membership.hostId === undefined ? {} : { host_id: membership.hostId }),
    ...(membership.remoteTransport === undefined ? {} : { remote_transport: membership.remoteTransport }),
    ...(membership.environmentConfigId === undefined ? {} : { environment_config_id: membership.environmentConfigId }),
    ...(membership.backendProjectId === undefined ? {} : { backend_project_id: membership.backendProjectId }),
    ...(membership.creationAttemptId === undefined ? {} : { creation_attempt_id: membership.creationAttemptId }),
    ...(membership.policySha256 === undefined ? {} : { policy_sha256: membership.policySha256 }),
    ...(membership.syncCursor === undefined ? {} : { sync_cursor: membership.syncCursor }),
    ...hostFields(), registered_at: new Date().toISOString() }, threadId);
  return withStoreLock(`project-index-${key(threadId)}`, async () => {
    const current = await readRecord(bucket, key(threadId), storage);
    if (current) {
      validate(current, threadId);
      const registration = value => {
        const { registered_at, sync_cursor, sync_revision, ...identity } = value;
        return identity;
      };
      if (JSON.stringify(registration(current)) !== JSON.stringify(registration(record))) throw fail("Managed project membership already exists with a different route.", "PROJECT_INDEX_CONFLICT");
      return current;
    }
    await writeRecord(bucket, key(threadId), record, storage);
    return record;
  }, storage);
}

export async function getManagedThread(threadInput, storage = {}) {
  const threadId = normalizeTaskId(threadInput), record = await readRecord(bucket, key(threadId), storage);
  return record ? validate(record, threadId) : null;
}

export async function listManagedThreads(projectId, storage = {}) {
  if (typeof projectId !== "string" || !projectId) throw fail("A project ID is required.");
  const records = await listRecords(bucket, storage), result = [];
  for (const record of records) if (record?.project_id === projectId) result.push(validate(record, record.thread_id));
  return result.sort((a, b) => a.thread_id.localeCompare(b.thread_id));
}

export async function updateManagedThreadCursor(threadInput, expectedCursor, syncCursor, storage = {}, expectedRevision = 0) {
  const threadId = normalizeTaskId(threadInput);
  if (typeof syncCursor !== "string" || !syncCursor) throw fail("A sync cursor is required.");
  return withStoreLock(`project-index-${key(threadId)}`, async () => {
    const current = await readRecord(bucket, key(threadId), storage);
    if (!current) throw fail("Managed project membership was not found.", "PROJECT_INDEX_NOT_FOUND");
    validate(current, threadId);
    if ((current.sync_cursor ?? null) !== (expectedCursor ?? null) || (current.sync_revision ?? 0) !== expectedRevision) throw fail("Another sync advanced this membership.", "SYNC_CURSOR_CONFLICT");
    const record = validate({ ...current, sync_cursor: syncCursor, sync_revision: expectedRevision + 1 }, threadId);
    await writeRecord(bucket, key(threadId), record, storage);
    return record;
  }, storage);
}

// Pin all routing fields, but exclude the mutable observation cursor/revision.
export function managedMembershipDigest(members) {
  return createHash("sha256").update(JSON.stringify(members.map(m => ({
    thread_id: m.thread_id, project_id: m.project_id, connection: m.connection,
    host_id: m.host_id ?? null, remote_transport: m.remote_transport ?? null,
    environment_config_id: m.environment_config_id ?? null, backend_project_id: m.backend_project_id ?? null, creation_attempt_id: m.creation_attempt_id ?? null,
    policy_sha256: m.policy_sha256 ?? null, registered_at: m.registered_at,
  })))).digest("hex");
}
