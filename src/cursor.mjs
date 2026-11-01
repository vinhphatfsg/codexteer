// The read cursor format. No other module builds or reads cursor bytes.
//
// token = "c1" base64url(check[8] body). The check is SHA-256 over the target
// binding and the body. It is not a MAC: it binds the token to the thread, host
// and transport without storing them, and rejects copy errors. Sends stay safe
// because every --based-on and --since is re-validated against the live server.
//
// A v2 body commits to the turn list instead of listing it, so the token does
// not grow with the thread. parseCursor needs no server and returns a claim.
// resolveTurns checks the claim against the live turn list and rebuilds the
// in-memory cursor that readPaged and verifyPagedFreshness use.
import { createHash } from "node:crypto";
import { hostFields, targetHost, remoteTransport } from "./target.mjs";

const PREFIX = "c1", MAX_TOKEN = 1024 * 1024, MAX_POSITION = 16384;
const RUNNING = ["inProgress", "running", "pending"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;

/** @typedef {{ kind: "none" } | { kind: "turn", index: number } | { kind: "inline", id: string }} TurnRef */
/**
 * What a v2 token proves about the turn list without listing it. `running` holds
 * the status each running turn had when the token was made.
 * @typedef {{ count: number, commitment: string | null, running: Map<number, string> }} TurnCommitment
 */
/**
 * Offline view of a v2 cursor. It has no `turns`, so code that skips resolveTurns
 * fails on first use instead of running a weaker check.
 * @typedef {{ v: 2, turn_commitment: TurnCommitment, active_turn_id: string | null, state: string, pending: boolean,
 *   head: { cursor: string | null, id: string | null, turn: TurnRef, hash: string | null }, last_public: string | null,
 *   groups: { cursor: string | null, turn: TurnRef, count: number,
 *     items: { index: number, id: string, turn: TurnRef, hash: string, mode: "running" | "tail" }[] }[] }} PagedClaim
 */
/**
 * @typedef {{ v: 1, count: number, open: { index: number, hash: string }[], prefix: string, state: string,
 *   active_turn_id: string | null, latest_turn_id?: string | null, user_revision?: string }} SnapshotCursor
 */
/**
 * @typedef {{ v: 2, thread_id: string, turns: { id: string, status: string }[],
 *   head: { cursor: string | null, id: string | null, turn_id: string | null, hash: string | null },
 *   groups: { cursor: string | null, turn_id: string | null, count: number,
 *     items: { index: number, id: string, turn_id: string, hash: string, mode: "running" | "tail" }[] }[],
 *   last_public: string | null, state: string, active_turn_id: string | null, pending: boolean }} PagedCursor
 */

export function invalidCursor() { return Object.assign(new Error("Cursor is invalid or history changed. Read again without --since."), { code: "STALE_CURSOR" }); }

/**
 * @param {PagedCursor | SnapshotCursor} cursor
 * @param {string} threadId
 */
export function encodeCursor(cursor, threadId) {
  const w = new Writer();
  if (cursor.v === 1) writeSnapshotBody(w, cursor); else writePagedBody(w, claimOf(cursor), threadId);
  const body = w.done(), token = PREFIX + Buffer.concat([check(threadId, body), body]).toString("base64url");
  // v1 is the --full-history fallback and has always been uncapped, so only the fast cursor is refused here.
  if (cursor.v === 2 && token.length > MAX_TOKEN) throw Object.assign(new Error("Too many in-progress items for a fast cursor. Use --full-history."), { code: "CURSOR_TOO_LARGE" });
  return token;
}

/**
 * Parse without the server. Accepts "c1" tokens and the earlier base64url JSON tokens.
 * @param {unknown} token
 * @param {string} threadId
 * @returns {PagedClaim | SnapshotCursor}
 */
export function parseCursor(token, threadId) {
  try {
    if (typeof token !== "string" || token.length > MAX_TOKEN) throw invalidCursor();
    if (!token.startsWith(PREFIX)) return parseLegacy(token, threadId);
    const text = token.slice(PREFIX.length), bytes = Buffer.from(text, "base64url");
    // Node decodes base64url leniently, so only the canonical spelling of the bytes is accepted.
    if (bytes.length < 9 || bytes.toString("base64url") !== text) throw invalidCursor();
    const body = bytes.subarray(8);
    if (!check(threadId, body).equals(bytes.subarray(0, 8))) throw invalidCursor();
    const r = new Reader(body), version = r.byte();
    if (version !== 1 && version !== 2) throw invalidCursor();
    const claim = version === 1 ? readSnapshotBody(r) : readPagedBody(r, threadId);
    r.end();
    return claim;
  } catch { throw invalidCursor(); }
}

/**
 * Check a v2 claim against the live turn list and rebuild the cursor. Accepts a live
 * list exactly when it extends the committed one with the same ids in order and every
 * turn that was final keeps its status.
 * @param {PagedClaim} claim
 * @param {{ id: string, status: string }[]} liveTurns from turnMetadata, free of duplicates
 * @param {string} threadId
 * @returns {PagedCursor}
 */
export function resolveTurns(claim, liveTurns, threadId) {
  const { count, commitment: expected, running } = claim.turn_commitment;
  if (liveTurns.length < count) throw invalidCursor();
  const prefix = liveTurns.slice(0, count);
  if (count && commitment(prefix, running) !== expected) throw invalidCursor();
  // A running turn keeps its observed status, so the next read reports its change.
  const turns = prefix.map((t, i) => ({ id: t.id, status: running.get(i) ?? t.status }));
  const turnId = ref => ref.kind === "none" ? null : ref.kind === "inline" ? ref.id : turns[ref.index].id;
  return { v: 2, thread_id: threadId, turns,
    head: { cursor: claim.head.cursor, id: claim.head.id, turn_id: turnId(claim.head.turn), hash: claim.head.hash },
    groups: claim.groups.map(g => ({ cursor: g.cursor, turn_id: turnId(g.turn), count: g.count,
      items: g.items.map(i => ({ index: i.index, id: i.id, turn_id: turnId(i.turn), hash: i.hash, mode: i.mode })) })),
    last_public: claim.last_public, state: claim.state, active_turn_id: claim.active_turn_id, pending: claim.pending };
}

const check = (threadId, body) => createHash("sha256").update(JSON.stringify(["codexteer-cursor", threadId, hostFields()])).update(body).digest().subarray(0, 8);
const commitment = (turns, running) => createHash("sha256").update(JSON.stringify(turns.map((t, i) => [t.id, running.has(i) ? null : t.status]))).digest("hex");

/** @param {PagedCursor} cursor @returns {PagedClaim} */
function claimOf(cursor) {
  const index = new Map(cursor.turns.map((t, i) => [t.id, i]));
  const running = new Map(cursor.turns.flatMap((t, i) => RUNNING.includes(t.status) ? [[i, t.status]] : []));
  const turn = id => id === null ? { kind: "none" } : index.has(id) ? { kind: "turn", index: index.get(id) } : { kind: "inline", id };
  const count = cursor.turns.length;
  return { v: 2, turn_commitment: { count, commitment: count ? commitment(cursor.turns, running) : null, running },
    active_turn_id: cursor.active_turn_id, state: cursor.state, pending: cursor.pending,
    head: { cursor: cursor.head.cursor, id: cursor.head.id, turn: turn(cursor.head.turn_id), hash: cursor.head.hash },
    last_public: cursor.last_public,
    groups: cursor.groups.map(g => ({ cursor: g.cursor, turn: turn(g.turn_id), count: g.count,
      items: g.items.map(i => ({ index: i.index, id: i.id, turn: turn(i.turn_id), hash: i.hash, mode: i.mode })) })) };
}

// v2 body: 0x02 flags count commitment? running active? state ids head last_public? groups.
// Flags: 1 pending, 2 active turn, 4 head id, 8 head hash, 16 last public.
function writePagedBody(w, claim, threadId) {
  const { count, commitment, running } = claim.turn_commitment, { head } = claim;
  const ids = [...new Set([head.id, claim.last_public, ...claim.groups.flatMap(g => g.items.map(i => i.id))].filter(id => id !== null))];
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  w.byte(2);
  w.byte((claim.pending ? 1 : 0) | (claim.active_turn_id !== null ? 2 : 0) | (head.id !== null ? 4 : 0) | (head.hash !== null ? 8 : 0) | (claim.last_public !== null ? 16 : 0));
  w.uint(count);
  if (count) w.hash(commitment);
  w.uint(running.size);
  let previous = -1;
  for (const [index, status] of running) { w.uint(index - previous - 1); w.byte(RUNNING.indexOf(status)); previous = index; }
  if (claim.active_turn_id !== null) writeId(w, claim.active_turn_id);
  w.hash(claim.state);
  w.uint(ids.length);
  for (const id of ids) writeId(w, id);
  writePosition(w, head.cursor, threadId);
  if (head.id !== null) w.uint(idIndex.get(head.id));
  writeTurn(w, head.turn);
  if (head.hash !== null) w.hash(head.hash);
  if (claim.last_public !== null) w.uint(idIndex.get(claim.last_public));
  w.uint(claim.groups.length);
  for (const group of claim.groups) {
    writePosition(w, group.cursor, threadId); writeTurn(w, group.turn); w.uint(group.count); w.uint(group.items.length);
    for (const item of group.items) {
      // Most tracked items are the head itself, so their hash is one bit.
      const same = item.hash === head.hash;
      w.uint(item.index * 4 + (item.mode === "tail" ? 2 : 0) + (same ? 1 : 0)); w.uint(idIndex.get(item.id)); writeTurn(w, item.turn);
      if (!same) w.hash(item.hash);
    }
  }
}

function readPagedBody(r, threadId) {
  const flags = r.byte();
  if (flags > 31) throw invalidCursor();
  const count = r.uint(), commitment = count ? r.hash() : null, running = new Map();
  for (let n = r.count(), index = -1; n > 0; n--) {
    index += r.uint() + 1;
    const status = RUNNING[r.byte()];
    if (index >= count || !status) throw invalidCursor();
    running.set(index, status);
  }
  const active_turn_id = flags & 2 ? readId(r) : null, state = r.hash(), ids = [];
  for (let n = r.count(); n > 0; n--) ids.push(readId(r));
  const id = () => { const k = r.uint(); if (k >= ids.length) throw invalidCursor(); return ids[k]; };
  const head = { cursor: readPosition(r, threadId), id: flags & 4 ? id() : null, turn: readTurn(r, count), hash: flags & 8 ? r.hash() : null };
  if (head.id !== null && head.cursor === null) throw invalidCursor();
  const last_public = flags & 16 ? id() : null, groups = [];
  for (let n = r.count(); n > 0; n--) {
    const group = { cursor: readPosition(r, threadId), turn: readTurn(r, count), count: r.uint(), items: [] };
    if (group.count < 1 || group.count > 100) throw invalidCursor();
    for (let m = r.count(); m > 0; m--) {
      const packed = r.uint(), index = Math.floor(packed / 4), same = packed % 2 === 1;
      const item = { index, id: id(), turn: readTurn(r, count), hash: same ? head.hash : r.hash(), mode: packed % 4 >= 2 ? "tail" : "running" };
      if (index >= group.count || item.hash === null || item.turn.kind === "none") throw invalidCursor();
      group.items.push(item);
    }
    groups.push(group);
  }
  return { v: 2, turn_commitment: { count, commitment, running }, active_turn_id, state, pending: (flags & 1) === 1, head, last_public, groups };
}

// v1 body: 0x01 flags count open prefix state user_revision active? latest?
// Flags: 1 active turn, 2 latest turn. readSnapshot always sets every field.
function writeSnapshotBody(w, cursor) {
  w.byte(1);
  w.byte((cursor.active_turn_id !== null ? 1 : 0) | (cursor.latest_turn_id !== null ? 2 : 0));
  w.uint(cursor.count); w.uint(cursor.open.length);
  let previous = -1;
  for (const { index, hash } of cursor.open) { w.uint(index - previous - 1); w.hash(hash); previous = index; }
  w.hash(cursor.prefix); w.hash(cursor.state); w.hash(cursor.user_revision);
  if (cursor.active_turn_id !== null) writeId(w, cursor.active_turn_id);
  if (cursor.latest_turn_id !== null) writeId(w, cursor.latest_turn_id);
}

function readSnapshotBody(r) {
  const flags = r.byte();
  if (flags > 3) throw invalidCursor();
  const count = r.uint(), open = [];
  for (let n = r.count(), index = -1; n > 0; n--) {
    index += r.uint() + 1;
    if (index >= count) throw invalidCursor();
    open.push({ index, hash: r.hash() });
  }
  const prefix = r.hash(), state = r.hash(), user_revision = r.hash();
  const active_turn_id = flags & 1 ? readId(r) : null, latest_turn_id = flags & 2 ? readId(r) : null;
  return { v: 1, count, open, prefix, state, active_turn_id, latest_turn_id, user_revision };
}

// An id is a tag and a payload: 0 a UUID, 1 a short prefix and a UUID, 2 a prefix and lowercase hex, 3 text.
const ID_PARTS = /^([a-z]{1,16}[_-])?(.*)$/s;
const uuid = bytes => bytes.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");

function writeId(w, id) {
  if (UUID.test(id)) { w.byte(0); w.bytes(Buffer.from(id.replaceAll("-", ""), "hex")); return; }
  const [, prefix = "", body] = ID_PARTS.exec(id);
  if (prefix && UUID.test(body)) {
    w.byte(1); w.text(prefix); w.bytes(Buffer.from(body.replaceAll("-", ""), "hex"));
  } else if (/^(?:[0-9a-f]{2})+$/.test(body)) {
    w.byte(2); w.text(prefix); w.uint(body.length / 2); w.bytes(Buffer.from(body, "hex"));
  } else { w.byte(3); w.text(id); }
}

function readId(r) {
  const tag = r.byte();
  if (tag === 0) return uuid(r.bytes(16));
  if (tag === 1) return r.text() + uuid(r.bytes(16));
  if (tag === 2) return r.text() + r.bytes(r.uint()).toString("hex");
  if (tag === 3) return r.text();
  throw invalidCursor();
}

// App Server positions are kept byte for byte. The known form is stored as an
// ordinal only when rendering it back reproduces the server's exact string, so
// codexteer never synthesizes a position and a format change only costs size.
// Tags: 0 null, 1 known form with includeAnchor true, 2 with false, 3 the exact text.
const position = (threadId, rolloutOrdinal, includeAnchor) => JSON.stringify({ requestedThreadId: threadId, rolloutOrdinal, includeAnchor, scope: { kind: "itemsByCreatedAtOrdinal" } });

function writePosition(w, value, threadId) {
  if (value === null) return w.byte(0);
  let known = null;
  try { known = JSON.parse(value); } catch { /* Not JSON, so it is stored as text. */ }
  if (Number.isSafeInteger(known?.rolloutOrdinal) && known.rolloutOrdinal >= 0 && typeof known.includeAnchor === "boolean"
    && position(threadId, known.rolloutOrdinal, known.includeAnchor) === value) {
    w.byte(known.includeAnchor ? 1 : 2); w.uint(known.rolloutOrdinal);
  } else { w.byte(3); w.text(value); }
}

function readPosition(r, threadId) {
  const tag = r.byte();
  if (tag === 0) return null;
  if (tag === 1 || tag === 2) return position(threadId, r.uint(), tag === 1);
  if (tag !== 3) throw invalidCursor();
  const value = r.text();
  if (value.length >= MAX_POSITION) throw invalidCursor();
  return value;
}

// A turn reference: 0 none, 1 an inline id, k + 2 the committed turn k.
function writeTurn(w, ref) {
  if (ref.kind === "none") w.uint(0);
  else if (ref.kind === "inline") { w.uint(1); writeId(w, ref.id); }
  else w.uint(ref.index + 2);
}

function readTurn(r, count) {
  const n = r.uint();
  if (n === 0) return { kind: "none" };
  if (n === 1) return { kind: "inline", id: readId(r) };
  if (n - 2 >= count) throw invalidCursor();
  return { kind: "turn", index: n - 2 };
}

// The earlier format, base64url(JSON). These are the 0.19 decoder's checks, plus
// lowercase-hex v1 hashes, which every earlier encoder wrote and the v1 encoder needs.
function parseLegacy(token, threadId) {
  const c = JSON.parse(Buffer.from(token, "base64url").toString());
  if ((c.host_id ?? "local") !== targetHost()) throw invalidCursor();
  if (targetHost() !== "local" && (c.remote_transport ?? "native") !== remoteTransport()) throw invalidCursor();
  if (c?.v === 2) {
    const hash = x => x === null || (typeof x === "string" && HASH.test(x));
    const pos = x => x === null || (typeof x === "string" && x.length < MAX_POSITION);
    if (c.thread_id !== threadId || typeof c.state !== "string" || !Array.isArray(c.turns) || !Array.isArray(c.groups)
      || !c.turns.every(t => typeof t.id === "string" && typeof t.status === "string")
      || new Set(c.turns.map(t => t.id)).size !== c.turns.length
      || !c.head || !pos(c.head.cursor) || !hash(c.head.hash) || !(c.head.id === null || typeof c.head.id === "string")
      || !(c.head.turn_id === null || typeof c.head.turn_id === "string") || (c.head.id !== null && c.head.cursor === null)
      || !(c.last_public === null || typeof c.last_public === "string")
      || !(c.active_turn_id === null || typeof c.active_turn_id === "string") || typeof c.pending !== "boolean"
      || !c.groups.every(g => pos(g.cursor) && (g.turn_id === null || typeof g.turn_id === "string") && Number.isInteger(g.count) && g.count > 0 && g.count <= 100
        && Array.isArray(g.items) && g.items.every(i => Number.isInteger(i.index) && i.index >= 0 && i.index < g.count && typeof i.id === "string" && typeof i.turn_id === "string" && hash(i.hash) && ["running", "tail"].includes(i.mode)))) throw invalidCursor();
    return claimOf(c);
  }
  if (c.v !== 1 || c.thread_id !== threadId || !Number.isSafeInteger(c.count) || c.count < 0 || !Array.isArray(c.open)
    || !c.open.every(x => Number.isSafeInteger(x.index) && x.index >= 0 && x.index < c.count && typeof x.hash === "string" && HASH.test(x.hash))
    || new Set(c.open.map(x => x.index)).size !== c.open.length || typeof c.prefix !== "string"
    || !(c.latest_turn_id === undefined || c.latest_turn_id === null || (typeof c.latest_turn_id === "string" && c.latest_turn_id))) throw invalidCursor();
  return c;
}

class Writer {
  #parts = [];
  byte(value) { this.#parts.push(Buffer.of(value)); }
  // Every integer in a cursor is a count, an index or an ordinal. Anything else is a bug that must not be written.
  uint(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("A cursor integer must be a non-negative safe integer.");
    const out = [];
    for (; value >= 128; value = Math.floor(value / 128)) out.push(value % 128 | 128);
    out.push(value);
    this.#parts.push(Buffer.from(out));
  }
  bytes(value) { this.#parts.push(value); }
  hash(hex) {
    if (!HASH.test(hex)) throw new Error("A cursor hash must be 64 lowercase hex characters.");
    this.#parts.push(Buffer.from(hex, "hex"));
  }
  // UTF-8 cannot carry a lone surrogate, so such text is stored as its JSON spelling, marked by the low bit.
  text(value) {
    const json = !value.isWellFormed(), bytes = Buffer.from(json ? JSON.stringify(value) : value);
    this.uint(bytes.length * 2 + (json ? 1 : 0)); this.bytes(bytes);
  }
  done() { return Buffer.concat(this.#parts); }
}

// Every read is bounded by the buffer: a length or count larger than the bytes left fails before any allocation.
class Reader {
  #buffer; #at = 0;
  constructor(buffer) { this.#buffer = buffer; }
  get #left() { return this.#buffer.length - this.#at; }
  byte() { if (!this.#left) throw invalidCursor(); return this.#buffer[this.#at++]; }
  uint() {
    let value = 0;
    for (let k = 0, scale = 1; k < 8; k++, scale *= 128) {
      const x = this.byte();
      value += (x & 127) * scale;
      if (x < 128) { if (!Number.isSafeInteger(value)) throw invalidCursor(); return value; }
    }
    throw invalidCursor();
  }
  // Each counted element takes at least one byte.
  count() { const n = this.uint(); if (n > this.#left) throw invalidCursor(); return n; }
  bytes(n) { if (n > this.#left) throw invalidCursor(); return this.#buffer.subarray(this.#at, this.#at += n); }
  hash() { return this.bytes(32).toString("hex"); }
  text() {
    const n = this.uint(), raw = this.bytes(Math.floor(n / 2)).toString();
    if (n % 2 === 0) return raw;
    const value = JSON.parse(raw);
    if (typeof value !== "string") throw invalidCursor();
    return value;
  }
  end() { if (this.#left) throw invalidCursor(); }
}
