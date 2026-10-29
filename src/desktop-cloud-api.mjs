import WebSocket from "ws";
import { cloudCredentials } from "./cloud-api.mjs";
import { RpcClient, RpcFailure } from "./rpc.mjs";
import { VERSION } from "./version.mjs";
import { codexHome } from "./runtime.mjs";
import { desktopCloudId, desktopCloudUuid } from "./desktop-cloud-id.mjs";
const origin = "https://codex-cloud-backend.chatgpt.com", limit = 16 * 1024 * 1024;
const failure = (message, code = "DESKTOP_CLOUD_PROTOCOL_ERROR") => Object.assign(new Error(message), { code });
const headers = auth => ({ "ChatGPT-Account-ID": auth.accountId, "X-OpenAI-Product-Sku": "codex" });
export async function desktopCloudGet(route, { signal, timeoutMs = 30000 } = {}, { credentials = cloudCredentials, fetchRequest = fetch } = {}) {
  const url = new URL(route, origin);
  if (!route.startsWith("/v1/environment-configs?") || url.pathname !== "/v1/environment-configs" || url.origin !== origin) throw failure("Invalid Desktop Cloud catalog route.");
  const deadline = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let auth;
  try {
    auth = await credentials({ signal: combined, timeoutMs });
    const response = await fetchRequest(url, { method: "GET", redirect: "error", signal: combined, headers: { ...headers(auth), Authorization: `Bearer ${auth.token}`, Accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); throw failure(`Desktop Cloud catalog failed (HTTP ${response.status}).`, response.status === 401 ? "CLOUD_LOGIN_REQUIRED" : "DESKTOP_CLOUD_HTTP_FAILED"); }
    const chunks = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > limit) throw failure("Desktop Cloud catalog exceeded its receive limit."); chunks.push(part); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("Desktop Cloud returned invalid catalog JSON."); }
  } catch (error) {
    if (/^(DESKTOP_CLOUD_|CLOUD_)/.test(error.code ?? "")) throw error;
    throw failure("Desktop Cloud catalog did not complete.", signal?.aborted ? "CANCELLED" : deadline.aborted ? "TIMEOUT" : "CONNECTION_FAILED");
  } finally { if (auth) auth.token = ""; }
}
export function configId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_~-]{0,399}$/.test(value)) throw failure("Invalid environment configuration ID.");
  return value;
}
export async function desktopCloudEnvironments(options = {}, { get = desktopCloudGet } = {}) {
  const rows = new Map();
  for (const scope of ["user", "workspace"]) {
    let cursor; const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ scope, limit: "100", omitDraft: "true", view: "picker", ...(cursor ? { cursor } : {}) });
      const data = await get(`/v1/environment-configs?${query}`, options);
      if (!Array.isArray(data?.data)) throw failure("Invalid Desktop Cloud environment inventory.");
      for (const row of data.data) {
        const id = configId(row?.id);
        if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 1000) throw failure("Invalid environment name.");
        if (rows.has(id) && rows.get(id).name !== row.name) throw failure("Conflicting environment entries.");
        rows.set(id, { id, name: row.name, scope, repository_ids: Array.isArray(row.repository_ids) ? row.repository_ids.filter(x => typeof x === "string") : [] });
      }
      cursor = data.next_cursor; if (cursor == null) break;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor) || page === 99) throw failure("Invalid environment pagination.");
      seen.add(cursor);
    }
  }
  return { environments: [...rows.values()], source: "desktop-cloud-configurations", execution_environment: "cloud", connection_mode: "desktop-cloud" };
}
export async function connectDesktopCloud(options = {}, { credentials = cloudCredentials, Socket = WebSocket } = {}) {
  const timeoutMs = options.timeoutMs ?? 30000; let auth, socket, client;
  try {
    auth = await credentials({ timeoutMs, signal: options.signal });
    if (options.signal?.aborted) throw failure("Connection cancelled.", "CANCELLED");
    socket = new Socket("wss://codex-cloud-backend.chatgpt.com/", ["codex-app-server", "codex-client.desktop", `openai-bearer.${auth.token}`], {
      headers: headers(auth), followRedirects: false, perMessageDeflate: false, maxPayload: limit, handshakeTimeout: timeoutMs,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(failure("Desktop Cloud connection cancelled.", "CANCELLED"));
      const timer = setTimeout(() => finish(failure("Desktop Cloud connection timed out.", "TIMEOUT")), timeoutMs);
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
      socket.on("error", () => finish(failure("Desktop Cloud connection failed.", "CONNECTION_FAILED")));
      socket.once("close", () => finish(failure("Desktop Cloud connection closed.", "CONNECTION_FAILED")));
      socket.once("open", () => finish()); options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
    });
    client = new RpcClient(socket, { timeoutMs });
    const cancelInitialization = () => client.abort("Desktop Cloud initialization cancelled.", "CANCELLED");
    options.signal?.addEventListener("abort", cancelInitialization, { once: true });
    if (options.signal?.aborted) cancelInitialization();
    try { await client.request("initialize", { clientInfo: { name: "codexteer", version: VERSION }, capabilities: { experimentalApi: true } }); } finally { options.signal?.removeEventListener("abort", cancelInitialization); }
    client.notify("initialized", {});
    return new DesktopCloudClient(client);
  } catch (error) {
    client?.close(); socket?.terminate();
    // ws errors can quote the bearer subprotocol; never expose arbitrary errors.
    if (error instanceof RpcFailure || ["TIMEOUT", "CANCELLED", "CONNECTION_FAILED"].includes(error.code) || /^CLOUD_/.test(error.code ?? "")) throw error;
    throw failure("Could not initialize Desktop Cloud.", "CONNECTION_FAILED");
  } finally { if (auth) auth.token = ""; }
}
export class DesktopCloudClient {
  constructor(client) { this.client = client; }
  close() { this.client.close(); }
  async history(threadId) {
    const turns = [], seen = new Set(); let cursor, bytes = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.client.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data?.data) || data.data.some(turn => typeof turn.id !== "string" || !Array.isArray(turn.items) || turn.itemsView !== "full") || new Set([...turns, ...data.data].map(turn => turn.id)).size !== turns.length + data.data.length) throw failure("Invalid complete Cloud history.");
      bytes += Buffer.byteLength(JSON.stringify(data.data)); if (bytes > 32 * 1024 * 1024) throw failure("Complete Cloud history exceeded its memory budget.");
      turns.push(...data.data); cursor = data.nextCursor;
      if (cursor == null) return turns;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor) || page === 99) throw failure("Cloud history exceeded its pagination limit.");
      seen.add(cursor);
    }
  }
  async request(method, params = {}, options = {}) {
    if (!["thread/read", "thread/turns/list", "thread/items/list", "thread/list", "model/list", "thread/start", "thread/name/set", "turn/start", "turn/steer"].includes(method)) throw failure("Unsupported Desktop Cloud operation.", "CAPABILITY_UNSUPPORTED");
    const input = { ...params }; if (input.threadId) input.threadId = desktopCloudUuid(input.threadId); if (method === "thread/read") delete input.includeTurns;
    try {
      const result = await this.client.request(method, input, options);
      if (result?.thread) {
        if (params.threadId && result.thread.id !== desktopCloudUuid(params.threadId)) throw new RpcFailure("Desktop Cloud returned another task.", { code: "PROTOCOL_ERROR", uncertain: !!options.mutation });
        return { ...result, thread: { ...result.thread, id: desktopCloudId(`durable_${result.thread.id}`), historyMode: "aggregate", turns: method === "thread/read" && params.includeTurns ? await this.history(input.threadId) : [] } };
      }
      return result;
    } catch (error) { if (options.mutation && Number.isSafeInteger(error.rpcCode) && ![-32601, -32602].includes(error.rpcCode)) error.uncertain = true; throw error; }
  }
}
export function desktopCloudConnection() {
  return {
    async discover(home = codexHome()) { return { paths: { home, socket: "desktop-cloud" }, state: { codex_home: home, codex_steer_protocol: 1,
      codex_steer_capabilities: { thread_read: [1], history_pagination: [1], turn_steer: [], turn_start: [], desktop_subscribe: [] } } }; },
    async connect(endpoint, options) { if (endpoint !== "desktop-cloud") throw failure("Invalid Desktop Cloud endpoint."); return connectDesktopCloud(options); },
  };
}
