import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { readSendState } from "./app-server.mjs";
import { remoteControlConnection } from "./remote-control.mjs";
import { targetHost, targetContext, remoteTransport, hostFields } from "./target.mjs";
import { parseThreadTarget, normalizeThreadId, threadDeepLink } from "./thread-id.mjs";
import { registeredRemoteProjects } from "./projects.mjs";
import { discoverNativeEndpoint, nativeToolJson, inspectNativeEndpoint } from "./native-rpc.mjs";
import { nativeOnAppServer, inspectNativeCommandProtocol } from "./native-command.mjs";
import { validateNativeCreationCatalog, creationOptions } from "./thread-create.mjs";
import { fetchThread } from "./observe.mjs";
import { initialInstructionText } from "./creation-verification.mjs";
import { writeRecord, readRecord, storePath, withStoreLock } from "./store.mjs";

const failure = (message, code = "REMOTE_MANAGEMENT_FAILED") => Object.assign(new Error(message), { code, uncertain: false });
const remotePath = value => typeof value === "string" && (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) && !/[\0\r\n]/.test(value);
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && (a === b || (path.win32.isAbsolute(a) && path.win32.isAbsolute(b) && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()));
export function requirePairedManagement() {
  if (targetHost() === "local" || remoteTransport() !== "paired") throw failure("Remote management requires an explicit remote host and --remote-transport paired.", "REMOTE_MANAGEMENT_TRANSPORT_REQUIRED");
}

export async function withRemoteClient(operation, { route = remoteControlConnection, timeoutMs = 35000 } = {}) {
  requirePairedManagement();
  const adapter = route(), runtime = await adapter.discover(), client = await adapter.connect(runtime.paths.socket, { timeoutMs });
  try { return await operation(client, runtime); } finally { client.close(); }
}

export async function remoteProjectsOnClient(client) {
  const projects = [], ids = new Set(), cursors = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await client.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw failure("Invalid remote project list.", "REMOTE_PROTOCOL_ERROR");
    for (const project of result.data) {
      if (typeof project?.id !== "string" || !project.id || ids.has(project.id) || typeof project.name !== "string" || !Array.isArray(project.roots) || !project.roots.length || project.roots.some(root => !remotePath(root?.path))) throw failure("Invalid remote project identity or roots.", "REMOTE_PROTOCOL_ERROR");
      ids.add(project.id); projects.push(project);
    }
    if (result.nextCursor == null) return projects;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 16384 || cursors.has(result.nextCursor)) throw failure("Invalid remote project pagination.", "REMOTE_PROTOCOL_ERROR");
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw failure("Remote project list exceeded its limit.", "REMOTE_PROTOCOL_ERROR");
}

export async function listRemoteProjects(dependencies) {
  return withRemoteClient(async client => {
    const live = await remoteProjectsOnClient(client), saved = await registeredRemoteProjects();
    return live.map(project => ({ project_id: project.id, name: project.name, roots: project.roots.map(root => root.path),
      desktop_project_ids: saved.filter(p => p.host_id === targetHost() && p.roots.length === project.roots.length && p.roots.every(root => project.roots.some(r => samePath(root, r.path)))).map(p => p.project_id),
      project_kind: "remote", ...hostFields(), source: "remote-app-server", availability: "verified", availability_scope: "project-catalog", roots_availability: "unverified" }));
  }, dependencies);
}

export async function listRemoteThreads({ limit = 20, desktopOnly = false, cursor, projectId, search } = {}, dependencies) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 16384))) throw failure("Invalid remote list limit or cursor.", "INVALID_ARGUMENT");
  return withRemoteClient(async client => {
    const threads = [], cursors = new Set(), ids = new Set(); let next = cursor;
    for (let page = 0; page < 100; page++) {
      const result = await client.request("thread/list", { limit: Math.min(100, limit - threads.length), useStateDbOnly: true, sortKey: "updated_at",
        ...(next ? { cursor: next } : {}), ...(projectId ? { projectId } : {}), ...(search ? { searchTerm: search } : {}) });
      if (!Array.isArray(result?.data) || result.data.length > Math.min(100, limit - threads.length)) throw failure("Invalid remote task list.", "REMOTE_PROTOCOL_ERROR");
      for (const thread of result.data) {
        const id = normalizeThreadId(thread?.id);
        if (ids.has(id)) throw failure("Repeated remote task identity.", "REMOTE_PROTOCOL_ERROR");
        ids.add(id);
        if (desktopOnly && thread.originator !== "Codex Desktop") continue;
        threads.push({ thread_id: id, title: thread.name ?? null, cwd: thread.cwd ?? null, project_id: thread.projectId ?? null,
          created_at: typeof thread.createdAt === "number" ? new Date(thread.createdAt * 1000).toISOString() : null,
          updated_at: typeof thread.updatedAt === "number" ? new Date(thread.updatedAt * 1000).toISOString() : null,
          originator: thread.originator ?? null, deep_link: threadDeepLink(id), ...hostFields() });
      }
      next = result.nextCursor;
      if (next != null && (typeof next !== "string" || !next || next.length > 16384 || cursors.has(next))) throw failure("Invalid remote task pagination.", "REMOTE_PROTOCOL_ERROR");
      if (next == null || threads.length >= limit) return { threads, count: threads.length, next_cursor: next ?? null, has_more: next != null };
      cursors.add(next);
    }
    throw failure("Remote task pagination exceeded its limit.", "REMOTE_PROTOCOL_ERROR");
  }, dependencies);
}

// Desktop owns creation and long-lived subscriptions. The caller is an actual
// persisted local chat, never a fabricated turn, model relay or a remote task
// reinterpreted as local. Terminal users may pass --context-thread explicitly.
export async function remoteDesktopSession({ contextThread = targetContext() ?? process.env.CODEX_THREAD_ID, timeoutMs = 120000 } = {}, dependencies = {}) {
  const { discover = discoverRuntime, connect = RpcClient.connect, endpoint = discoverNativeEndpoint, inspect = inspectNativeCommandProtocol, native = nativeOnAppServer } = dependencies;
  if (!contextThread) throw failure("Desktop lifecycle operations require --context-thread <LOCAL-CHAT-ID>, or CODEX_THREAD_ID inside Codex. Paired list/read/steer do not require it.", "REMOTE_CONTEXT_REQUIRED");
  const source = parseThreadTarget(contextThread);
  if (source.hostId && source.hostId !== "local") throw failure("The Desktop caller must be a real local chat.", "REMOTE_CONTEXT_INVALID");
  const runtime = await discover(), client = await connect(runtime.paths.socket, { timeoutMs: timeoutMs + 5000 });
  try {
    const pipe = await endpoint(runtime.state); await inspect(runtime.state);
    const caller = await readSendState(client, source.threadId), turn = caller.turns.at(-1);
    if (caller.id !== source.threadId || caller.ephemeral || !turn?.id || caller.environments?.some(item => item.environmentId !== "local")) throw failure("A persisted local caller with a stored turn is required.", "REMOTE_CONTEXT_INVALID");
    const context = { threadId: caller.id, turnId: turn.id };
    const check = async () => {
      const current = await discover();
      if (current.paths.socket !== runtime.paths.socket || current.state.instance !== runtime.state.instance) throw failure("Desktop runtime changed.", "RUNTIME_CHANGED");
      await inspectNativeEndpoint(pipe.socketPath, pipe.fingerprint);
    };
    const catalog = await native(client, pipe, "catalog", undefined, undefined, { timeoutMs });
    return { context, catalog, close: () => client.close(), async invoke(action, args, options = {}) {
      if (!["create_thread", "list_threads", "read_thread", "navigate_to_codex_page"].includes(action)) throw failure("Unsupported Desktop management operation.");
      await check();
      return nativeToolJson(await native(client, pipe, action, args, context, { timeoutMs, ...options }));
    } };
  } catch (error) { client.close(); throw error; }
}

export async function ensureRemoteDesktopSubscription(threadId, { session: existing, ...options } = {}) {
  requirePairedManagement();
  const session = existing ?? await remoteDesktopSession(options);
  try {
    const schema = session.catalog.tools?.find(t => t.namespace === "codex_app" && t.name === "navigate_to_codex_page")?.inputSchema;
    if (schema?.properties?.threadId?.type !== "string") throw failure("Desktop navigation schema is unavailable.", "REMOTE_SUBSCRIPTION_UNVERIFIED");
    const inventory = await session.invoke("list_threads", {});
    const matches = [...(inventory.threads ?? []), ...(inventory.pinnedThreads ?? [])].filter(thread => thread.id === threadId);
    if (matches.length !== 1 || matches[0].hostId !== targetHost()) throw failure("Desktop navigation cannot uniquely identify this task on the selected host. No task was opened.", "HOST_MISMATCH");
    const snapshot = await session.invoke("read_thread", { threadId, hostId: targetHost(), turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 100 });
    if (snapshot.thread?.id !== threadId || snapshot.thread.hostId !== targetHost()) throw failure("Desktop returned a different task or host.", "HOST_MISMATCH");
    // Explicitly opens the selected remote chat on the controlling Desktop;
    // its own persistent App Server connection then resumes/subscribes to it.
    await session.invoke("navigate_to_codex_page", { threadId });
    return { thread_id: threadId, ...hostFields(), desktop_subscription: "native-navigation", deep_link: threadDeepLink(threadId) };
  } finally { if (!existing) session.close(); }
}

function scopeMatches(thread, receipt) {
  const roots = thread?.environments?.find(item => item.environmentId === "local")?.runtimeWorkspaceRoots;
  const match = typeof thread?.path === "string" && thread.path.match(/^(.*)[\\/]sessions[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/]/);
  const artifactRoot = match ? path.win32.isAbsolute(thread.path) ? path.win32.join(match[1], "visualizations", match[2], match[3], match[4], receipt.thread_id)
    : path.posix.join(match[1], "visualizations", match[2], match[3], match[4], receipt.thread_id) : null;
  return thread?.id === receipt.thread_id && thread.projectId === receipt.project_id && samePath(thread.cwd, receipt.cwd)
    && thread.name === receipt.title && Array.isArray(roots) && new Set(roots).size === roots.length
    && receipt.runtime_workspace_roots.every(root => roots.some(actual => samePath(actual, root)))
    && roots.every(root => receipt.runtime_workspace_roots.some(expected => samePath(root, expected)) || (artifactRoot && samePath(root, artifactRoot)));
}

export async function createRemoteProjectThread(selector, prompt, options = {}, dependencies = {}) {
  requirePairedManagement(); const settings = creationOptions(options), attemptId = randomUUID();
  if (typeof selector !== "string" || !selector.trim() || typeof prompt !== "string" || !prompt.trim()) throw failure("A project and initial instruction are required.", "INVALID_CREATION_OPTIONS");
  let session, receipt, storage, dispatched = false, accepted = false;
  const registry = dependencies.registry ?? registeredRemoteProjects;
  try {
    session = await (dependencies.desktop ?? remoteDesktopSession)({ contextThread: options.contextThread, timeoutMs: settings.timeoutMs });
    validateNativeCreationCatalog(session.catalog);
    return await withRemoteClient(async (client, runtime) => {
      storage = { home: runtime.paths.home };
      const projectList = await remoteProjectsOnClient(client), saved = (await registry()).filter(p => p.host_id === targetHost());
      const candidates = projectList.filter(p => p.id === selector || p.name === selector || saved.some(s => (s.project_id === selector || s.name === selector) && s.roots.length === p.roots.length && s.roots.every(root => p.roots.some(r => samePath(root, r.path)))));
      if (candidates.length !== 1) throw failure("Select exactly one live remote project by ID or name.", candidates.length ? "PROJECT_AMBIGUOUS" : "PROJECT_NOT_FOUND");
      const project = candidates[0], aliases = saved.filter(p => p.roots.length === project.roots.length && p.roots.every(root => project.roots.some(r => samePath(root, r.path))));
      if (aliases.length !== 1) throw failure("Cannot uniquely map the live project to a Desktop remote registration.", "DESKTOP_PROJECT_MAPPING_UNVERIFIED");
      const selected = aliases[0], title = settings.title ?? [...prompt.trim().replace(/\s+/gu, " ")].slice(0, 80).join("");
      receipt = { schema: 4, creation_mode: "remote-native", attempt_id: attemptId, native_call_id: attemptId, ...hostFields(), project_id: project.id, desktop_project_id: selected.project_id,
        project_name: project.name, cwd: project.roots[0].path, runtime_workspace_roots: project.roots.map(root => root.path), title, context_thread_id: session.context.threadId,
        context_turn_id: session.context.turnId, creation_status: "not_created", sent: false, delivery_status: "not_sent", verification_status: "not_started",
        prompt_sha256: createHash("sha256").update(prompt).digest("hex"), message_characters: [...prompt].length, dry_run: !!options.dryRun };
      if (options.dryRun) return receipt;
      receipt.receipt_path = storePath("creations", attemptId, runtime.paths.home);
      const write = value => writeRecord("creations", attemptId, value, { home: runtime.paths.home });
      await write({ ...receipt, creation_status: "dispatching" });
      // Recheck roots/registry before the single native creation dispatch.
      const current = await remoteProjectsOnClient(client), registrations = await registry();
      if (JSON.stringify(current.find(p => p.id === project.id)) !== JSON.stringify(project) || !registrations.some(p => p.host_id === targetHost() && JSON.stringify(p) === JSON.stringify(selected))) throw failure("Remote project changed before creation.", "PROJECT_CHANGED");
      dispatched = true;
      const result = await session.invoke("create_thread", { prompt, title, target: { type: "project", projectId: selected.project_id, environment: { type: "local" } },
        ...(settings.model ? { model: settings.model } : {}), ...(settings.thinking ? { thinking: settings.thinking } : {}) }, { callId: attemptId });
      if (typeof result.threadId === "string") { receipt.thread_id = normalizeThreadId(result.threadId); receipt.actual_host_id = result.hostId;
        receipt.deep_link = typeof result.hostId === "string" ? threadDeepLink(`codex://threads/${receipt.thread_id}?hostId=${encodeURIComponent(result.hostId)}`) : null; }
      if (result.hostId !== targetHost() || !receipt.thread_id) throw Object.assign(failure("Creation did not confirm the selected remote host. Inspect the saved returned task; do not retry.", "HOST_MISMATCH"), { uncertain: true });
      receipt.creation_status = "created"; receipt.sent = accepted = true; receipt.delivery_status = "accepted"; receipt.desktop_subscription = "native-owned";
      await write(receipt);
      const thread = (await client.request("thread/read", { threadId: receipt.thread_id, includeTurns: false })).thread;
      if (thread?.id !== receipt.thread_id || !samePath(thread.cwd, receipt.cwd)) throw failure("Created remote task has unexpected scope.", "CREATION_SCOPE_MISMATCH");
      if (thread.projectId != null && thread.projectId !== project.id) throw failure("Created task was assigned to a different canonical project. Its assignment was not overwritten.", "PROJECT_CHANGED");
      if (thread.projectId == null) await client.request("thread/metadata/update", { threadId: receipt.thread_id, projectId: project.id }, { mutation: true });
      const verified = await verifyRemoteCreationOnClient(client, receipt, session, settings.timeoutMs);
      Object.assign(receipt, verified); await write(receipt); return receipt;
    }, dependencies);
  } catch (error) {
    Object.assign(error, { attempt_id: attemptId, native_call_id: attemptId, thread_id: receipt?.thread_id, receipt_path: receipt?.receipt_path,
      creation_status: receipt?.thread_id ? "created" : dispatched && error.uncertain !== false ? "unknown" : "not_created", sent: accepted ? true : dispatched && error.uncertain !== false ? null : false,
      delivery_status: accepted ? "accepted" : dispatched && error.uncertain !== false ? "unknown" : "not_sent" });
    if (receipt?.receipt_path) try { await writeRecord("creations", attemptId, { ...receipt, creation_status: error.creation_status, sent: error.sent, delivery_status: error.delivery_status, verification_status: "failed", error_code: error.code }, storage); } catch { error.receipt_update_required = true; }
    throw error;
  } finally { session?.close(); }
}

async function verifyRemoteCreationOnClient(client, receipt, session, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  do {
    const thread = (await client.request("thread/read", { threadId: receipt.thread_id, includeTurns: false })).thread, history = await fetchThread(client, receipt.thread_id);
    const snapshot = await session.invoke("list_threads", {}), matches = [...(snapshot.threads ?? []), ...(snapshot.pinnedThreads ?? [])].filter(t => t.id === receipt.thread_id);
    const instruction = initialInstructionText(history, receipt.context_thread_id);
    if (scopeMatches(thread, receipt) && matches.length === 1 && matches[0].hostId === targetHost() && matches[0].projectId === receipt.desktop_project_id
      && typeof instruction === "string" && createHash("sha256").update(instruction).digest("hex") === receipt.prompt_sha256) {
      return { verification_status: "verified", initial_instruction: "verified", desktop_project_membership: "verified", app_server_project_membership: "verified", turn_id: history.turns[0]?.id,
        observed_runtime_workspace_roots: thread.environments.find(item => item.environmentId === "local").runtimeWorkspaceRoots };
    }
    if (Date.now() >= deadline) break; await delay(250);
  } while (true);
  throw failure("Created task exists but scope, Desktop membership or initial instruction is not yet verified. Use thread verify; never recreate it.", "CREATION_VERIFICATION_FAILED");
}

export async function verifyRemoteProjectThread(attemptId, options = {}, dependencies = {}) {
  requirePairedManagement(); normalizeThreadId(attemptId);
  return withStoreLock(`creation-${attemptId}`, async () => {
    const receipt = await readRecord("creations", attemptId);
    if (receipt?.schema !== 4 || receipt.creation_mode !== "remote-native" || receipt.host_id !== targetHost() || receipt.remote_transport !== "paired"
      || receipt.creation_status !== "created" || receipt.delivery_status !== "accepted" || !receipt.thread_id || !/^[a-f0-9]{64}$/.test(receipt.prompt_sha256 ?? "")) throw failure("A matching created remote receipt is required.", "CREATION_RECEIPT_UNVERIFIED");
    const session = await (dependencies.desktop ?? remoteDesktopSession)({ contextThread: receipt.context_thread_id, ...options });
    try { return await withRemoteClient(async client => {
      const result = { ...receipt, ...await verifyRemoteCreationOnClient(client, receipt, session, options.timeoutMs ?? 120000) };
      await writeRecord("creations", attemptId, result); return result;
    }, dependencies); } finally { session.close(); }
  });
}
