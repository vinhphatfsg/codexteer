import { createHash } from "node:crypto";
import path from "node:path";
import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { projectAliases, projectWorkspace, validateProject } from "./projects.mjs";
import { fetchThread } from "./observe.mjs";
import { discoverNativeEndpoint, inspectNativeEndpoint } from "./native-rpc.mjs";
import { nativeOnAppServer, inspectNativeCommandProtocol } from "./native-command.mjs";
import { desktopMembership, initialInstructionText, validateMembershipCatalog } from "./creation-verification.mjs";
import { readRecord, writeRecord, storePath, withStoreLock } from "./store.mjs";

const failure = (message, code = "CREATION_VERIFICATION_FAILED") => Object.assign(new Error(message), { code });
const sameRoots = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && expected.every(root => actual.includes(root));
const text = value => typeof value === "string" && !!value.trim();

function validateReceipt(receipt, attemptId) {
  if (!receipt || receipt.attempt_id !== attemptId || receipt.dry_run
    || !((receipt.schema === 3 && receipt.creation_mode === "standalone") || (receipt.schema === 2 && receipt.creation_mode === "delegated"))
    || receipt.creation_status !== "created" || receipt.sent !== true || receipt.delivery_status !== "accepted"
    || !text(receipt.thread_id) || normalizeThreadId(receipt.thread_id) !== receipt.thread_id
    || !text(receipt.project_id) || !text(receipt.desktop_project_id) || !text(receipt.cwd) || !path.isAbsolute(receipt.cwd)
    || !Array.isArray(receipt.runtime_workspace_roots) || !receipt.runtime_workspace_roots.length
    || receipt.runtime_workspace_roots.some(root => !text(root) || !path.isAbsolute(root))
    || new Set(receipt.runtime_workspace_roots).size !== receipt.runtime_workspace_roots.length
    || !/^[a-f0-9]{64}$/.test(receipt.prompt_sha256 ?? "") || !Number.isSafeInteger(receipt.message_characters) || receipt.message_characters < 1
    || (receipt.creation_mode === "standalone" ? !text(receipt.turn_id) || !text(receipt.title) : !text(receipt.context_thread_id))) {
    throw failure("A valid created/accepted receipt is required. Inspect the existing task; this command never creates or resends.", "CREATION_RECEIPT_UNVERIFIED");
  }
}

// Recovery of a known created/accepted attempt. Only the codexteer receipt is
// written. No create, subscribe, move, metadata update, start or steer API is
// available in this operation; native access is restricted to two read tools.
export async function verifyProjectThread(attempt, { timeoutMs = 120000 } = {}, {
  discover = discoverRuntime, connect = RpcClient.connect, aliases = projectAliases,
  endpoint = discoverNativeEndpoint, inspectEndpoint = inspectNativeEndpoint, inspectCommand = inspectNativeCommandProtocol, native,
  workspace = projectWorkspace, history = fetchThread, membership = desktopMembership,
  read = readRecord, write = writeRecord, lock = withStoreLock,
} = {}) {
  const attemptId = normalizeThreadId(attempt);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw failure("--timeout-ms must be 1000..600000.", "INVALID_CREATION_OPTIONS");
  const { paths, state } = await discover(), storage = { home: paths.home };
  assertRuntimeOperation(state, "read");
  return lock(`creation-${attemptId}`, async () => {
    const receipt = await read("creations", attemptId, storage);
    validateReceipt(receipt, attemptId);
    let client;
    try {
      const nativeEndpoint = await endpoint(state);
      await inspectCommand(state);
      client = compatibleClient(await connect(paths.socket, { timeoutMs: timeoutMs + 5000 }), state);
      const invoke = native ?? ((...args) => nativeOnAppServer(client, ...args));
      const readNative = (...args) => {
        if (!["catalog", "list_threads"].includes(args[1])) throw failure("Verification permits only native reads.");
        return invoke(...args);
      };
      validateMembershipCatalog(await readNative(nativeEndpoint, "catalog", undefined, undefined, { timeoutMs }));
      const project = validateProject((await client.request("project/read", { projectId: receipt.project_id })).project);
      const scope = await workspace(project, receipt.cwd);
      const thread = (await client.request("thread/read", { threadId: receipt.thread_id, includeTurns: false })).thread;
      const saved = await history(client, receipt.thread_id), first = saved.turns?.[0];
      const instruction = initialInstructionText(saved, receipt.creation_mode === "delegated" ? receipt.context_thread_id : undefined);
      const roots = thread?.environments?.find(environment => environment.environmentId === "local")?.runtimeWorkspaceRoots;
      const checks = {
        thread_id: thread?.id === receipt.thread_id,
        project_mapping: (await aliases(paths.home))[receipt.desktop_project_id] === receipt.project_id,
        project_roots: project.id === receipt.project_id && sameRoots(scope.runtimeWorkspaceRoots, receipt.runtime_workspace_roots),
        canonical_project_id: thread?.projectId === receipt.project_id,
        cwd: thread?.cwd === receipt.cwd && scope.cwd === receipt.cwd,
        roots: sameRoots(roots, receipt.runtime_workspace_roots),
        title: receipt.title == null || thread?.name === receipt.title,
        initial_turn: text(first?.id) && (receipt.creation_mode !== "standalone" || first.id === receipt.turn_id),
        initial_instruction: typeof instruction === "string" && [...instruction].length === receipt.message_characters
          && createHash("sha256").update(instruction).digest("hex") === receipt.prompt_sha256,
        desktop_membership: text(first?.id) && await membership(readNative, nativeEndpoint, receipt.thread_id, receipt.desktop_project_id,
          { threadId: receipt.thread_id, turnId: first.id }, { timeoutMs }),
      };
      const current = await discover(); assertRuntimeOperation(current.state, "read");
      if (current.state.instance !== state.instance || current.paths.socket !== paths.socket || current.paths.home !== paths.home || current.state.cli_version !== state.cli_version) {
        throw failure("Runtime changed during verification. No task was changed.", "RUNTIME_CHANGED");
      }
      await inspectEndpoint(nativeEndpoint.socketPath, nativeEndpoint.fingerprint);
      const verified = Object.values(checks).every(value => value === true), status = verified ? "verified" : "failed";
      const updated = { ...receipt, receipt_path: storePath("creations", attemptId, paths.home), verification_status: status,
        verification_history: [...(receipt.verification_history ?? []), { checked_at: new Date().toISOString(), status, checks,
          source: "desktop-native-list_threads", desktop_reads_only: true,
          previous_status: receipt.verification_status, ...(receipt.error_code ? { previous_error_code: receipt.error_code } : {}) }] };
      if (verified) {
        Object.assign(updated, { desktop_project_membership: "verified", app_server_project_membership: "verified", initial_instruction: "verified" });
        delete updated.error_code;
      } else {
        updated.error_code = "CREATION_VERIFICATION_FAILED";
        // Never leave earlier certification flags on a failed fresh check.
        delete updated.desktop_project_membership; delete updated.app_server_project_membership; delete updated.initial_instruction;
      }
      try { await write("creations", attemptId, updated, storage); }
      catch { throw Object.assign(failure("Verification finished but its receipt could not be saved. Do not recreate or resend.", "CREATION_RECEIPT_UPDATE_FAILED"), { receipt_update_required: true, verification_checks: checks }); }
      if (!verified) throw Object.assign(failure("Existing task did not pass all creation checks. No task was changed; do not recreate or resend."), { verification_checks: checks });
      return updated;
    } catch (error) {
      Object.assign(error, { attempt_id: attemptId, thread_id: receipt.thread_id, creation_status: receipt.creation_status,
        sent: receipt.sent, delivery_status: receipt.delivery_status, receipt_path: storePath("creations", attemptId, paths.home) });
      throw error;
    } finally { client?.close(); }
  }, storage);
}
