import assert from "node:assert/strict";
import { readOnClient } from "../src/observe.mjs";
export function observationServer(thread, beforeRequest = () => {}) {
  const calls = [];
  const key = x => x.item ? `${x.turnId}/${x.item.id}` : x.id;
  const client = { close() {}, async request(method, p) {
    await beforeRequest(method, p);
    calls.push({ method, ...p });
    assert.equal(p.threadId, thread.id);
    if (method === "thread/read") return { thread: { ...structuredClone(thread), turns: p.includeTurns ? structuredClone(thread.turns) : [] } };
    if (method === "turn/steer") return { turnId: p.expectedTurnId };
    if (method === "turn/start") return { turn: { id: "new-turn" } };
    assert.ok(["thread/items/list", "thread/turns/list"].includes(method));
    const scope = `${method}:${p.turnId ?? "all"}`;
    const rows = method === "thread/items/list" ? thread.turns.filter(t => !p.turnId || t.id === p.turnId).flatMap(t => t.items.map(item => ({ item, turnId: t.id }))) : thread.turns.map(t => {
      if (p.itemsView === "full") return { ...t, itemsView: "full" };
      assert.equal(p.itemsView, "notLoaded"); return { ...t, items: [], itemsView: "notLoaded" };
    });
    const sorted = p.sortDirection === "desc" ? [...rows].reverse() : rows;
    let start = 0;
    if (p.cursor) { const c = JSON.parse(p.cursor); assert.equal(c.scope, scope); start = sorted.findIndex(x => key(x) === c.id); if (start < 0) throw Object.assign(new Error("anchor missing"), { code: "STALE_CURSOR" }); if (!c.include) start++; }
    const data = sorted.slice(start, start + p.limit);
    const token = (row, include) => JSON.stringify({ scope, id: key(row), include });
    return structuredClone({ data, backwardsCursor: data.length ? token(data[0], true) : null, nextCursor: start + data.length < sorted.length ? token(data.at(-1), false) : null });
  } };
  return { client, calls, read: options => readOnClient(client, thread.id, options) };
}
