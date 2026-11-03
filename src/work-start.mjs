import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { readRecord, writeRecord, withStoreLock } from "./store.mjs";
import { registerSupervisor } from "./supervision.mjs";
import { registerManagedThread, updateManagedThreadCursor } from "./project-index.mjs";

const MAX_POLICY_BYTES = 64 * 1024;
const fail = (message, code = "WORK_START_FAILED") => Object.assign(new Error(message), { code });
const sha = value => createHash("sha256").update(value).digest("hex");
const normalized = value => value.trim().replace(/\s+/gu, " ").normalize("NFC");
const attemptKey = ({ project, title, order, policySha256 }) => sha(JSON.stringify([project, normalized(title), sha(order), policySha256]));

export async function readRepositoryPolicy(root = process.cwd()) {
  const file = path.join(path.resolve(root), "CODEXTEER.md");
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if (error.code === "ENOENT") return { present: false, file, bytes: Buffer.alloc(0), text: "", sha256: sha(Buffer.alloc(0)) };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail("CODEXTEER.md must be a regular file, not a symlink or special file.", "POLICY_FILE_UNSAFE");
  if (stat.size > MAX_POLICY_BYTES) throw fail(`CODEXTEER.md exceeds ${MAX_POLICY_BYTES} bytes.`, "POLICY_FILE_TOO_LARGE");
  const bytes = await readFile(file);
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
  return { attempt_id: record.attempt_id, stage: record.stage, project_id: record.project_id, connection: record.connection,
    thread_id: record.thread_id ?? null, supervisor_registered: !!record.supervisor_registered,
    indexed: !!record.indexed, observed: !!record.sync_cursor, policy: { present: record.policy_present, sha256: record.policy_sha256, source: record.policy_source } };
}

// Hooks are fault-injection boundaries used by tests. Production never supplies them.
export async function startWork(input, dependencies = {}) {
  const { project, title, order, connection = "shared", root = process.cwd(), branch } = input ?? {};
  if (!project?.trim() || !title?.trim()) throw fail("work start requires --project and --title.", "WORK_START_OPTIONS_INVALID");
  if (!["shared", "cloud"].includes(connection)) throw fail("work start supports shared and cloud connections.", "WORK_START_CONNECTION_UNSUPPORTED");
  const storage = dependencies.storage ?? {}, policy = await (dependencies.readPolicy ?? readRepositoryPolicy)(root);
  const prompt = composeWorkOrder(order, policy), key = attemptKey({ project, title, order, policySha256: policy.sha256 });
  const hook = dependencies.hook ?? (async () => {});
  return withStoreLock(`work-start-${key}`, async () => {
    let record = await readRecord("work-starts", key, storage);
    if (!record) {
      record = { schema: 1, attempt_id: randomUUID(), idempotency_key: key, stage: "prepared", project_id: project, title: normalized(title),
        connection, branch: branch ?? null, root: path.resolve(root), order_sha256: sha(order), prompt_sha256: sha(prompt), policy_present: policy.present,
        policy_source: policy.present ? "CODEXTEER.md" : null, policy_sha256: policy.sha256, policy_text: policy.text, prompt, created_at: new Date().toISOString() };
      await writeRecord("work-starts", key, record, storage); await hook("attempt_saved", record);
    } else if (record.prompt_sha256 !== sha(prompt) || record.connection !== connection || record.branch !== (branch ?? null)) {
      throw fail("This work order is already reserved with different start options.", "WORK_START_CONFLICT");
    }
    if (!record.thread_id) {
      if (record.stage === "create_dispatching" || record.stage === "create_unknown") {
        const found = await dependencies.reconcile?.(record);
        if (!found?.thread_id) throw Object.assign(fail("Creation may have been dispatched. Read-only reconciliation did not find one child; creation was not repeated.", "WORK_CREATE_UNKNOWN"), summary(record));
        Object.assign(record, found, { stage: "child_known" }); await writeRecord("work-starts", key, record, storage);
      } else {
        await hook("before_create_rpc", record);
        record.stage = "create_dispatching"; await writeRecord("work-starts", key, record, storage);
        let created;
        try { created = await dependencies.create({ project, title, prompt, branch, attemptId: record.attempt_id, connection }); }
        catch (error) { record.stage = "create_unknown"; record.create_error = error.code ?? "CREATE_FAILED"; await writeRecord("work-starts", key, record, storage); throw Object.assign(error, summary(record)); }
        await hook("create_returned", { ...record, created });
        if (!created?.thread_id) { record.stage = "create_unknown"; await writeRecord("work-starts", key, record, storage); throw Object.assign(fail("Creation returned no child ID; creation was not repeated.", "WORK_CREATE_UNKNOWN"), summary(record)); }
        Object.assign(record, { thread_id: created.thread_id, backend_project_id: created.backend_project_id ?? created.project_id ?? project, creation_receipt: created, stage: "child_known" });
        await writeRecord("work-starts", key, record, storage); await hook("child_saved", record);
      }
    }
    if (!record.supervisor_registered) {
      record.supervisor_session_id ??= randomUUID();
      await registerSupervisor(record.thread_id, record.supervisor_session_id, { ...storage, owner: "codexteer-orchestrator", connection });
      record.supervisor_registered = true; record.stage = "supervisor_registered"; await writeRecord("work-starts", key, record, storage); await hook("supervisor_registered", record);
    }
    if (!record.indexed) {
      await registerManagedThread(record.thread_id, { projectId: project, connection, backendProjectId: record.backend_project_id,
        creationAttemptId: record.attempt_id, policySha256: record.policy_sha256 }, storage);
      record.indexed = true; record.stage = "indexed"; await writeRecord("work-starts", key, record, storage); await hook("index_updated", record);
    }
    if (!record.sync_cursor) {
      let observation, cursor;
      do {
        observation = await dependencies.read(record.thread_id, { connection, ...(cursor ? { since: cursor } : {}) });
        if (!observation?.cursor) throw fail("Initial observation returned no cursor.", "WORK_INITIAL_READ_INCOMPLETE");
        cursor = observation.cursor;
      } while (observation.has_more);
      await hook("initial_read", { ...record, observation });
      record.sync_cursor = cursor; record.initial_state = observation.status ?? "unknown"; record.stage = "observed";
      await updateManagedThreadCursor(record.thread_id, record.sync_cursor, storage);
      await writeRecord("work-starts", key, record, storage);
    }
    return { ...summary(record), prompt_sha256: record.prompt_sha256, initial_status: record.initial_state };
  }, storage);
}
