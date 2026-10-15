import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { normalizeThreadId, threadDeepLink } from "./thread-id.mjs";
import { projectsOnClient, projectAliases, resolveProject, projectWorkspace, validateProject } from "./projects.mjs";
import { readSendState } from "./app-server.mjs";
import { fetchThread } from "./observe.mjs";
import { discoverNativeEndpoint, inspectNativeEndpoint, nativeToolJson } from "./native-rpc.mjs";
import { nativeOnAppServer, inspectNativeCommandProtocol } from "./native-command.mjs";
import { desktopMembership, initialInstructionMatches } from "./creation-verification.mjs";
import { writeRecord, storePath } from "./store.mjs";
import { createStandaloneProjectThread } from "./standalone-create.mjs";

const failure = (message, code = "CREATION_FAILED") => Object.assign(new Error(message), { code });

export function creationOptions(options = {}) {
  if (["cwd", "permissions", "sandbox", "approvalPolicy", "approvalsReviewer", "viaThread"].some(key => options[key] !== undefined)) throw failure("Native creation uses Desktop's project and permission settings. cwd/permission overrides and --via-thread are unsupported.", "INVALID_CREATION_OPTIONS");
  for (const key of ["title", "model"]) if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key].trim())) throw failure(`${key} must not be empty.`, "INVALID_CREATION_OPTIONS");
  if (options.thinking !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(options.thinking)) throw failure("Invalid --thinking.", "INVALID_CREATION_OPTIONS");
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw failure("--timeout-ms must be 1000..600000.", "INVALID_CREATION_OPTIONS");
  return { timeoutMs, ...Object.fromEntries(["title", "model", "thinking"].filter(key => options[key] !== undefined).map(key => [key, options[key]])) };
}

export function validateNativeCreationCatalog(catalog) {
  const schemas = ["list_projects", "create_thread"].map(name => catalog?.tools?.find(tool => tool.name === name && tool.namespace === "codex_app")?.inputSchema);
  const creation = schemas[1], project = creation?.properties?.target?.anyOf?.find(target => target.properties?.type?.enum?.includes("project"));
  const local = project?.properties?.environment?.anyOf?.find(environment => environment.properties?.type?.enum?.includes("local"));
  if (schemas[0]?.type !== "object" || creation?.properties?.prompt?.type !== "string" || !creation.required?.includes("prompt") || !creation.required.includes("target") || project?.properties?.projectId?.type !== "string" || !project.required?.includes("projectId") || !local) throw failure("Desktop native tools do not expose the required local creation schema.", "NATIVE_CREATION_UNSUPPORTED");
  return { status: "verified", source: "desktop-native-schema", schema_sha256: createHash("sha256").update(JSON.stringify(schemas)).digest("hex") };
}

export async function createProjectThread(selector, prompt, options = {}, dependencies = {}) {
  const settings = creationOptions(options);
  if (typeof selector !== "string" || !selector.trim()) throw failure("--project is required.", "PROJECT_REQUIRED");
  if (typeof prompt !== "string" || !prompt.trim()) throw failure("An initial instruction is required.", "INITIAL_INSTRUCTION_REQUIRED");
  // An environment variable must not silently turn standalone user work into
  // delegated work or inherit another task's permissions.
  if (options.contextThread === undefined) return createStandaloneProjectThread(selector, prompt, { ...settings, dryRun: !!options.dryRun }, dependencies);
  const {
  discover = discoverRuntime, connect = RpcClient.connect, aliases = projectAliases,
  endpoint = discoverNativeEndpoint, inspectEndpoint = inspectNativeEndpoint, inspectCommand = inspectNativeCommandProtocol, native,
  workspace = projectWorkspace, caller = readSendState, history = fetchThread,
  membership = desktopMembership, write = writeRecord, sleep = delay,
  } = dependencies;
  const sourceId = options.contextThread;
  const contextId = normalizeThreadId(sourceId), attemptId = randomUUID();
  let client, receipt, storage, dispatched = false, accepted = false;
  try {
    const { paths, state } = await discover(); storage = { home: paths.home };
    assertRuntimeOperation(state, "read");
    const nativeEndpoint = await endpoint(state);
    const commandProtocol = await inspectCommand(state);
    client = compatibleClient(await connect(paths.socket, { timeoutMs: settings.timeoutMs + 5000 }), state);
    const invokeNative = native ?? ((...args) => nativeOnAppServer(client, ...args));
    const source = await caller(client, contextId), turn = source.turns.at(-1);
    if (!turn?.id || source.ephemeral || source.environments?.some(environment => environment.environmentId !== "local")) throw failure("A local, persisted caller chat with a stored turn is required.", "CREATION_CONTEXT_INVALID");
    const context = { threadId: contextId, turnId: turn.id }, nativeOptions = { timeoutMs: settings.timeoutMs };
    const protocol = { ...validateNativeCreationCatalog(await invokeNative(nativeEndpoint, "catalog", undefined, undefined, nativeOptions)), command: commandProtocol };
    const mapping = await aliases(paths.home), project = resolveProject(await projectsOnClient(client), selector, mapping), scope = await workspace(project);
    const listNative = async () => {
      const inventory = nativeToolJson(await invokeNative(nativeEndpoint, "list_projects", {}, context, nativeOptions));
      if (!Array.isArray(inventory.projects)) throw failure("Desktop returned an invalid project catalog.", "NATIVE_PROTOCOL_ERROR");
      const matches = inventory.projects.filter(item => item.projectKind === "local" && item.hostId === "local" && (mapping[item.projectId] === project.id || item.projectId === project.id));
      if (matches.length !== 1 || matches[0].label !== project.name || matches[0].path !== project.roots[0].path) throw failure("Selected App Server project does not match exactly one native Desktop project.", "DESKTOP_PROJECT_MAPPING_UNVERIFIED");
      return matches[0];
    };
    const selected = await listNative();
    const check = async () => {
      const current = await discover();
      if (current.state.instance !== state.instance || current.paths.socket !== paths.socket || current.state.cli_version !== state.cli_version) throw failure("Runtime changed. Inspect the receipt before retrying.", "RUNTIME_CHANGED");
      await inspectEndpoint(nativeEndpoint.socketPath, nativeEndpoint.fingerprint);
      const live = validateProject((await client.request("project/read", { projectId: project.id })).project);
      if (!isDeepStrictEqual(live.roots, project.roots) || live.name !== project.name) throw failure("Project source folders changed before creation.", "PROJECT_CHANGED");
      if ((await listNative()).projectId !== selected.projectId) throw failure("Native project changed before creation.", "PROJECT_CHANGED");
    };
    await check();
    receipt = { schema: 2, creation_mode: "delegated", attempt_id: attemptId, native_call_id: attemptId, project_id: project.id, desktop_project_id: selected.projectId, project_name: project.name,
      context_thread_id: contextId, context_turn_id: turn.id, cwd: scope.cwd, runtime_workspace_roots: scope.runtimeWorkspaceRoots,
      title: settings.title ?? null, backend: "desktop-native-rpc", connection_mode: "shared", protocol, creation_status: "not_created", sent: false, delivery_status: "not_sent",
      verification_status: "not_started", message_characters: [...prompt].length, prompt_sha256: createHash("sha256").update(prompt).digest("hex"), dry_run: !!options.dryRun };
    if (options.dryRun) return receipt;
    receipt.receipt_path = storePath("creations", attemptId, paths.home);
    await write("creations", attemptId, { ...receipt, creation_status: "dispatching" }, storage);
    await check();
    dispatched = true;
    const args = { prompt, target: { type: "project", projectId: selected.projectId, environment: { type: "local" } }, ...Object.fromEntries(["title", "model", "thinking"].filter(key => settings[key] !== undefined).map(key => [key, settings[key]])) };
    const raw = await invokeNative(nativeEndpoint, "create_thread", args, context, { ...nativeOptions, callId: attemptId });
    if (raw.native_request_cleanup_required) receipt.native_request_cleanup_required = true;
    const result = nativeToolJson(raw);
    const id = result.threadId ?? (result.status === "created" ? result.conversationId : undefined);
    if (!id) throw Object.assign(failure("Native creation returned no child ID. Do not retry automatically.", "NATIVE_CREATION_UNKNOWN"), { uncertain: true });
    const threadId = normalizeThreadId(id);
    accepted = !!result.threadId || result.firstTurn?.status === "accepted";
    Object.assign(receipt, { thread_id: threadId, deep_link: threadDeepLink(threadId), creation_status: "created", sent: accepted ? true : null, delivery_status: accepted ? "accepted" : "unknown" });
    await write("creations", attemptId, receipt, storage);
    if (!accepted) throw failure("Child exists but its initial turn was not confirmed. Inspect the child before resending.", "INITIAL_TURN_UNCONFIRMED");
    const thread = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
    if (thread?.id !== threadId || thread.cwd !== scope.cwd || !await membership(paths.home, threadId, selected.projectId)) throw failure("Created child did not confirm the selected Desktop project.", "DESKTOP_MEMBERSHIP_MISMATCH");
    const roots = thread.environments?.find(environment => environment.environmentId === "local")?.runtimeWorkspaceRoots;
    if (!Array.isArray(roots) || roots.length !== scope.runtimeWorkspaceRoots.length || !scope.runtimeWorkspaceRoots.every(root => roots.includes(root))) throw failure("Created child did not confirm all project source folders.", "CREATION_SCOPE_MISMATCH");
    let saved = await history(client, threadId), named = thread;
    // Native acceptance can precede the first input's persisted history item.
    // Wait only for read-side materialization; never repeat create or turn/start.
    const ready = () => saved.turns?.[0]?.items?.some(item => item.type === "userMessage" || (item.type === "functionCallOutput" && item.namespace === "codex_app" && item.name === "create_thread"));
    for (let retry = 0; retry < 20 && (!ready() || (settings.title !== undefined && named.name == null)); retry++) {
      await sleep(250);
      saved = await history(client, threadId);
      named = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
    }
    if (!initialInstructionMatches(saved, prompt, contextId) || (settings.title !== undefined && named.name !== settings.title)) throw failure("Created child did not preserve the initial instruction/title.", "CREATION_INSTRUCTION_MISMATCH");
    if (thread.projectId !== project.id) await client.request("thread/metadata/update", { threadId, projectId: project.id }, { mutation: true });
    if ((await client.request("thread/read", { threadId, includeTurns: false })).thread?.projectId !== project.id) throw failure("Canonical project assignment was not confirmed.", "CREATION_SCOPE_MISMATCH");
    Object.assign(receipt, { verification_status: "verified", desktop_project_membership: "verified", app_server_project_membership: "verified", initial_instruction: "verified", desktop_subscription: "native-owned" });
    try { await write("creations", attemptId, receipt, storage); } catch { receipt.receipt_update_required = true; }
    return receipt;
  } catch (error) {
    const created = !!receipt?.thread_id, unknown = !accepted && (created || (dispatched && error.uncertain !== false));
    Object.assign(error, { attempt_id: attemptId, native_call_id: attemptId, thread_id: receipt?.thread_id, receipt_path: receipt?.receipt_path,
      creation_status: created ? "created" : unknown ? "unknown" : "not_created", sent: accepted ? true : unknown ? null : false, delivery_status: accepted ? "accepted" : unknown ? "unknown" : "not_sent" });
    if (receipt?.receipt_path) try { await write("creations", attemptId, { ...receipt, creation_status: error.creation_status, sent: error.sent, delivery_status: error.delivery_status, verification_status: "failed", error_code: error.code ?? "CREATION_FAILED" }, storage); } catch { error.receipt_update_required = true; }
    throw error;
  } finally { try { client?.close(); } catch { if (accepted && receipt) receipt.runtime_cleanup_required = true; } }
}
