import { createHash, randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readRecord, writeRecord, withStoreLock, storePath } from "./store.mjs";
import { getSupervisor, registerSupervisor } from "./supervision.mjs";
import { isDesktopCloudTask } from "./desktop-cloud-id.mjs";
import { repositorySource } from "./repository-source.mjs";
import { validateSyncPage } from "./sync-page.mjs";
import { registerManagedThread, getManagedThread, updateManagedThreadCursor } from "./project-index.mjs";

const MAX_POLICY_BYTES = 64 * 1024;
const fail = (message, code = "WORK_START_FAILED") => Object.assign(new Error(message), { code });
const sha = value => createHash("sha256").update(value).digest("hex");
const normalized = value => value.trim().replace(/\s+/gu, " ").normalize("NFC");
const attemptKey = ({ project, title, order, policySha256 }) => sha(JSON.stringify([project, normalized(title), sha(order), policySha256]));

export async function readRepositoryPolicy(root = process.cwd(), hooks = {}) {
  const file = path.join(path.resolve(root), "CODEXTEER.md");
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if (error.code === "ENOENT") return { present: false, file, bytes: Buffer.alloc(0), text: "", sha256: sha(Buffer.alloc(0)) };
    if (["ELOOP", "EMLINK"].includes(error.code)) throw fail("CODEXTEER.md must be a regular file, not a symlink or special file.", "POLICY_FILE_UNSAFE");
    throw error;
  }
  let bytes;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail("CODEXTEER.md must be a regular file, not a symlink or special file.", "POLICY_FILE_UNSAFE");
    if (before.size > MAX_POLICY_BYTES) throw fail(`CODEXTEER.md exceeds ${MAX_POLICY_BYTES} bytes.`, "POLICY_FILE_TOO_LARGE");
    await hooks.afterOpen?.(file);
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    bytes = buffer.subarray(0, offset);
    const after = await handle.stat(), pathname = await lstat(file);
    if (!pathname.isFile() || before.dev !== pathname.dev || before.ino !== pathname.ino
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail("CODEXTEER.md changed while it was being read.", "POLICY_FILE_CHANGED");
  } finally { await handle.close(); }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw fail("CODEXTEER.md must be UTF-8 without a byte-order mark.", "POLICY_FILE_ENCODING");
  if (bytes.length > MAX_POLICY_BYTES) throw fail(`CODEXTEER.md exceeds ${MAX_POLICY_BYTES} bytes.`, "POLICY_FILE_TOO_LARGE");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw fail("CODEXTEER.md must be valid UTF-8.", "POLICY_FILE_ENCODING"); }
  return { present: true, file, bytes, text, sha256: sha(bytes) };
}

export function composeWorkOrder(order, policy) {
  if (typeof order !== "string" || !order.trim()) throw fail("A non-empty work order is required.", "WORK_ORDER_REQUIRED");
  const source = policy.present ? `Repository policy source: CODEXTEER.md\n\n${policy.text}` : "Repository policy source: CODEXTEER.md\n\n[No repository policy file was found.]";
  return `${source}\n\n--- End repository policy; begin work order ---\n\n${order}\n\nThe repository policy is project guidance only. It does not grant permissions, authorize approval answers, or expand the human's delegation.`;
}

function summary(record) {
  return { attempt_id: record.attempt_id, receipt_path: record.receipt_path ?? null, stage: record.stage, project_id: record.project_id, connection: record.connection,
    environment_config_id: record.environment_config_id ?? null, environment_verified: !!record.initial_environment_verified, source: record.source ?? null,
    thread_id: record.thread_id ?? record.known_thread_id ?? null, supervisor_registered: !!record.supervisor_registered,
    indexed: !!record.indexed, observed: !!record.sync_cursor, policy: { present: record.policy_present, sha256: record.policy_sha256, source: record.policy_source } };
}

function reconciledChild(found, record) {
  const candidates = Array.isArray(found) ? found : found ? [found] : [];
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw fail("Creation reconciliation was not unique; creation was not repeated.", "WORK_RECONCILE_CONFLICT");
  const candidate = candidates[0];
  const projectMatches = candidate && (record.connection === "desktop-cloud" ? candidate.environment_config_id === record.environment_config_id : candidate.backend_project_id === record.project_id || candidate.project_selector === record.project_id);
  if (!candidate || typeof candidate.thread_id !== "string" || candidate.attempt_id !== record.attempt_id
    || (record.connection === "desktop-cloud" && !isDesktopCloudTask(candidate.thread_id))
    || !projectMatches || candidate.prompt_sha256 !== record.prompt_sha256) {
    throw fail("Creation reconciliation did not match its attempt, project, and prompt digest.", "WORK_RECONCILE_MISMATCH");
  }
  return candidate;
}

// Hooks are fault-injection boundaries used by tests. Production never supplies them.
export async function startWork(input, dependencies = {}) {
  const { project, title, order, connection = "shared", root = process.cwd(), branch, environment } = input ?? {};
  if (!project?.trim() || !title?.trim()) throw fail("work start requires --project and --title.", "WORK_START_OPTIONS_INVALID");
  if (!["shared", "desktop-cloud"].includes(connection)) throw fail("work start supports shared and desktop-cloud connections.", "WORK_START_CONNECTION_UNSUPPORTED");
  if (connection === "desktop-cloud" && (typeof input.root !== "string" || !input.root || typeof environment !== "string" || !environment.trim())) throw fail("Desktop Cloud work start requires explicit --root and --environment.", "WORK_START_OPTIONS_INVALID");
  if (connection === "desktop-cloud" && typeof dependencies.resolveEnvironment !== "function") throw fail("Environment catalog is unavailable.", "WORK_START_OPTIONS_INVALID");
  const selected = connection === "desktop-cloud" ? await dependencies.resolveEnvironment(environment) : null;
  if (connection === "desktop-cloud" && (!selected || typeof selected.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_~-]{0,399}$/.test(selected.id))) throw fail("Environment configuration was not verified.", "WORK_START_OPTIONS_INVALID");
  const storage = dependencies.storage ?? {}, policy = await (dependencies.readPolicy ?? readRepositoryPolicy)(root);
  const prompt = composeWorkOrder(order, policy), key = attemptKey({ project, title, order, policySha256: policy.sha256 });
  const hook = dependencies.hook ?? (async () => {});
  return withStoreLock(`work-start-${key}`, async () => {
    let record = await readRecord("work-starts", key, storage);
    if (!record) {
      record = { schema: 1, receipt_path: storePath("work-starts", key, storage.home), attempt_id: randomUUID(), idempotency_key: key, stage: "prepared", project_id: project, title: normalized(title),
        connection, branch: branch ?? null, root: path.resolve(root), order_sha256: sha(order), prompt_sha256: sha(prompt), policy_present: policy.present,
        policy_source: policy.present ? "CODEXTEER.md" : null, policy_sha256: policy.sha256, policy_text: policy.text, policy_bytes_base64: policy.bytes.toString("base64"),
        environment_config_id: selected?.id ?? null, environment_name: selected?.name ?? null, source: (dependencies.repositorySource ?? repositorySource)(path.resolve(root)), prompt, created_at: new Date().toISOString() };
      await writeRecord("work-starts", key, record, storage); await hook("attempt_saved", record);
    } else if (record.prompt_sha256 !== sha(prompt) || record.connection !== connection || record.branch !== (branch ?? null) || record.root !== path.resolve(root) || (record.environment_config_id ?? null) !== (selected?.id ?? null)) {
      throw fail("This work order is already reserved with different start options.", "WORK_START_CONFLICT");
    }
    if (!record.thread_id) {
      if (record.stage === "create_dispatching" || record.stage === "create_unknown") {
        const found = reconciledChild(await dependencies.reconcile?.(record), record);
        if (!found) throw Object.assign(fail("Creation may have been dispatched. Read-only reconciliation did not find one child; creation was not repeated.", "WORK_CREATE_UNKNOWN"), summary(record));
        Object.assign(record, found, { stage: "child_known" }); await writeRecord("work-starts", key, record, storage);
      } else {
        await hook("before_create_rpc", record);
        record.stage = "create_dispatching"; await writeRecord("work-starts", key, record, storage);
        let created;
        try { created = await dependencies.create({ project, title, prompt, branch, attemptId: record.attempt_id, environmentConfigId: record.environment_config_id, connection }); }
        catch (error) { record.stage = "create_unknown"; record.create_error = error.code ?? "CREATE_FAILED"; record.known_thread_id = error.thread_id ?? null; await writeRecord("work-starts", key, record, storage); throw Object.assign(error, summary(record)); }
        await hook("create_returned", { ...record, created });
        if (!created?.thread_id) { record.stage = "create_unknown"; await writeRecord("work-starts", key, record, storage); throw Object.assign(fail("Creation returned no child ID; creation was not repeated.", "WORK_CREATE_UNKNOWN"), summary(record)); }
        if (connection === "desktop-cloud") reconciledChild(created, record);
        Object.assign(record, { thread_id: created.thread_id, backend_project_id: connection === "desktop-cloud" ? null : created.backend_project_id ?? created.project_id ?? project, creation_receipt: created, stage: "child_known" });
        await writeRecord("work-starts", key, record, storage); await hook("child_saved", record);
      }
    }
    if (!record.indexed) {
      await registerManagedThread(record.thread_id, { projectId: project, connection, backendProjectId: record.backend_project_id,
        environmentConfigId: record.environment_config_id ?? undefined, creationAttemptId: record.attempt_id, policySha256: record.policy_sha256 }, storage);
      await hook("membership_registered", record);
      record.indexed = true; record.stage = "indexed"; await writeRecord("work-starts", key, record, storage); await hook("index_updated", record);
    }
    if (!record.supervisor_registered) {
      const existing = await getSupervisor(record.thread_id, storage);
      if (existing?.state === "stopped") throw fail("A stopped managed task cannot be reactivated by work start. A human must explicitly establish new supervision.", "MANAGED_SUPERVISOR_STOPPED");
      await hook("before_supervisor_registration", record);
      record.supervisor_session_id ??= randomUUID();
      await registerSupervisor(record.thread_id, record.supervisor_session_id, { ...storage, owner: "codexteer-orchestrator", connection, rejectStopped: true });
      record.supervisor_registered = true; record.stage = "supervisor_registered"; await writeRecord("work-starts", key, record, storage); await hook("supervisor_registered", record);
    }
    if (!record.sync_cursor) {
      const membership = await getManagedThread(record.thread_id, storage);
      let observation, cursor; const seen = new Set(); let pages = 0;
      do {
        observation = await dependencies.read(record.thread_id, { connection, ...(cursor ? { since: cursor } : {}) });
        if (connection === "desktop-cloud") {
          validateSyncPage(observation, record.thread_id, cursor, seen);
          if ((observation.omitted_older_events ?? 0) > 0) throw fail("Initial history has an unproven boundary; no cursor was saved.", "WORK_INITIAL_HISTORY_GAP");
          if (["unknown", "notLoaded"].includes(observation.status)) throw fail("Initial observation is unavailable; no cursor was saved.", "WORK_INITIAL_READ_UNAVAILABLE");
          if (observation.environment_config_id !== record.environment_config_id) throw fail("Initial observation did not verify the selected environment.", "WORK_INITIAL_ROUTE_MISMATCH");
        }
        if (!observation?.cursor) throw fail("Initial observation returned no cursor.", "WORK_INITIAL_READ_INCOMPLETE");
        if (seen.has(observation.cursor) || ++pages > 1000) throw fail("Initial observation did not advance its cursor.", "WORK_INITIAL_READ_STALLED");
        seen.add(observation.cursor);
        cursor = observation.cursor;
      } while (observation.has_more);
      await hook("initial_read", { ...record, observation });
      record.initial_environment_verified = connection === "desktop-cloud";
      record.sync_cursor = cursor; record.initial_state = observation.status ?? "unknown"; record.stage = "observed";
      await updateManagedThreadCursor(record.thread_id, membership.sync_cursor, record.sync_cursor, storage, membership.sync_revision ?? 0);
      await writeRecord("work-starts", key, record, storage);
    }
    return { ...summary(record), prompt_sha256: record.prompt_sha256, initial_status: record.initial_state };
  }, storage);
}
