import { digest, project, trimEvent, decodeCursor, invalidCursor } from "./observe.mjs";

const PAGE = 100;
const running = new Set(["inProgress", "running", "pending"]);
const eventKey = e => `${e.turn_id}:${e.id}`;
const itemEvent = row => project(row.item, row.turnId);
const itemHash = row => { const e = itemEvent(row); return e ? digest(e) : null; };
const turnEvent = t => ({ id: t.id, turn_id: t.id, type: "turn", status: t.status });
const sameRow = (row, anchor) => row?.item?.id === anchor.id && row.turnId === anchor.turn_id;
const anchor = (row, cursor) => ({ cursor, id: row.item.id, turn_id: row.turnId, hash: itemHash(row) });
const observationChanged = () => Object.assign(new Error("A turn started while reading. Retry from the same cursor."), { code: "OBSERVATION_CHANGED" });

export async function turnMetadata(client, threadId) {
  const turns = [], seen = new Set(), ids = new Set(); let cursor;
  do {
    const page = await client.request("thread/turns/list", { threadId, itemsView: "notLoaded", sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data) || (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor) || !page.data.length))) throw invalidCursor();
    for (const t of page.data) {
      if (typeof t?.id !== "string" || !t.id || typeof t.status !== "string" || !t.status || ids.has(t.id)) throw invalidCursor();
      turns.push({ id: t.id, status: t.status }); ids.add(t.id);
    }
    cursor = page.nextCursor; seen.add(cursor);
  } while (cursor);
  return turns;
}

function stateOf(thread, turns) {
  const active = turns.filter(t => t.status === "inProgress");
  return { thread_id: thread.id, status: thread.status?.type ?? "unknown", active_turn_id: active.length === 1 ? active[0].id : null,
    attention: Array.isArray(thread.status?.activeFlags) ? thread.status.activeFlags : thread.status?.type === "active" ? null : [], cwd: thread.cwd ?? null, title: thread.name ?? null };
}

async function items(client, threadId, { cursor = null, turnId = null, direction = "asc", limit = PAGE } = {}) {
  const page = await client.request("thread/items/list", { threadId, sortDirection: direction, limit, ...(cursor ? { cursor } : {}), ...(turnId ? { turnId } : {}) });
  if (!Array.isArray(page.data) || page.data.length > limit || !page.data.every(x => x?.item?.id && typeof x.turnId === "string")
    || new Set(page.data.map(x => `${x.turnId}:${x.item.id}`)).size !== page.data.length
    || (page.nextCursor && (!page.data.length || page.nextCursor === cursor))) throw invalidCursor();
  return page;
}

// Obtain an inclusive ascending bookmark exclusively from server-issued cursors.
// The extra queries are bounded to one page; never synthesize rollout ordinals.
async function bookmark(client, threadId, query, page, index) {
  const expected = page.data[index]; let one;
  if (index === 0) one = { data: [expected], backwardsCursor: page.backwardsCursor };
  else {
    const prefix = await items(client, threadId, { ...query, limit: index });
    if (prefix.data.length !== index || !prefix.nextCursor) throw invalidCursor();
    one = await items(client, threadId, { ...query, cursor: prefix.nextCursor, limit: 1 });
  }
  if (!one.backwardsCursor || !sameRow(one.data[0], { id: expected.item.id, turn_id: expected.turnId })) throw invalidCursor();
  if (query.direction !== "desc") {
    one = await items(client, threadId, { ...query, cursor: one.backwardsCursor, direction: "desc", limit: 1 });
    if (!one.backwardsCursor || !sameRow(one.data[0], { id: expected.item.id, turn_id: expected.turnId })) throw invalidCursor();
  }
  return one.backwardsCursor;
}

function addGroup(groups, query, rows, lastPublic, consumed = rows.length) {
  const known = new Set(groups.flatMap(g => g.items.map(i => `${i.turn_id}:${i.id}`)));
  const tracked = [];
  for (let index = 0; index < consumed; index++) {
    const row = rows[index], e = itemEvent(row);
    if (e && !known.has(eventKey(e)) && (running.has(e.status) || e.id === lastPublic)) tracked.push({ index, id: e.id, turn_id: e.turn_id, hash: digest(e), mode: running.has(e.status) ? "running" : "tail" });
  }
  if (tracked.length) groups.push({ cursor: query.cursor ?? null, turn_id: query.turnId ?? null, count: consumed, items: tracked });
}

function validateTurns(old, turns) {
  if (old.turns.length > turns.length || old.turns.some((t, i) => t.id !== turns[i].id || (t.status !== turns[i].status && !running.has(t.status)))) throw invalidCursor();
}

function finish(state, cursor, events, commands, old, pending, omitted) {
  cursor.state = digest(state); cursor.active_turn_id = state.active_turn_id; cursor.pending = pending;
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (encoded.length > 1024 * 1024) throw new Error("Too many in-progress items for a fast cursor. Use --full-history.");
  return { ...state, events, running_commands: [...commands.values()], cursor: encoded, changed: !old || events.length > 0 || old.state !== cursor.state,
    has_more: pending, omitted_older_events: omitted, history_scope: "tail-and-tracked-items", running_commands_complete: !pending, observed_at: new Date().toISOString() };
}

export async function readPaged(client, thread, { since, limit = 50, maxChars = 2000, includeOutput = false } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20000) throw new Error("Invalid read limit or max-chars.");
  const old = since ? decodeCursor(since, thread.id) : null;
  if (old && old.v !== 2) throw invalidCursor();
  const turns = await turnMetadata(client, thread.id), state = stateOf(thread, turns), commands = new Map();
  const clip = e => trimEvent(e, maxChars, includeOutput);
  const command = e => { if (e?.type === "commandExecution" && running.has(e.status)) commands.set(eventKey(e), clip(e)); };
  if (!old) {
    const rows = [], pages = []; let position = null, publicCount = 0, head = { cursor: null, id: null, turn_id: null, hash: null };
    do {
      const query = { cursor: position, direction: "desc", limit: Math.min(PAGE, Math.max(50, limit - publicCount)) };
      const page = await items(client, thread.id, query);
      if (!pages.length && page.data.length) { if (!page.backwardsCursor) throw invalidCursor(); head = anchor(page.data[0], page.backwardsCursor); }
      pages.push({ query, page }); rows.push(...page.data); publicCount += page.data.filter(x => itemEvent(x)).length;
      position = page.nextCursor;
    } while (position && publicCount < limit);
    const knownTurns = new Set(turns.map(t => t.id));
    if (rows.some(r => !knownTurns.has(r.turnId))) throw observationChanged();
    const latestPublic = rows.find(r => itemEvent(r))?.item.id ?? null;
    const groups = [], replacements = new Map();
    // Bootstrap only live turns, so old running commands aren't lost when they
    // fall outside the display tail. Subsequent reads refresh their pages only.
    for (const t of turns.filter(t => running.has(t.status))) {
      if (head.id === null || turns.findIndex(x => x.id === t.id) > turns.findIndex(x => x.id === head.turn_id)) continue;
      let cursor = null;
      do {
        const query = { cursor, turnId: t.id, direction: "asc", limit: PAGE }, page = await items(client, thread.id, query);
        const atHead = t.id === head.turn_id ? page.data.findIndex(row => row.item.id === head.id) : -1;
        const consumed = atHead < 0 ? page.data.length : atHead + 1;
        for (const row of page.data.slice(0, consumed)) { replacements.set(`${row.turnId}:${row.item.id}`, row); command(itemEvent(row)); }
        addGroup(groups, query, page.data, latestPublic, consumed);
        if (atHead >= 0) break;
        cursor = page.nextCursor;
        if (!cursor && t.id === head.turn_id) throw invalidCursor();
      } while (cursor);
    }
    for (const { query, page } of pages) {
      for (let index = 0; index < page.data.length; index++) {
        const row = page.data[index], e = itemEvent(row);
        if (!e || !(running.has(e.status) || e.id === latestPublic) || groups.some(g => g.items.some(i => i.id === e.id && i.turn_id === e.turn_id)) || row.item.id === head.id) continue;
        const cursor = await bookmark(client, thread.id, query, page, index);
        groups.push({ cursor, turn_id: null, count: 1, items: [{ index: 0, id: e.id, turn_id: e.turn_id, hash: digest(e), mode: running.has(e.status) ? "running" : "tail" }] });
      }
    }
    const byTurn = new Map();
    for (let row of [...rows].reverse()) {
      row = replacements.get(`${row.turnId}:${row.item.id}`) ?? row;
      const e = itemEvent(row); command(e);
      if (e) { const list = byTurn.get(row.turnId) ?? []; list.push(e); byTurn.set(row.turnId, list); }
      if (row.item.id === head.id) head.hash = itemHash(row);
    }
    const events = turns.flatMap(t => [turnEvent(t), ...byTurn.get(t.id) ?? []]).slice(-limit).map(e => ({ ...clip(e), change: "added" }));
    const cursor = { v: 2, thread_id: thread.id, turns, head, groups, last_public: latestPublic, state: "", active_turn_id: state.active_turn_id, pending: false };
    return finish(state, cursor, events, commands, null, false, position ? null : Math.max(0, publicCount + turns.length - events.length));
  }

  validateTurns(old, turns);
  const cursor = structuredClone(old), events = [], emitted = new Set(); let pending = false;
  const emit = (e, change) => {
    if (emitted.has(eventKey(e))) return true;
    if (events.length >= limit) { pending = true; return false; }
    events.push({ ...clip(e), change }); emitted.add(eventKey(e)); return true;
  };
  for (let i = 0; i < cursor.turns.length; i++) if (cursor.turns[i].status !== turns[i].status && emit(turnEvent(turns[i]), "updated")) cursor.turns[i] = turns[i];
  const refreshed = [];
  for (const group of cursor.groups) {
    const page = await items(client, thread.id, { cursor: group.cursor, turnId: group.turn_id, limit: group.count });
    const tracked = [];
    for (const record of group.items) {
      const row = page.data[record.index];
      if (!sameRow(row, record)) throw invalidCursor();
      const e = itemEvent(row); if (!e) throw invalidCursor(); command(e);
      const hash = digest(e), delivered = hash === record.hash || emit(e, "updated");
      if (delivered) { record.hash = hash; record.mode = running.has(e.status) ? "running" : "tail"; }
      if (!delivered || running.has(e.status) || e.id === cursor.last_public) tracked.push(record);
    }
    if (tracked.length) refreshed.push({ ...group, items: tracked });
  }
  cursor.groups = refreshed;
  let next = old.head.cursor, checkAnchor = !!old.head.id, lastConsumed = null, reachedEnd = false, pagesRead = 0;
  while (!pending) {
    const query = { cursor: next, direction: "asc", limit: Math.min(PAGE, Math.max(50, limit - events.length + (checkAnchor ? 1 : 0))) };
    const page = await items(client, thread.id, query);
    pagesRead++;
    if (checkAnchor && !sameRow(page.data[0], old.head)) throw invalidCursor();
    let consumed = 0;
    for (let i = 0; i < page.data.length; i++) {
      const row = page.data[i], e = itemEvent(row); command(e);
      if (checkAnchor && i === 0) {
        const hash = itemHash(row);
        if (hash !== old.head.hash && e && !emit(e, "updated")) break;
        cursor.head.hash = hash; consumed++; continue;
      }
      const turnIndex = turns.findIndex(t => t.id === row.turnId);
      if (turnIndex < 0) throw observationChanged();
      while (cursor.turns.length <= turnIndex) {
        const t = turns[cursor.turns.length];
        if (!emit(turnEvent(t), "added")) break;
        cursor.turns.push(t);
      }
      if (pending || (e && !emit(e, "added"))) break;
      if (e) cursor.last_public = e.id;
      consumed++; lastConsumed = { query, page, index: i, row };
    }
    addGroup(cursor.groups, query, page.data, cursor.last_public, consumed);
    if (consumed < page.data.length) { pending = true; break; }
    checkAnchor = false;
    if (!page.nextCursor) { reachedEnd = true; break; }
    next = page.nextCursor;
    if (events.length >= limit || pagesRead >= 10) { pending = true; break; }
  }
  if (lastConsumed) {
    let position;
    // The common case ends at the current tail. The identity check prevents
    // skipping an item appended between the page read and this bookmark lookup.
    if (reachedEnd) {
      const tail = await items(client, thread.id, { direction: "desc", limit: 1 });
      if (sameRow(tail.data[0], { id: lastConsumed.row.item.id, turn_id: lastConsumed.row.turnId })) position = tail.backwardsCursor;
    }
    position ??= await bookmark(client, thread.id, lastConsumed.query, lastConsumed.page, lastConsumed.index);
    if (!position) throw invalidCursor();
    cursor.head = anchor(lastConsumed.row, position);
  }
  if (reachedEnd) while (cursor.turns.length < turns.length) {
    const t = turns[cursor.turns.length]; if (!emit(turnEvent(t), "added")) break; cursor.turns.push(t);
  }
  cursor.groups = cursor.groups.map(g => ({ ...g, items: g.items.filter(i => i.mode === "running" || i.id === cursor.last_public) })).filter(g => g.items.length);
  return finish(state, cursor, events, commands, old, pending, 0);
}

export async function verifyPagedFreshness(client, threadId, encoded) {
  const old = decodeCursor(encoded, threadId);
  if (old.v !== 2 || old.pending) throw Object.assign(new Error("Read all pending changes before sending from this observation."), { code: "STALE_OBSERVATION" });
  const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
  if (thread?.id !== threadId) throw invalidCursor();
  const turns = await turnMetadata(client, threadId); validateTurns(old, turns);
  if (stateOf(thread, turns).active_turn_id !== old.active_turn_id) throw Object.assign(new Error("The active turn changed. Read the task again before sending."), { code: "STALE_OBSERVATION" });
  let position = old.head.cursor, first = true;
  do {
    const page = await items(client, threadId, { cursor: position });
    if (first && old.head.id && !sameRow(page.data[0], old.head)) throw invalidCursor();
    for (let i = 0; i < page.data.length; i++) {
      const row = page.data[i];
      if (row.item.type === "userMessage" && (!(first && old.head.id && i === 0) || itemHash(row) !== old.head.hash)) throw Object.assign(new Error("New user input was observed. Read the task again before sending."), { code: "STALE_OBSERVATION" });
    }
    first = false; position = page.nextCursor;
  } while (position);
}
