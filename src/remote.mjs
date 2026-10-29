import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { readSendState } from "./app-server.mjs";
import { discoverNativeEndpoint, nativeToolJson } from "./native-rpc.mjs";
import { inspectNativeCommandProtocol, nativeOnAppServer } from "./native-command.mjs";
import { parseThreadTarget } from "./thread-id.mjs";
import { targetHost, targetContext, remoteReadOnly } from "./target.mjs";
import { assertRuntimeOperation } from "./compatibility.mjs";

const failure = (message, code = "REMOTE_PROTOCOL_ERROR") => Object.assign(new Error(message), { code });

export function validateRemoteCatalog(catalog) {
  const schema = catalog?.tools?.find(tool => tool.namespace === "codex_app" && tool.name === "read_thread")?.inputSchema;
  if (schema?.properties?.threadId?.type !== "string" || schema.properties.hostId?.type !== "string"
    || schema.properties.cursor?.type !== "string" || schema.properties.turnLimit?.maximum !== 10
    || schema.properties.includeOutputs?.type !== "boolean" || schema.properties.maxOutputCharsPerItem?.maximum !== 20000) {
    throw failure("Desktop does not expose the required remote read schema.", "REMOTE_READ_UNSUPPORTED");
  }
}

function pageThread(page, threadId, hostId) {
  if (page?.thread?.id !== threadId || page.thread.hostId !== hostId || page.thread.kind !== "codex") {
    throw failure("Desktop returned a different task or host. No local fallback is allowed.", "HOST_MISMATCH");
  }
  if (!["active", "idle", "notLoaded", "systemError"].includes(page.thread.status?.type)
    || !Array.isArray(page.turns) || page.turns.length > 10 || page.page?.order !== "newest_first"
    || typeof page.page.hasMore !== "boolean" || (page.page.hasMore && (typeof page.page.nextCursor !== "string" || !page.page.nextCursor || page.page.nextCursor.length > 16384 || !page.turns.length))) {
    throw failure("Desktop returned invalid remote history pagination.");
  }
  return { id: threadId, name: page.thread.title, cwd: page.thread.cwd, status: page.thread.status, turns: [], observationSource: "desktop-native-public-history" };
}

function publicOutput(output) {
  if (output == null) return "";
  if (typeof output.text !== "string" || typeof output.truncated !== "boolean") throw failure("Desktop returned an invalid public output projection.");
  return output.text + (output.truncated ? "\n[truncated by Desktop]" : "");
}

function publicTurn(turn) {
  if (typeof turn?.id !== "string" || !turn.id || typeof turn.status !== "string" || !Array.isArray(turn.items)) throw failure("Desktop returned an incomplete remote turn.");
  return { ...turn, items: turn.items.map(item => {
    if (typeof item?.id !== "string" || !item.id || typeof item.type !== "string"
      || (item.type === "userMessage" && (!Array.isArray(item.content) || item.content.some(part => part.type === "text" && typeof part.text !== "string")))) throw failure("Desktop returned an incomplete public item.");
    return item.type === "commandExecution" ? { ...item, aggregatedOutput: publicOutput(item.output) }
      : item.type === "fileChange" ? { ...item, changes: item.changes.map(change => ({ ...change, diff: publicOutput(change.diff) })) } : item;
  }) };
}

// Adapt Desktop's public, paged native reads to the existing observation code.
// No raw remote socket, credential copying, implicit resume or mutation API.
export function remoteReadClient(invoke, hostId, close = () => {}) {
  let first;
  const read = async (threadId, cursor) => {
    const page = await invoke("read_thread", { threadId, hostId, ...(cursor ? { cursor } : {}), turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 });
    pageThread(page, threadId, hostId);
    return page;
  };
  return {
    close,
    async request(method, params = {}, options = {}) {
      if (method !== "thread/read" || options.mutation) throw remoteReadOnly();
      if (!params.includeTurns) {
        first = await read(params.threadId);
        return { thread: pageThread(first, params.threadId, hostId) };
      }
      let page = first?.thread.id === params.threadId ? first : await read(params.threadId); first = undefined;
      const thread = pageThread(page, params.threadId, hostId), turns = [], ids = new Set(), cursors = new Set();
      for (let count = 0; count < 100; count++) {
        for (const turn of page.turns) {
          if (ids.has(turn.id)) throw failure("Remote history changed or repeated a turn. Read again.", "OBSERVATION_CHANGED");
          ids.add(turn.id); turns.push(publicTurn(turn));
        }
        if (!page.page.hasMore) return { thread: { ...thread, turns: turns.reverse() } };
        if (count === 99) throw failure("Remote history exceeded 100 pages; no partial snapshot was returned.", "REMOTE_HISTORY_LIMIT");
        const cursor = page.page.nextCursor;
        if (cursors.has(cursor)) throw failure("Desktop repeated a remote history cursor.");
        cursors.add(cursor); page = await read(params.threadId, cursor);
      }
      throw failure("Remote history exceeded 100 pages; no partial snapshot was returned.", "REMOTE_HISTORY_LIMIT");
    },
  };
}

export function remoteObservationConnection({ hostId = targetHost(), contextThread = targetContext() ?? process.env.CODEX_THREAD_ID } = {}, {
  discover = discoverRuntime, connect = RpcClient.connect, endpoint = discoverNativeEndpoint,
  inspectCommand = inspectNativeCommandProtocol, native = nativeOnAppServer, caller = readSendState,
} = {}) {
  let selected;
  return {
    async discover(home) {
      if (!contextThread) throw failure("Remote reads require a real local caller. Run inside Codex or pass --context-thread <LOCAL-THREAD-ID>.", "REMOTE_CONTEXT_REQUIRED");
      const source = parseThreadTarget(contextThread);
      if (source.hostId !== undefined && source.hostId !== "local") throw failure("--context-thread must identify a local caller.", "REMOTE_CONTEXT_INVALID");
      const runtime = await discover(home);
      assertRuntimeOperation(runtime.state, "read");
      if (selected && (selected.paths.socket !== runtime.paths.socket || selected.state.instance !== runtime.state.instance)) throw failure("The selected shared runtime changed during remote observation.", "RUNTIME_CHANGED");
      selected = runtime;
      return { paths: runtime.paths, state: { native_observation_only: true, remote_host_id: hostId, cli_version: runtime.state.cli_version } };
    },
    async connect(socket, options) {
      if (!selected || socket !== selected.paths.socket) throw failure("Remote discovery is required before connection.");
      const local = await connect(socket, { ...options, timeoutMs: 35000 });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true; options?.signal?.removeEventListener("abort", close); local.close();
      };
      options?.signal?.addEventListener("abort", close, { once: true });
      if (options?.signal?.aborted) close();
      try {
        const nativeEndpoint = await endpoint(selected.state);
        await inspectCommand(selected.state);
        const source = await caller(local, parseThreadTarget(contextThread).threadId), turn = source.turns.at(-1);
        if (!turn?.id || source.ephemeral || source.environments?.some(environment => environment.environmentId !== "local")) throw failure("Remote reads require a persisted local caller with a stored turn.", "REMOTE_CONTEXT_INVALID");
        const context = { threadId: source.id, turnId: turn.id };
        validateRemoteCatalog(await native(local, nativeEndpoint, "catalog", undefined, undefined, { timeoutMs: 30000 }));
        const invoke = async (action, args) => {
          const current = await discover(selected.paths.home);
          if (current.paths.socket !== selected.paths.socket || current.state.instance !== selected.state.instance) throw failure("Runtime changed during remote observation.", "RUNTIME_CHANGED");
          try { return nativeToolJson(await native(local, nativeEndpoint, action, args, context, { timeoutMs: 30000 })); }
          catch (error) {
            error.uncertain = false;
            if (error.code === "NATIVE_TIMEOUT") error.code = "TIMEOUT";
            else if (["NATIVE_CONNECTION_FAILED", "NATIVE_CONNECTION_CLOSED"].includes(error.code)) error.code = "CONNECTION_FAILED";
            throw error;
          }
        };
        return remoteReadClient(invoke, hostId, close);
      } catch (error) { close(); throw error; }
    },
  };
}
