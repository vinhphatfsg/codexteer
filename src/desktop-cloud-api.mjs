import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { cloudCredentials } from "./cloud-api.mjs";
import { RpcClient, RpcFailure } from "./rpc.mjs";
import { VERSION } from "./version.mjs";
import { codexHome } from "./runtime.mjs";
import { desktopCloudId, desktopCloudUuid } from "./desktop-cloud-id.mjs";
import { listRecords } from "./store.mjs";
const origin = "https://codex-cloud-backend.chatgpt.com", limit = 16 * 1024 * 1024;
const failure = (message, code = "DESKTOP_CLOUD_PROTOCOL_ERROR") => Object.assign(new Error(message), { code });
const headers = auth => ({ "ChatGPT-Account-ID": auth.accountId, "X-OpenAI-Product-Sku": "codex" });
export async function desktopCloudGet(route, { signal, timeoutMs = 30000 } = {}, { credentials = cloudCredentials, fetchRequest = fetch } = {}) {
  const url = new URL(route, origin);
  if (!route.startsWith("/v1/environment-configs?") || url.pathname !== "/v1/environment-configs" || url.origin !== origin) throw failure("Invalid Desktop Cloud catalog route.");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  const combined = controller.signal;
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
    throw failure("Desktop Cloud catalog did not complete.", signal?.aborted ? "CANCELLED" : controller.signal.aborted ? "TIMEOUT" : "CONNECTION_FAILED");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); if (auth) auth.token = ""; }
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
// Whether reads resume a running task to see its turn so far. On unless the
// environment turns it off, and only for the turns codexteer started under the
// auto reviewer (see liveTurn). "on" means the same.
export const LIVE_TURN_SWITCH = "CODEXTEER_DESKTOP_CLOUD_LIVE_TURN";
export const liveTurnEnabled = (env = process.env) => env[LIVE_TURN_SWITCH] !== "off";
const LIVE_TIMEOUT_MS = 10000, LIVE_DRAIN_MS = 500;
export const AUTO_REVIEW = "auto_review";

// The turns codexteer started on a task, each with the approvals reviewer the
// task reported right before the start (null when unknown): the accepted
// new-turn send receipts. A steer's receipt names a turn someone else may
// have started, so it does not count.
export async function startedTurns(threadId, storage = {}) {
  const id = desktopCloudId(threadId);
  return new Map((await listRecords("desktop-cloud-sends", storage)).filter(row => row?.thread_id === id && row.delivery_action === "new-turn" && typeof row.turn_id === "string")
    .map(row => [row.turn_id, typeof row.approvals_reviewer === "string" ? row.approvals_reviewer : null]));
}

export async function connectDesktopCloud(options = {}, { credentials = cloudCredentials, Socket = WebSocket, env = process.env, home } = {}) {
  const client = await openDesktopCloud(options, { credentials, Socket });
  return new DesktopCloudClient(client, liveTurnEnabled(env) ? { openLive: () => openDesktopCloud({ timeoutMs: LIVE_TIMEOUT_MS }, { credentials, Socket }),
    turns: threadId => startedTurns(threadId, home ? { home } : {}) } : {});
}

async function openDesktopCloud(options, { credentials, Socket }) {
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
    client = new RpcClient(socket, { timeoutMs, receiveLimitBytes: limit });
    // A reader held open for the service lets the process end as it would.
    client.unref = () => socket._socket?.unref?.();
    const cancelInitialization = () => client.abort("Desktop Cloud initialization cancelled.", "CANCELLED");
    options.signal?.addEventListener("abort", cancelInitialization, { once: true });
    if (options.signal?.aborted) cancelInitialization();
    try { await client.request("initialize", { clientInfo: { name: "codexteer", version: VERSION }, capabilities: { experimentalApi: true } }); } finally { options.signal?.removeEventListener("abort", cancelInitialization); }
    client.notify("initialized", {});
    return client;
  } catch (error) {
    client?.close(); socket?.terminate();
    // ws errors can quote the bearer subprotocol; never expose arbitrary errors.
    if (error instanceof RpcFailure || ["TIMEOUT", "CANCELLED", "CONNECTION_FAILED"].includes(error.code) || /^CLOUD_/.test(error.code ?? "")) throw error;
    throw failure("Could not initialize Desktop Cloud.", "CONNECTION_FAILED");
  } finally { if (auth) auth.token = ""; }
}
// The task as a resuming client sees it, which includes the items of a running
// turn that the history has not listed yet: the history lists a running turn's
// items late, and lists them all only when the turn ends. A separate connection
// resumes the task, records every server request it is sent, never answers
// one and closes. Returns the thread status, its newest turn, the requests'
// methods and the approvals reviewer the task reported.
// The service interrupts the turn when a connection closes on a request it
// has not resolved, so such a connection stays open until the service reports
// each request resolved. It does not keep the process running: a process that
// ends first closes it, and the service then interrupts the turn.
async function resumeView(threadId, { openLive, timeoutMs = LIVE_TIMEOUT_MS, drainMs = LIVE_DRAIN_MS }) {
  const uuid = desktopCloudUuid(threadId), requests = new Set(), unresolved = new Set();
  let connection, abandoned = false, held = false, timer;
  const read = (async () => {
    const opened = await openLive();
    if (abandoned) { opened.close(); throw failure("Live turn read timed out.", "TIMEOUT"); }
    connection = opened;
    connection.on("serverRequest", message => { requests.add(message.method); unresolved.add(message.id); });
    connection.on("notification", message => {
      if (message.method !== "serverRequest/resolved") return;
      unresolved.delete(message.params?.requestId);
      if (held && !unresolved.size) connection.close();
    });
    const result = await connection.request("thread/resume", { threadId: uuid });
    await delay(drainMs);
    if (result?.thread?.id !== uuid || !Array.isArray(result.thread.turns)) throw failure("Invalid live turn.");
    return { status: result.thread.status ?? null, turn: result.thread.turns.at(-1) ?? null, requests: [...requests].sort(),
      reviewer: typeof result.approvalsReviewer === "string" ? result.approvalsReviewer : null };
  })();
  read.catch(() => {});
  try {
    return await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(failure("Live turn read timed out.", "TIMEOUT")), timeoutMs); })]);
  } finally {
    abandoned = true; clearTimeout(timer);
    if (connection && unresolved.size) { held = true; connection.unref?.(); } else connection?.close();
  }
}

// The live view of the running turn `turnId`, or why it is not resumed. Only a
// turn codexteer started under the auto reviewer is: under it the service sends
// a resuming reader no request, while a reader that closes on a request it
// holds interrupts the turn.
async function liveTurn(threadId, turnId, live) {
  const started = await (live.turns ?? (async () => new Map()))(threadId);
  if (!started.has(turnId)) return { fallback: "not_codexteer_turn" };
  if (started.get(turnId) !== AUTO_REVIEW) return { fallback: "not_auto_review" };
  return resumeView(threadId, live);
}

const PAGE_ITEMS = 100, ITEM_PAGES = 1000;
// Fill a turn listed without its items from its item pages, because one turn's
// items can exceed what one response carries. Listed after the turn, the items
// are at least as new as its status. Returns the turn as the full items view
// lists it and the bytes its pages took, which may not exceed `room`.
export async function loadTurn(client, threadId, turn, room) {
  const items = [], positions = new Set();
  let position = null, bytes = 0;
  for (let page = 0; page < ITEM_PAGES; page++) {
    const result = await client.request("thread/items/list", { threadId, turnId: turn.id, sortDirection: "asc", limit: PAGE_ITEMS, ...(position ? { cursor: position } : {}) });
    const next = result?.nextCursor ?? null;
    if (!Array.isArray(result?.data) || result.data.length > PAGE_ITEMS || result.data.some(row => row?.turnId !== turn.id || !row.item || typeof row.item !== "object")
      || (next !== null && (typeof next !== "string" || !next || positions.has(next) || !result.data.length))) throw failure("Invalid Cloud item page.");
    bytes += Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > room) throw failure("Cloud history exceeded its memory budget.");
    items.push(...result.data.map(row => row.item));
    if (next === null) return { turn: { ...turn, items, itemsView: "full" }, bytes };
    positions.add(next); position = next;
  }
  throw failure("Cloud history exceeded its pagination limit.");
}

export class DesktopCloudClient {
  // `live.openLive` opens the connection a live read resumes the task on, and
  // `live.turns` lists the turns codexteer started on a task with their
  // reviewers. A client without them does not read running turns live.
  constructor(client, live = {}) {
    this.client = client;
    if (!live.openLive) return;
    this.liveTurn = (threadId, turnId) => liveTurn(threadId, turnId, live);
    // The approvals reviewer the task's next turn starts under, which only a
    // resume reports. An idle task has no request for the connection to hold.
    this.approvalsReviewer = async threadId => {
      const uuid = desktopCloudUuid(threadId), result = await client.request("thread/resume", { threadId: uuid, excludeTurns: true });
      if (result?.thread?.id !== uuid) throw failure("Desktop Cloud returned another task.");
      return typeof result.approvalsReviewer === "string" ? result.approvalsReviewer : null;
    };
  }
  close() { this.client.close(); }
  async history(threadId) {
    const turns = [], seen = new Set(); let cursor, bytes = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.client.request("thread/turns/list", { threadId, itemsView: "notLoaded", sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data?.data) || data.data.some(turn => typeof turn?.id !== "string" || !turn.id) || new Set([...turns, ...data.data].map(turn => turn.id)).size !== turns.length + data.data.length) throw failure("Invalid complete Cloud history.");
      for (const listed of data.data) { const { turn, bytes: size } = await loadTurn(this.client, threadId, listed, 32 * 1024 * 1024 - bytes); bytes += size; turns.push(turn); }
      cursor = data.nextCursor;
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
