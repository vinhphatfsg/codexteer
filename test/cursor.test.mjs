import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeCursor, parseCursor, resolveTurns } from "../src/cursor.mjs";
import { withTarget, targetHost, remoteTransport } from "../src/target.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011", OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-000000000012", HOST = "remote-1";
const stale = { code: "STALE_CURSOR" };
const at = (threadId, rolloutOrdinal, includeAnchor) => JSON.stringify({ requestedThreadId: threadId, rolloutOrdinal, includeAnchor, scope: { kind: "itemsByCreatedAtOrdinal" } });
const turn = n => `11111111-1111-4111-8111-00000000000${n}`, HEAD_ID = "msg_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182";
const HEAD_HASH = "5b1f0c3e9a7d2e4f6a8b0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f7";
const FIXTURE = {
  v: 2, thread_id: ID, turns: [{ id: turn(1), status: "completed" }, { id: turn(2), status: "interrupted" }, { id: turn(3), status: "inProgress" }],
  head: { cursor: at(ID, 412, true), id: HEAD_ID, turn_id: turn(3), hash: HEAD_HASH },
  groups: [{ cursor: at(ID, 398, false), turn_id: turn(3), count: 14, items: [
    { index: 3, id: "exec-22222222-2222-4222-8222-00000000000a", turn_id: turn(3), hash: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d", mode: "running" },
    { index: 13, id: HEAD_ID, turn_id: turn(3), hash: HEAD_HASH, mode: "tail" }] }],
  last_public: HEAD_ID, state: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", active_turn_id: turn(3), pending: false,
};
// The first compact encoder wrote this for FIXTURE. Later CLIs must keep reading it.
const FIXTURE_TOKEN = "c1Fvf0WQ6qvN0CHgOxJGtgsL7GritD6Um471xZDeK4KIimLKV-PCFD80h3ngECAAARERERERFBEYERAAAAAAADDx4tPEtaaXiHlqW0w9Lh8A8eLTxLWml4h5altMPS4fACAghtc2dfGQobLD1OX2BxgpOktcbX6PkKGyw9Tl9gcYIBCmV4ZWMtIiIiIiIiQiKCIgAAAAAACgGcAwAEWx8MPpp9Lk9qiwwdLj9AUWJzhJWmt8jZ4PGis8TV5vcAAQKOAwQOAgwBBJ6NfGtaTz4tHAuaj35tXEs6Lx4NnIt6b15NPCsaD56NNwAE";

// The decoder that 0.19.0 and earlier CLIs shipped, frozen. Saved launchers keep running it.
function frozenDecodeCursor(value, threadId) {
  const invalidCursor = () => Object.assign(new Error("Cursor is invalid or history changed. Read again without --since."), { code: "STALE_CURSOR" });
  try {
    if (typeof value !== "string" || value.length > 1024 * 1024) throw invalidCursor();
    const c = JSON.parse(Buffer.from(value, "base64url").toString());
    if ((c.host_id ?? "local") !== targetHost()) throw invalidCursor();
    if (targetHost() !== "local" && (c.remote_transport ?? "native") !== remoteTransport()) throw invalidCursor();
    if (c?.v === 2) {
      const hash = x => x === null || (typeof x === "string" && /^[a-f0-9]{64}$/.test(x));
      const pos = x => x === null || (typeof x === "string" && x.length < 16384);
      if (c.thread_id !== threadId || typeof c.state !== "string" || !Array.isArray(c.turns) || !Array.isArray(c.groups)
        || !c.turns.every(t => typeof t.id === "string" && typeof t.status === "string")
        || new Set(c.turns.map(t => t.id)).size !== c.turns.length
        || !c.head || !pos(c.head.cursor) || !hash(c.head.hash) || !(c.head.id === null || typeof c.head.id === "string")
        || !(c.head.turn_id === null || typeof c.head.turn_id === "string") || (c.head.id !== null && c.head.cursor === null)
        || !(c.last_public === null || typeof c.last_public === "string")
        || !(c.active_turn_id === null || typeof c.active_turn_id === "string") || typeof c.pending !== "boolean"
        || !c.groups.every(g => pos(g.cursor) && (g.turn_id === null || typeof g.turn_id === "string") && Number.isInteger(g.count) && g.count > 0 && g.count <= 100
          && Array.isArray(g.items) && g.items.every(i => Number.isInteger(i.index) && i.index >= 0 && i.index < g.count && typeof i.id === "string" && typeof i.turn_id === "string" && hash(i.hash) && ["running", "tail"].includes(i.mode)))) throw invalidCursor();
      return c;
    }
    if (c.v !== 1 || c.thread_id !== threadId || !Number.isSafeInteger(c.count) || c.count < 0 || !Array.isArray(c.open)
      || !c.open.every(x => Number.isSafeInteger(x.index) && x.index >= 0 && x.index < c.count && typeof x.hash === "string")
      || new Set(c.open.map(x => x.index)).size !== c.open.length || typeof c.prefix !== "string"
      || !(c.latest_turn_id === undefined || c.latest_turn_id === null || (typeof c.latest_turn_id === "string" && c.latest_turn_id))) throw invalidCursor();
    return c;
  } catch { throw invalidCursor(); }
}

function generator(seed) {
  const random = () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const int = n => Math.floor(random() * n), pick = list => list[int(list.length)];
  const hex = bytes => Array.from({ length: bytes }, () => int(256).toString(16).padStart(2, "0")).join("");
  const uuid = () => `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
  const alnum = n => Array.from({ length: n }, () => pick("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")).join("");
  const text = () => pick(["", "x", "t0", "é漢字🙂", "a\u0000b", "\ud800", "lone\udfff", `MSG_${hex(4)}`, `exec-${uuid().toUpperCase()}`, ` ${uuid()}`, `${uuid()}-`, `call_${hex(3)}f`]);
  const id = () => pick([uuid, () => `exec-${uuid()}`, () => `msg_${hex(25)}`, () => `call_${hex(16)}`, () => `call_${alnum(24)}`, () => hex(1 + int(3)), text])();
  // Server-shaped positions, and near misses that must be kept as the exact text.
  const position = threadId => pick([
    () => null, () => at(threadId, int(1e6), random() < 0.5), () => at(threadId, Number.MAX_SAFE_INTEGER, true), () => at(OTHER, int(100), true),
    () => at(threadId, int(100), true).replace(":", ": "), () => at(threadId, -1, false), () => at(threadId, 1.5, false), () => at(threadId, "7", true),
    () => JSON.stringify({ rolloutOrdinal: int(100), requestedThreadId: threadId, includeAnchor: true, scope: { kind: "itemsByCreatedAtOrdinal" } }),
    () => JSON.stringify({ scope: "thread/items/list:all", id: "t/a", include: true }), () => "null", () => "7", text,
  ])();
  function paged(threadId) {
    const turns = [], seen = new Set();
    for (let n = int(12); n > 0; n--) {
      const turnId = pick([uuid, () => `t${int(40)}`, text])();
      if (!seen.has(turnId)) { seen.add(turnId); turns.push({ id: turnId, status: pick(["completed", "failed", "interrupted", "inProgress", "running", "pending", text()]) }); }
    }
    const turnId = () => turns.length && random() < 0.8 ? pick(turns).id : id();
    const head = pick([
      () => ({ cursor: null, id: null, turn_id: null, hash: null }),
      () => ({ cursor: position(threadId) ?? at(threadId, 0, true), id: id(), turn_id: turnId(), hash: random() < 0.8 ? hex(32) : null }),
      () => ({ cursor: position(threadId), id: null, turn_id: random() < 0.5 ? null : turnId(), hash: random() < 0.5 ? null : hex(32) }),
    ])();
    const groups = Array.from({ length: int(4) }, () => {
      const count = 1 + int(100);
      return { cursor: position(threadId), turn_id: random() < 0.5 ? null : turnId(), count, items: Array.from({ length: int(4) }, () => ({
        index: int(count), id: head.id !== null && random() < 0.3 ? head.id : id(), turn_id: turnId(),
        hash: head.hash !== null && random() < 0.4 ? head.hash : hex(32), mode: pick(["running", "tail"]) })) };
    });
    return { v: 2, thread_id: threadId, turns, head, groups, last_public: pick([null, head.id, id()]), state: hex(32), active_turn_id: pick([null, turnId(), id()]), pending: random() < 0.5 };
  }
  function snapshot() {
    const count = int(60), open = [];
    for (let index = 0; index < count; index++) if (random() < 0.3) open.push({ index, hash: hex(32) });
    return { v: 1, count, open, prefix: hex(32), state: hex(32), active_turn_id: pick([null, id()]), latest_turn_id: pick([null, id()]), user_revision: hex(32) };
  }
  return { paged, snapshot, threadId: () => pick([ID, uuid(), "other"]), extraTurn: () => ({ id: `added-${uuid()}`, status: pick(["inProgress", "completed"]) }) };
}

const legacyToken = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const forge = body => "c1" + Buffer.concat([createHash("sha256").update(JSON.stringify(["codexteer-cursor", ID, {}])).update(body).digest().subarray(0, 8), body]).toString("base64url");
const uint = n => { const out = []; for (; n >= 128; n = Math.floor(n / 128)) out.push(n % 128 | 128); out.push(n); return out; };

test("random cursors round-trip losslessly through both formats, on local and remote targets", async () => {
  const g = generator(20261101);
  for (const target of [null, { host: HOST, transport: "native" }, { host: HOST, transport: "paired" }]) {
    const run = operation => target ? withTarget(target.host, undefined, operation, { transport: target.transport }) : operation();
    await run(async () => {
      for (let n = 0; n < 400; n++) {
        const threadId = g.threadId(), cursor = g.paged(threadId), live = [...cursor.turns, ...(n % 3 ? [] : [g.extraTurn()])];
        const token = encodeCursor(cursor, threadId);
        assert.match(token, /^c1[A-Za-z0-9_-]+$/);
        assert.deepEqual(resolveTurns(parseCursor(token, threadId), live, threadId), cursor);
        assert.throws(() => frozenDecodeCursor(token, threadId), stale, "an older CLI must refuse a compact cursor");
        if (!target) assert.deepEqual(resolveTurns(parseCursor(legacyToken(cursor), threadId), live, threadId), cursor);
        const snapshot = g.snapshot(), compact = encodeCursor(snapshot, threadId);
        assert.deepEqual(parseCursor(compact, threadId), snapshot);
        assert.throws(() => frozenDecodeCursor(compact, threadId), stale);
      }
    });
  }
});

test("a saved compact cursor still resolves to the same observation, and the encoder stays as small", () => {
  assert.deepEqual(resolveTurns(parseCursor(FIXTURE_TOKEN, ID), FIXTURE.turns, ID), FIXTURE);
  assert.ok(encodeCursor(FIXTURE, ID).length <= FIXTURE_TOKEN.length);
  assert.ok(FIXTURE_TOKEN.length < legacyToken(FIXTURE).length / 6);
});

test("every single-character substitution or deletion of a cursor is refused", () => {
  // This one spells "-" and "_" and ends in a character with unused bits, where a lenient decoder reads the same bytes.
  const pending = encodeCursor({ v: 2, thread_id: ID, turns: [{ id: turn(1), status: "completed" }], head: { cursor: at(ID, 300, true), id: turn(1), turn_id: turn(1), hash: null },
    groups: [], last_public: null, state: "d19ffb904395eada15ce069ce68c9ae4098a131c064b3b9b78e685d9bbe6187b", active_turn_id: null, pending: true }, ID);
  assert.ok(pending.includes("-") && pending.includes("_") && Buffer.from(pending.slice(2), "base64url").length % 3 === 1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=. ";
  let tried = 0;
  for (const token of [FIXTURE_TOKEN, pending]) {
    assert.ok(parseCursor(token, ID));
    for (let i = 0; i < token.length; i++) {
      const before = token.slice(0, i), after = token.slice(i + 1);
      for (const ch of alphabet) {
        if (ch === token[i]) continue;
        assert.throws(() => parseCursor(before + ch + after, ID), stale, `substitution ${i} ${ch}`); tried++;
      }
      assert.throws(() => parseCursor(before + after, ID), stale, `deletion ${i}`); tried++;
    }
    for (const suffix of ["=", "==", " ", "\n"]) assert.throws(() => parseCursor(token + suffix, ID), stale);
  }
  assert.ok(tried > 20000);
});

test("a cursor is bound to its task, host and transport", async () => {
  assert.throws(() => parseCursor(FIXTURE_TOKEN, OTHER), stale);
  await withTarget(HOST, undefined, () => assert.throws(() => parseCursor(FIXTURE_TOKEN, ID), stale));
  const remote = await withTarget(HOST, undefined, () => encodeCursor(FIXTURE, ID), { transport: "control" });
  assert.throws(() => parseCursor(remote, ID), stale);
  await withTarget(HOST, undefined, () => assert.equal(parseCursor(remote, ID).v, 2), { transport: "control" });
  for (const [host, transport] of [[HOST, "native"], [HOST, "paired"], ["remote-2", "control"]]) {
    await withTarget(host, undefined, () => assert.throws(() => parseCursor(remote, ID), stale), { transport });
  }
});

test("the live turn list must extend the observed one without rewriting final turns", () => {
  const claim = () => parseCursor(FIXTURE_TOKEN, ID), [a, b, c] = FIXTURE.turns;
  for (const live of [[a, b], [], [{ ...a, id: turn(9) }, b, c], [b, a, c], [a, { ...b, status: "completed" }, c], [{ ...a, status: "inProgress" }, b, c], [c, a, b]]) {
    assert.throws(() => resolveTurns(claim(), live, ID), stale, JSON.stringify(live));
  }
  const finished = resolveTurns(claim(), [a, b, { ...c, status: "completed" }], ID);
  assert.deepEqual(finished.turns, FIXTURE.turns, "a finished running turn keeps its observed status so the read reports it");
  const extended = resolveTurns(claim(), [a, b, c, { id: turn(4), status: "inProgress" }], ID);
  assert.deepEqual(extended.turns, FIXTURE.turns, "later turns are left for the read to add");
});

test("the fast cursor keeps its size limit and full-history cursors keep none", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ index, id: `exec-${index}`, turn_id: "t", hash: createHash("sha256").update(String(index)).digest("hex"), mode: "running" }));
  const groups = Array.from({ length: 250 }, (_, g) => ({ cursor: null, turn_id: "t", count: 100, items: items.map(i => ({ ...i, id: `${i.id}-${g}` })) }));
  assert.throws(() => encodeCursor({ ...FIXTURE, groups }, ID), { code: "CURSOR_TOO_LARGE" });
  const hash = createHash("sha256").update("x").digest("hex");
  const open = Array.from({ length: 30000 }, (_, index) => ({ index, hash }));
  const token = encodeCursor({ v: 1, count: 30000, open, prefix: hash, state: hash, active_turn_id: null, latest_turn_id: null, user_revision: hash }, ID);
  assert.ok(token.length > 1024 * 1024);
  assert.throws(() => parseCursor(token, ID), stale);
});

test("hostile cursor bodies fail as STALE_CURSOR without large allocations", () => {
  const hash = Array(32).fill(7), id = [0, ...Array(16).fill(1)], v2 = (...rest) => [2, 0, 0, 0, ...hash, ...rest];
  const group = (count, packed, ...item) => v2(1, ...id, 0, 0, 1, 0, 0, ...uint(count), 1, ...uint(packed), 0, ...item);
  const head = chars => v2(0, 3, ...uint(2 * chars), ...Buffer.from("x".repeat(chars)), 0, 0);
  const v1 = (open, flags = 0) => [1, flags, 1, ...open, ...hash, ...hash, ...hash];
  const accepted = [v2(0, 0, 0, 0), group(1, 0, 1, ...id, ...hash), group(100, 99 * 4, 1, ...id, ...hash), head(16383), v1([1, 0, ...hash]), [2, 0, 1, ...hash, 1, 0, 2, ...hash, 0, 0, 0, 0]];
  for (const body of accepted) assert.ok(parseCursor(forge(Buffer.from(body)), ID), JSON.stringify(body.slice(0, 60)));
  for (const body of [
    [], [3], [2, 32, 0, 0, ...hash, 0, 0, 0, 0], [...v2(0, 0, 0, 0), 0], v2(0, 0, 0, 0).slice(0, -1),
    v2(...uint(2 ** 50)), [2, 0, 0, ...uint(2 ** 50)], [2, 0, 1, ...hash, ...uint(2 ** 50)], v2(1, 3, ...uint(2 ** 50)), v2(0, 0, 0, ...uint(2 ** 50)),
    group(0, 0, 1, ...id, ...hash), group(101, 0, 1, ...id, ...hash), group(1, 4, 1, ...id, ...hash), group(1, 1, 1, ...id), group(1, 0, 0, ...hash),
    v2(0, 0, 2, 0), v2(0, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0), head(16384),
    v1([1, 1, ...hash]), v1([1, 0, ...hash], 4), [2, 0, 1, ...hash, 1, 1, 0, ...hash, 0, 0, 0, 0], [2, 0, 1, ...hash, 1, 0, 3, ...hash, 0, 0, 0, 0],
  ]) assert.throws(() => parseCursor(forge(Buffer.from(body)), ID), stale, JSON.stringify(body.slice(0, 60)));
  assert.throws(() => parseCursor("c1" + "A".repeat(1024 * 1024), ID), stale);
  for (const value of [undefined, null, 7, "", "c1", "not a cursor", "eyJ2IjoyfQ"]) assert.throws(() => parseCursor(value, ID), stale);
});
