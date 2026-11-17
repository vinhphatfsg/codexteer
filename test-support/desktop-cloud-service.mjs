import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { RpcFailure } from "../src/rpc.mjs";

// A scripted Desktop Cloud service, used behind the real DesktopCloudClient.
// thread/turns/list behaves like the service: newest first unless asked
// otherwise, the full and notLoaded items views only, and a cursor naming the
// last turn returned. thread/items/list lists the same items as `{ turnId, item }`
// rows, of one turn when asked, in pages with a cursor naming the last row and
// a backwards cursor that lists the other way from the first row, inclusive.
// `receiveLimit` bounds every response. `served.turns` counts the turns whose
// items were sent, as a full turn or from the first item page of that turn, so
// tests can bound the cost of a read; `served.ids` counts notLoaded turns and
// `served.pages` item pages.
//
// With `liveTurn`, the history shows a running turn with its opening message
// only, as the service does, and `openLive` opens the separate connection a
// live read resumes the task on. `state.live` scripts that connection and
// records every resume, and an idle resume as a wake of the task's environment.
export function desktopCloudService(uuid, { environment, receiveLimit = Infinity, liveTurn = false } = {}) {
  const state = { turns: [], flags: [], environment, status: "idle", lost: false, missing: false, calls: [], receiveLimit,
    served: { requests: 0, turns: 0, bytes: 0, ids: 0, pages: 0 }, clock: 1_800_000_000, hideRunning: liveTurn,
    live: { resumes: [], wakes: 0, failure: null, requests: [], flags: [], beforeResume: null, itemId: id => id, item: item => item, connections: [] } };
  const turn = (fields = {}) => ({ id: `turn-${state.turns.length}`, status: "completed", startedAt: state.clock++, items: [], ...fields });
  const listed = row => state.hideRunning && row.status === "inProgress" ? { ...row, items: row.items.slice(0, 1) } : row;
  const rpc = { close() {}, async request(method, params) {
    state.calls.push({ method, params });
    if (method === "model/list") return { data: [{ model: "neutral-default", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }] };
    if (method === "thread/start" && state.lostCreate) throw Object.assign(new Error("creation receipt lost"), { uncertain: true });
    if (method === "thread/start") return { thread: { id: uuid } };
    if (method === "thread/name/set") return {};
    if (method === "thread/read") {
      if (state.missing) throw Object.assign(new Error("not visible"), { code: "THREAD_NOT_FOUND" });
      return { thread: { id: uuid, name: "worker", status: { type: state.status, ...(state.flags === null ? {} : { activeFlags: state.flags }) },
        environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: state.environment }] } };
    }
    if (method === "thread/turns/list") {
      if (!["full", "notLoaded"].includes(params.itemsView) || (params.itemsView === "notLoaded" && state.rejectNotLoaded)) throw new RpcFailure("thread/turns/list was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32602 });
      const direction = params.sortDirection ?? "desc", ordered = direction === "desc" ? [...state.turns].reverse() : state.turns;
      let start = 0;
      if (params.cursor) {
        const anchor = JSON.parse(params.cursor);
        if (anchor.direction !== direction) throw new RpcFailure("thread/turns/list was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32602 });
        start = ordered.findIndex(row => row.id === anchor.id) + 1;
        if (start === 0) throw new RpcFailure("thread/turns/list was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32602 });
      }
      const rows = ordered.slice(start, start + (params.limit ?? 25)), full = params.itemsView === "full";
      const data = structuredClone(rows.map(row => full ? { ...listed(row), itemsView: "full" } : { ...row, items: [], itemsView: "notLoaded" })), bytes = Buffer.byteLength(JSON.stringify(data));
      Object.assign(state.served, { requests: state.served.requests + 1, bytes: state.served.bytes + bytes,
        turns: state.served.turns + (full ? data.length : 0), ids: state.served.ids + (full ? 0 : data.length) });
      if (bytes > state.receiveLimit) throw new RpcFailure("App Server response exceeded the 16 MiB receive limit. Use paginated history access; the receive limit remains enforced.", { code: "PAYLOAD_TOO_LARGE" });
      return { data, nextCursor: start + rows.length < ordered.length ? JSON.stringify({ direction, id: rows.at(-1).id }) : null, backwardsCursor: null };
    }
    if (method === "thread/items/list") {
      const rejected = () => new RpcFailure("thread/items/list was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32602 });
      const direction = params.sortDirection ?? "asc", turns = state.turns.filter(row => !params.turnId || row.id === params.turnId);
      if (params.turnId && !turns.length) throw rejected();
      const rows = turns.flatMap(row => listed(row).items.map(item => ({ turnId: row.id, item }))), ordered = direction === "desc" ? rows.reverse() : rows;
      const at = (anchor, list) => list.findIndex(row => row.turnId === anchor.turnId && row.item.id === anchor.id);
      let start = 0;
      if (params.cursor) {
        const anchor = JSON.parse(params.cursor);
        if (anchor.direction !== direction || (anchor.scope ?? null) !== (params.turnId ?? null) || at(anchor, ordered) < 0) throw rejected();
        start = at(anchor, ordered) + (anchor.inclusive ? 0 : 1);
      }
      const page = ordered.slice(start, start + (params.limit ?? 25)), data = structuredClone(page), bytes = Buffer.byteLength(JSON.stringify(data));
      const position = (row, towards, inclusive = false) => JSON.stringify({ direction: towards, scope: params.turnId ?? null, turnId: row.turnId, id: row.item.id, inclusive });
      Object.assign(state.served, { requests: state.served.requests + 1, bytes: state.served.bytes + bytes, pages: state.served.pages + 1,
        turns: state.served.turns + (params.turnId && !params.cursor ? 1 : 0) });
      if (bytes > state.receiveLimit) throw new RpcFailure("App Server response exceeded the 16 MiB receive limit. Use paginated history access; the receive limit remains enforced.", { code: "PAYLOAD_TOO_LARGE" });
      return { data, nextCursor: start + page.length < ordered.length ? position(page.at(-1), direction) : null,
        backwardsCursor: page.length ? position(page[0], direction === "asc" ? "desc" : "asc", true) : null };
    }
    if (method === "turn/start") {
      const started = turn({ status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", clientId: state.nullClientId ? null : params.clientUserMessageId, content: params.input }] });
      state.turns.push(started); state.status = "active";
      if (state.lost) throw Object.assign(new Error("lost receipt"), { uncertain: true });
      return { turn: { id: started.id } };
    }
    if (method === "turn/steer") { state.turns.at(-1).items.push({ id: randomUUID(), type: "userMessage", clientId: params.clientUserMessageId, content: params.input }); return { turnId: state.turns.at(-1).id }; }
    throw new Error(`Unexpected ${method}`);
  } };
  // The connection a live read opens. Replayed server requests arrive after
  // the resume response; `calls` holds everything the client sent on it.
  const openLive = async () => {
    const connection = Object.assign(new EventEmitter(), { calls: [], closed: false });
    state.live.connections.push(connection);
    connection.request = async (method, params) => {
      connection.calls.push({ method, params });
      if (method !== "thread/resume") throw new Error(`Unexpected ${method}`);
      state.live.beforeResume?.();
      const running = state.turns.at(-1)?.status === "inProgress";
      state.live.resumes.push({ threadId: params.threadId, running });
      if (!running) state.live.wakes++;
      if (state.live.failure === "error") throw new RpcFailure("thread/resume was rejected by App Server.", { code: "RPC_REJECTED", rpcCode: -32603 });
      if (state.live.failure === "timeout") return new Promise(() => {});
      setImmediate(() => state.live.requests.forEach((request, n) => connection.emit("serverRequest", { id: `replayed-${n}`, method: request, params: { threadId: params.threadId } })));
      const turns = structuredClone(state.turns).map(row => ({ ...row, items: row.items.map(item => state.live.item({ ...item, id: state.live.itemId(item.id) })) }));
      return { thread: { id: params.threadId, status: { type: state.status, activeFlags: state.live.flags }, turns },
        initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null, resumeKind: "attached" };
    };
    connection.notify = method => { connection.calls.push({ method }); };
    connection.close = () => { connection.closed = true; };
    return connection;
  };
  // A completed turn as the service shows it: its items appear when it ends.
  const complete = (items = [], status = "completed") => {
    const running = state.turns.at(-1);
    running.status = status; running.items.push(...items); state.status = "idle";
  };
  const append = (items = [], fields = {}) => { const added = turn({ items, ...fields }); state.turns.push(added); return added; };
  // Items the running turn produced since it started; the history shows them when it ends.
  const progress = (...items) => { state.turns.at(-1).items.push(...items); return items; };
  const resetServed = () => Object.assign(state.served, { requests: 0, turns: 0, bytes: 0, ids: 0, pages: 0 });
  return { rpc, state, complete, append, progress, resetServed, openLive };
}
