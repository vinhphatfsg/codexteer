// Desktop Cloud reads list turns newest first and stop at the window the cursor
// names, so a read costs the turns at and after the cursor, not the history.
//
// The window is a turn and every newer turn. A v3 cursor is a v1 cursor over the
// window's events, so the v1 delta logic runs unchanged on it. Turns before the
// window were final and fully delivered when the window moved past them. They
// are not read again: this relies on the service appending turns and never
// changing a final turn. The window turn and every newer turn are read and
// checked against the cursor on every read.
import { assertReadOptions, digest, fetchThread, mutableStatus, prefixHash, project, snapshotRead, threadSnapshot } from "./observe.mjs";
import { encodeCursor, invalidCursor, parseCursor } from "./cursor.mjs";
import { hostFields } from "./target.mjs";

const FINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const PAGES = 1000, BYTES = 32 * 1024 * 1024;
const failure = message => Object.assign(new Error(message), { code: "DESKTOP_CLOUD_PROTOCOL_ERROR" });
const startedAt = turn => Number.isSafeInteger(turn?.startedAt) && turn.startedAt >= 0 ? turn.startedAt : null;

// List turns newest first, one per request, until `stop` returns true for a
// turn. Returns the turns listed, oldest first, and whether the list ended.
async function newestTurns(client, threadId, stop) {
  const turns = [], ids = new Set(), positions = new Set();
  let position = null, bytes = 0, newer = null;
  for (let page = 0; page < PAGES; page++) {
    const result = await client.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "desc", limit: 1, ...(position ? { cursor: position } : {}) });
    const next = result?.nextCursor ?? null;
    if (!Array.isArray(result?.data) || (next !== null && (typeof next !== "string" || !next || positions.has(next) || !result.data.length))) throw failure("Invalid Cloud turn page.");
    bytes += Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > BYTES) throw failure("Cloud history exceeded its memory budget.");
    for (const [index, turn] of result.data.entries()) {
      if (typeof turn?.id !== "string" || !turn.id || ids.has(turn.id) || typeof turn.status !== "string" || !Array.isArray(turn.items) || turn.itemsView !== "full") throw failure("Invalid Cloud turn page.");
      if (startedAt(turn) !== null && newer !== null && startedAt(turn) > newer) throw failure("Cloud turns were not listed newest first.");
      newer = startedAt(turn) ?? newer; ids.add(turn.id); turns.push(turn);
      if (stop(turn)) return { turns: turns.reverse(), ended: next === null && index === result.data.length - 1 };
    }
    if (next === null) return { turns: turns.reverse(), ended: true };
    positions.add(next); position = next;
  }
  throw failure("Cloud history exceeded its pagination limit.");
}

// The window a v3 cursor names. A turn that started before the window turn
// proves the window turn is gone, so a missing turn costs no older history.
async function windowTurns(client, threadId, claim) {
  const { turns } = await newestTurns(client, threadId, turn => {
    if (turn.id === claim.window) return true;
    if (claim.window_started_at !== null && startedAt(turn) !== null && startedAt(turn) < claim.window_started_at) throw invalidCursor();
    return false;
  });
  if (claim.window !== null && turns[0]?.id !== claim.window) throw invalidCursor();
  return turns;
}

// Move the window to the turn holding the earliest event a later read still
// needs: the last delivered event, a change not yet delivered, or any delivered
// event of a turn that is not final. Every turn before it is final, delivered
// and has nothing pending, so the cursor no longer covers it.
function rebase(turns, s, cursor) {
  const starts = turns.map(turn => s.events.findIndex(event => event.type === "turn" && event.id === turn.id));
  const pins = [cursor.count - 1, ...cursor.open.filter(x => s.hashes[x.index] !== x.hash).map(x => x.index),
    ...turns.flatMap((turn, k) => !FINAL.has(turn.status) && starts[k] < cursor.count ? [starts[k]] : [])].filter(index => index >= 0);
  const k = pins.length ? starts.findLastIndex(start => start <= Math.min(...pins)) : 0, offset = turns.length ? starts[k] : 0;
  const open = cursor.open.filter(x => x.index >= offset).map(x => ({ index: x.index - offset, hash: x.hash })), count = cursor.count - offset;
  const rest = s.events.slice(offset), hashes = s.hashes.slice(offset);
  const settled = k === turns.length - 1 && FINAL.has(turns[k].status) && count === rest.length
    && open.every(x => hashes[x.index] === x.hash) && !rest.some(event => mutableStatus.has(event.status));
  return { v: 3, window: turns[k]?.id ?? null, window_started_at: startedAt(turns[k]), settled, count, open, prefix: prefixHash(hashes, count, open),
    state: cursor.state, active_turn_id: cursor.active_turn_id, latest_turn_id: cursor.latest_turn_id,
    user_revision: digest(rest.filter(event => event.type === "userMessage")) };
}

// While a settled window's turn is still the newest and the state is the same,
// its items are as delivered, so the read lists that turn's id and status only.
async function quietRead(client, thread, claim, since) {
  let page;
  try { page = await client.request("thread/turns/list", { threadId: thread.id, itemsView: "notLoaded", sortDirection: "desc", limit: 1 }); }
  catch (error) { if (error.rpcCode === -32602) return null; throw error; }
  const newest = page?.data?.[0];
  if (!Array.isArray(page?.data) || (newest && (typeof newest.id !== "string" || typeof newest.status !== "string"))) throw failure("Invalid Cloud turn page.");
  if (newest?.id !== claim.window) return null;
  const { state } = threadSnapshot({ ...thread, turns: [{ id: newest.id, status: newest.status, items: [] }] });
  if (digest(state) !== claim.state) return null;
  return { ...state, events: [], running_commands: [], ...hostFields(), cursor: since, changed: false, has_more: false, omitted_older_events: 0,
    observed_at: new Date().toISOString(), history_scope: "tail-turns" };
}

export async function readCloudTail(client, thread, options = {}) {
  const { since, limit = 50 } = options;
  assertReadOptions(options);
  const old = since ? parseCursor(since, thread.id) : null;
  if (old && old.v !== 1 && old.v !== 3) throw invalidCursor();
  if (old?.settled) { const quiet = await quietRead(client, thread, old, since); if (quiet) return quiet; }
  let turns, ended = true;
  // A cursor from an earlier version covers the whole history: read it in full
  // once, and continue from the v3 cursor this read returns.
  if (old?.v === 1) turns = (await fetchThread(client, thread.id, thread)).turns;
  else if (old) turns = await windowTurns(client, thread.id, old);
  else {
    let events = 0;
    ({ turns, ended } = await newestTurns(client, thread.id, turn => (events += 1 + turn.items.filter(item => project(item, turn.id)).length) >= limit));
  }
  const view = { ...thread, turns }, s = threadSnapshot(view), result = snapshotRead(view, s, old, options);
  return { ...result, cursor: encodeCursor(rebase(turns, s, result.cursor), thread.id),
    ...(ended ? {} : { omitted_older_events: null }), history_scope: "tail-turns" };
}

// The --based-on check for a v3 cursor: no new user input and the same latest
// and active turn, over the window the cursor names.
export async function verifyCloudFreshness(client, threadId, claim) {
  const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId) throw invalidCursor();
  const turns = await windowTurns(client, threadId, claim), s = threadSnapshot({ ...thread, turns });
  if (turns.at(-1)?.id !== claim.latest_turn_id || s.state.active_turn_id !== claim.active_turn_id || s.user_revision !== claim.user_revision) {
    throw Object.assign(new Error("New user input or a different turn was observed. Read the task again before sending."), { code: "STALE_OBSERVATION" });
  }
}
