import { randomUUID } from "node:crypto";
import { RpcFailure } from "../src/rpc.mjs";

// A scripted Desktop Cloud service, used behind the real DesktopCloudClient.
// thread/turns/list behaves like the service: newest first unless asked
// otherwise, the full and notLoaded items views only, and a cursor naming the
// last turn returned. `served` counts the full turns the listing sent, so tests
// can bound the cost of a read; `served.ids` counts notLoaded turns.
export function desktopCloudService(uuid, { environment, receiveLimit = Infinity } = {}) {
  const state = { turns: [], flags: [], environment, status: "idle", lost: false, missing: false, calls: [], receiveLimit,
    served: { requests: 0, turns: 0, bytes: 0, ids: 0 }, clock: 1_800_000_000 };
  const turn = (fields = {}) => ({ id: `turn-${state.turns.length}`, status: "completed", startedAt: state.clock++, items: [], ...fields });
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
      const data = structuredClone(rows.map(row => full ? { ...row, itemsView: "full" } : { ...row, items: [], itemsView: "notLoaded" })), bytes = Buffer.byteLength(JSON.stringify(data));
      Object.assign(state.served, { requests: state.served.requests + 1, bytes: state.served.bytes + bytes,
        turns: state.served.turns + (full ? data.length : 0), ids: state.served.ids + (full ? 0 : data.length) });
      if (bytes > state.receiveLimit) throw new RpcFailure("App Server response exceeded the 16 MiB receive limit. Use paginated history access; the receive limit remains enforced.", { code: "PAYLOAD_TOO_LARGE" });
      return { data, nextCursor: start + rows.length < ordered.length ? JSON.stringify({ direction, id: rows.at(-1).id }) : null, backwardsCursor: null };
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
  // A completed turn as the service shows it: its items appear when it ends.
  const complete = (items = [], status = "completed") => {
    const running = state.turns.at(-1);
    running.status = status; running.items.push(...items); state.status = "idle";
  };
  const append = (items = [], fields = {}) => { const added = turn({ items, ...fields }); state.turns.push(added); return added; };
  const resetServed = () => Object.assign(state.served, { requests: 0, turns: 0, bytes: 0, ids: 0 });
  return { rpc, state, complete, append, resetServed };
}
