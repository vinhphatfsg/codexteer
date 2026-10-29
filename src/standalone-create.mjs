import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { discoverRuntime, verifyControlEndpoint } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";
import { normalizeThreadId, threadDeepLink } from "./thread-id.mjs";
import { projectsOnClient, projectAliases, resolveProject, projectWorkspace, validateProject } from "./projects.mjs";
import { fetchThread } from "./observe.mjs";
import { ensureDesktopSubscription } from "./subscription.mjs";
import { discoverNativeEndpoint, inspectNativeEndpoint, nativeToolJson } from "./native-rpc.mjs";
import { nativeOnAppServer, inspectNativeCommandProtocol, mutationOutcomeUnknown } from "./native-command.mjs";
import { desktopMembership, initialInstructionMatches, validateMembershipCatalog } from "./creation-verification.mjs";
import { writeRecord, storePath } from "./store.mjs";

const failure = (message, code = "CREATION_FAILED") => Object.assign(new Error(message), { code });

export function validateStandaloneCreationCatalog(catalog) {
  const membership = validateMembershipCatalog(catalog);
  const schema = catalog?.tools?.find(tool => tool.name === "move_thread_to_project" && tool.namespace === "codex_app")?.inputSchema;
  const list = catalog?.tools?.find(tool => tool.name === "list_projects" && tool.namespace === "codex_app")?.inputSchema;
  const project = schema?.properties?.projectId;
  if (list?.type !== "object" || schema?.properties?.threadId?.type !== "string"
    || !schema.required?.includes("threadId") || !schema.required.includes("projectId")
    || !(project?.type === "string" || project?.anyOf?.some(type => type.type === "string"))) {
    throw failure("Desktop native tools do not expose local project assignment.", "NATIVE_CREATION_UNSUPPORTED");
  }
  return { status: "verified", source: "desktop-native-assignment-schema", schema_sha256: createHash("sha256").update(JSON.stringify([list, schema, membership])).digest("hex") };
}

// No caller chat is required. The initial instruction starts exactly one real
// task/turn; only that new task supplies the native self-assignment context.
export async function createStandaloneProjectThread(selector, prompt, settings, {
  discover = discoverRuntime, connect = RpcClient.connect, aliases = projectAliases,
  endpoint = discoverNativeEndpoint, inspectEndpoint = inspectNativeEndpoint, inspectCommand = inspectNativeCommandProtocol, native,
  workspace = projectWorkspace, history = fetchThread, membership = desktopMembership,
  inspectControl = verifyControlEndpoint, subscribe = ensureDesktopSubscription, write = writeRecord, sleep = delay,
} = {}) {
  const attemptId = randomUUID();
  const title = settings.title ?? [...prompt.trim().replace(/\s+/gu, " ")].slice(0, 80).join("");
  let client, receipt, storage, creating = false, sending = false, accepted = false;
  try {
    const { paths, state } = await discover(); storage = { home: paths.home };
    assertRuntimeOperation(state, "send_new_turn");
    await inspectControl(paths);
    const nativeEndpoint = await endpoint(state), command = await inspectCommand(state, { standalone: true });
    client = compatibleClient(await connect(paths.socket, { timeoutMs: settings.timeoutMs + 5000 }), state);
    const invokeNative = native ?? ((...args) => nativeOnAppServer(client, ...args));
    const nativeOptions = { timeoutMs: settings.timeoutMs };
    const protocol = { ...validateStandaloneCreationCatalog(await invokeNative(nativeEndpoint, "catalog", undefined, undefined, nativeOptions)), command };
    const mapping = await aliases(paths.home), project = resolveProject(await projectsOnClient(client), selector, mapping), scope = await workspace(project);
    const matches = Object.keys(mapping).filter(id => mapping[id] === project.id);
    const desktopId = mapping[selector] === project.id ? selector : matches.length === 1 ? matches[0] : undefined;
    if (!desktopId) throw failure("Cannot uniquely map this local project to Desktop. No chat was created.", "DESKTOP_PROJECT_MAPPING_UNVERIFIED");
    const check = async () => {
      const current = await discover(); assertRuntimeOperation(current.state, "send_new_turn");
      if (current.state.instance !== state.instance || current.paths.socket !== paths.socket || current.paths.control !== paths.control || current.state.cli_version !== state.cli_version) throw failure("Runtime changed. Inspect the receipt before retrying.", "RUNTIME_CHANGED");
      await inspectControl(current.paths); await inspectEndpoint(nativeEndpoint.socketPath, nativeEndpoint.fingerprint);
      const live = validateProject((await client.request("project/read", { projectId: project.id })).project);
      if (!isDeepStrictEqual(live.roots, project.roots) || live.name !== project.name || (await aliases(paths.home))[desktopId] !== project.id) throw failure("Project source folders or Desktop mapping changed.", "PROJECT_CHANGED");
    };
    await check();
    receipt = { schema: 3, attempt_id: attemptId, native_call_id: attemptId, creation_mode: "standalone", project_id: project.id, desktop_project_id: desktopId, project_name: project.name,
      context_thread_id: null, context_turn_id: null, cwd: scope.cwd, runtime_workspace_roots: scope.runtimeWorkspaceRoots,
      title, title_source: settings.title === undefined ? "initial-instruction" : "explicit", backend: "app-server-native-assignment", connection_mode: "shared", protocol,
      creation_status: "not_created", sent: false, delivery_status: "not_sent", verification_status: "not_started",
      message_characters: [...prompt].length, prompt_sha256: createHash("sha256").update(prompt).digest("hex"), dry_run: !!settings.dryRun };
    if (settings.dryRun) return receipt;
    receipt.receipt_path = storePath("creations", attemptId, paths.home);
    await write("creations", attemptId, { ...receipt, creation_status: "dispatching" }, storage);
    await check(); creating = true;
    const started = await client.request("thread/start", { cwd: scope.cwd, projectId: project.id, runtimeWorkspaceRoots: scope.runtimeWorkspaceRoots,
      ephemeral: false, ...(settings.model === undefined ? {} : { model: settings.model }) }, { mutation: true });
    if (!started?.thread?.id) throw Object.assign(failure("No created task ID was confirmed. Do not retry automatically.", "NATIVE_CREATION_UNKNOWN"), { uncertain: true });
    const threadId = normalizeThreadId(started.thread.id);
    Object.assign(receipt, { thread_id: threadId, deep_link: threadDeepLink(threadId), creation_status: "created" });
    await write("creations", attemptId, receipt, storage);
    await check();
    // Naming also materializes the turnless rollout on supported servers;
    // without it both metadata/update and Desktop's resume can fail.
    await client.request("thread/name/set", { threadId, name: title }, { mutation: true });
    // An untouched, turnless thread can have no durable rollout yet. Persist
    // its canonical assignment through the API before Desktop resumes it.
    await client.request("thread/metadata/update", { threadId, projectId: project.id }, { mutation: true });
    // Subscribe on Desktop's long-lived connection before starting any work.
    await subscribe(paths.control, threadId); receipt.desktop_subscription = "verified";
    await check();
    const prepared = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
    const preparedRoots = prepared?.environments?.find(environment => environment.environmentId === "local")?.runtimeWorkspaceRoots;
    if (prepared?.id !== threadId || prepared.projectId !== project.id || prepared.cwd !== scope.cwd
      || !Array.isArray(preparedRoots) || preparedRoots.length !== scope.runtimeWorkspaceRoots.length || !scope.runtimeWorkspaceRoots.every(root => preparedRoots.includes(root))
      || prepared.canAcceptDirectInput === false || (await history(client, threadId)).turns?.length !== 0) {
      throw failure("New task's scope or empty initial history changed before delivery. No instruction was sent.", "CREATION_SCOPE_MISMATCH");
    }
    receipt.client_message_id = randomUUID();
    await write("creations", attemptId, { ...receipt, delivery_status: "dispatching" }, storage);
    sending = true;
    const delivery = await client.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], clientUserMessageId: receipt.client_message_id,
      ...(settings.thinking === undefined ? {} : { effort: settings.thinking }) }, { mutation: true });
    if (typeof delivery?.turn?.id !== "string" || !delivery.turn.id.trim()) throw Object.assign(failure("No initial turn ID was confirmed. Inspect the task before resending.", "INITIAL_TURN_UNCONFIRMED"), { uncertain: true });
    accepted = true;
    Object.assign(receipt, { turn_id: delivery.turn.id, sent: true, delivery_status: "accepted", native_context_thread_id: threadId, native_context_turn_id: delivery.turn.id });
    await write("creations", attemptId, receipt, storage);
    const context = { threadId, turnId: delivery.turn.id };
    const inventory = nativeToolJson(await invokeNative(nativeEndpoint, "list_projects", {}, context, nativeOptions));
    const selected = inventory.projects?.filter(item => item.projectKind === "local" && item.hostId === "local" && item.projectId === desktopId);
    if (selected?.length !== 1 || selected[0].label !== project.name || selected[0].path !== project.roots[0].path) throw failure("Desktop project mapping was not confirmed. Inspect the created task.", "DESKTOP_PROJECT_MAPPING_UNVERIFIED");
    await check();
    const assigned = await invokeNative(nativeEndpoint, "move_thread_to_project", { threadId, projectId: desktopId }, context, { ...nativeOptions, callId: attemptId });
    nativeToolJson(assigned);
    if (assigned.native_request_cleanup_required) receipt.native_request_cleanup_required = true;
    const verify = async () => {
      const thread = (await client.request("thread/read", { threadId, includeTurns: false })).thread;
      const roots = thread?.environments?.find(environment => environment.environmentId === "local")?.runtimeWorkspaceRoots;
      return thread?.id === threadId && thread.projectId === project.id && thread.cwd === scope.cwd
        && Array.isArray(roots) && roots.length === scope.runtimeWorkspaceRoots.length && scope.runtimeWorkspaceRoots.every(root => roots.includes(root))
        && thread.name === title
        && await membership(invokeNative, nativeEndpoint, threadId, desktopId, context, nativeOptions) && initialInstructionMatches(await history(client, threadId), prompt);
    };
    let verified = await verify();
    for (let retry = 0; retry < 20 && !verified; retry++) { await sleep(250); verified = await verify(); }
    if (!verified) throw failure("Created task's assignment, roots, title or initial instruction could not be verified. Do not recreate it.", "CREATION_VERIFICATION_FAILED");
    Object.assign(receipt, { verification_status: "verified", desktop_project_membership: "verified", app_server_project_membership: "verified", initial_instruction: "verified" });
    try { await write("creations", attemptId, receipt, storage); } catch { receipt.receipt_update_required = true; }
    return receipt;
  } catch (error) {
    const created = !!receipt?.thread_id, unknownCreation = creating && !created && mutationOutcomeUnknown(error);
    const unknownDelivery = sending && !accepted && mutationOutcomeUnknown(error);
    Object.assign(error, { attempt_id: attemptId, native_call_id: attemptId, thread_id: receipt?.thread_id, receipt_path: receipt?.receipt_path,
      creation_status: created ? "created" : unknownCreation ? "unknown" : "not_created", sent: accepted ? true : unknownDelivery ? null : false,
      delivery_status: accepted ? "accepted" : unknownDelivery ? "unknown" : "not_sent" });
    if (receipt?.receipt_path) try { await write("creations", attemptId, { ...receipt, creation_status: error.creation_status, sent: error.sent, delivery_status: error.delivery_status, verification_status: "failed", error_code: error.code ?? "CREATION_FAILED" }, storage); } catch { error.receipt_update_required = true; }
    throw error;
  } finally { try { client?.close(); } catch { if (accepted && receipt) receipt.runtime_cleanup_required = true; } }
}
