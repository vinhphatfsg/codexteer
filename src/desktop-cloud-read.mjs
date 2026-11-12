// Desktop Cloud reads list turns newest first and stop at the window the cursor
// names, so a read costs the turns at and after the cursor, not the history.
//
// The window is a turn and every newer turn. A v3 cursor is a v1 cursor over the
// window's events, so the v1 delta logic runs unchanged on it. Turns before the
// window were final and fully delivered when the window moved past them. They
// are not read again: this relies on the service appending turns and never
// changing a final turn. The window turn and every newer turn are read and
// checked against the cursor on every read.
import { assertReadOptions, digest, fetchThread, mutableStatus, prefixHash, project, snapshotRead, threadSnapshot, trimEvent } from "./observe.mjs";
import { encodeCursor, invalidCursor, parseCursor } from "./cursor.mjs";
import { hostFields } from "./target.mjs";
import { turnEvidence } from "./attention-coverage.mjs";

const FINAL = new Set(["completed", "failed", "interrupted", "cancelled"]), RUNNING = new Set(["inProgress", "in_progress", "running", "pending", "queued"]);
const PAGES = 1000, BYTES = 32 * 1024 * 1024;
// The live ledger lives in the cursor, so its size bounds the cursor's.
const LIVE_ITEMS = 256, REQUEST = "pendingRequest:";
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

// The newest turn's id and status, without its items where the service allows.
export async function newestTurn(client, threadId) {
  const list = itemsView => client.request("thread/turns/list", { threadId, itemsView, sortDirection: "desc", limit: 1 });
  const page = await list("notLoaded").catch(error => error.rpcCode === -32602 ? list("full") : Promise.reject(error));
  const newest = page?.data?.[0];
  if (!Array.isArray(page?.data) || (newest && (typeof newest.id !== "string" || !newest.id || typeof newest.status !== "string"))) throw failure("Invalid Cloud turn page.");
  return newest ? { id: newest.id, status: newest.status } : null;
}

// Every turn's id and status, oldest first, without items. Null when the
// service does not list turns without their items.
export async function turnStatuses(client, threadId) {
  const turns = [], positions = new Set();
  let position = null;
  for (let page = 0; page < PAGES; page++) {
    const result = await client.request("thread/turns/list", { threadId, itemsView: "notLoaded", sortDirection: "desc", limit: 100, ...(position ? { cursor: position } : {}) })
      .catch(error => error.rpcCode === -32602 ? null : Promise.reject(error));
    if (result === null) return null;
    const next = result?.nextCursor ?? null;
    if (!Array.isArray(result?.data) || result.data.some(turn => typeof turn?.id !== "string" || !turn.id || typeof turn.status !== "string")
      || (next !== null && (typeof next !== "string" || !next || positions.has(next) || !result.data.length))) throw failure("Invalid Cloud turn page.");
    turns.push(...result.data.map(turn => ({ id: turn.id, status: turn.status })));
    if (next === null) return turns.reverse();
    positions.add(next); position = next;
  }
  throw failure("Cloud history exceeded its pagination limit.");
}

// While a settled window's turn is still the newest and the state is the same,
// its items are as delivered, so the read lists that turn's id and status only.
async function quietRead(client, thread, claim, since) {
  const newest = await newestTurn(client, thread.id);
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
  const cursor = rebase(turns, s, result.cursor), live = await withLiveTurn(client, thread.id, turns, s, old, result, options);
  return { ...result, ...live.fields, cursor: encodeCursor({ ...cursor, settled: cursor.settled && !live.ledger, ...(live.ledger ? { live: live.ledger } : {}),
    ...(live.refused ? { live_refused: true } : {}) }, thread.id), ...(ended ? {} : { omitted_older_events: null }), history_scope: "tail-turns" };
}

// A command's reads of one task share a live view while the history lists the
// same running turn, so a command resumes each running task once. `scope` is
// that command's, never the process's.
function liveView(client, threadId, turnId, scope) {
  const shared = scope.get(threadId);
  if (shared?.turn_id === turnId) return shared.view;
  const view = client.liveTurn(threadId).catch(() => null);
  scope.set(threadId, { turn_id: turnId, view });
  return view;
}

// The events of the running turn `turn` that the live view adds to the
// history, with their hashes. Null when the view is not of this turn while it
// runs, an item is malformed, or an item the history lists differs in it.
function liveEvents(view, turn, s) {
  const items = view?.turn?.id === turn.id && RUNNING.has(view.turn.status) && Array.isArray(view.turn.items) ? view.turn.items : null;
  if (!items || items.some(item => !item || typeof item !== "object" || typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type
    || (item.questions != null && !Array.isArray(item.questions)))) return null;
  const events = items.map(item => project(item, turn.id)).filter(Boolean), hashes = new Map(events.map(event => [event.id, digest(event)]));
  if (hashes.size !== events.length) return null;
  const listed = s.events.flatMap((event, i) => event.turn_id === turn.id && event.type !== "turn" ? [[event.id, s.hashes[i]]] : []);
  if (listed.some(([id, hash]) => hashes.get(id) !== hash)) return null;
  const known = new Set(listed.map(([id]) => id));
  return events.filter(event => !known.has(event.id)).map(event => ({ event, hash: hashes.get(event.id) }));
}

// What the live view says the task waits on: its flags and the methods of the
// server requests replayed to the reader.
const liveAttention = view => [...new Set([...(Array.isArray(view.status?.activeFlags) ? view.status.activeFlags.filter(flag => typeof flag === "string") : []),
  ...view.requests.map(method => REQUEST + method)])].sort();

// Desktop Cloud lists a running turn's items only when it ends. The cursor's
// ledger records what a read delivered from the live view of that turn, so the
// history cursor stays as the history proves it and a read without the live
// view still validates. Each item is delivered once, whichever view lists it
// first; a changed one is an update. Completed history that does not list an
// item the live view delivered refuses live reads of the task from then on.
async function withLiveTurn(client, threadId, turns, s, old, result, { liveTurn: scope, limit = 50, maxChars = 2000, includeOutput = false, fullEvents = false }) {
  const ledger = old?.v === 3 ? old.live ?? null : null, delivered = new Map(ledger?.items.map(item => [item.id, item.hash]) ?? []);
  let events = result.events, hasMore = result.has_more, attention = ledger?.attention ?? [], turnId = ledger?.turn ?? null, refused = !!old?.live_refused;
  const fields = {}, commands = [], trim = event => fullEvents ? event : trimEvent(event, maxChars, includeOutput);
  if (ledger) {
    const items = new Map(s.events.flatMap((event, i) => event.turn_id === turnId && event.type !== "turn" ? [[event.id, i]] : []));
    events = events.flatMap(event => event.turn_id !== turnId || event.type === "turn" || !delivered.has(event.id) ? [event]
      : s.hashes[items.get(event.id)] === delivered.get(event.id) ? [] : [{ ...event, change: "updated" }]);
    for (const [id, i] of items) if (i < result.cursor.count) delivered.delete(id);
    const listed = turns.find(turn => turn.id === turnId);
    if (!listed || FINAL.has(listed.status)) attention = [];
    if (!listed || (FINAL.has(listed.status) && !hasMore)) {
      if (delivered.size) { fields.live_mismatch = { turn_id: turnId, unlisted: delivered.size }; refused = true; }
      delivered.clear(); turnId = null;
    }
  }
  const running = turns.at(-1);
  if (scope instanceof Map && typeof client.liveTurn === "function" && !refused && !hasMore && turnEvidence(s.state) === "running" && s.state.active_turn_count === 1
    && running && RUNNING.has(running.status) && (turnId === null || turnId === running.id)) {
    const view = await liveView(client, threadId, running.id, scope), fresh = view && liveEvents(view, running, s);
    const changed = fresh?.filter(({ event, hash }) => delivered.get(event.id) !== hash) ?? [];
    if (fresh && delivered.size + changed.filter(({ event }) => !delivered.has(event.id)).length <= LIVE_ITEMS) {
      const sent = changed.slice(0, Math.max(0, limit - events.length));
      events = [...events, ...sent.map(({ event }) => ({ ...trim(event), change: delivered.has(event.id) ? "updated" : "added" }))];
      for (const { event, hash } of sent) delivered.set(event.id, hash);
      hasMore = changed.length > sent.length; attention = liveAttention(view); turnId = running.id; fields.live_turn_id = running.id;
      commands.push(...fresh.map(({ event }) => event).filter(event => event.type === "commandExecution" && mutableStatus.has(event.status)).map(event => trimEvent(event, maxChars, includeOutput)));
    }
  }
  const before = old?.v === 3 ? old.live?.attention ?? [] : [], requests = attention.filter(flag => flag.startsWith(REQUEST)).map(flag => flag.slice(REQUEST.length));
  if (requests.length) fields.pending_requests = requests;
  return { refused, ledger: turnId !== null && (delivered.size || attention.length) ? { turn: turnId, items: [...delivered].map(([id, hash]) => ({ id, hash })), attention } : null,
    fields: { ...fields, events, has_more: hasMore, running_commands: [...result.running_commands, ...commands],
      attention: Array.isArray(result.attention) ? [...new Set([...result.attention, ...attention])] : result.attention,
      changed: !old || events.length > 0 || old.state !== result.cursor.state || JSON.stringify(before) !== JSON.stringify(attention) } };
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
