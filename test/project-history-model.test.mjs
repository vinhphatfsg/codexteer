import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Bounded model of start publication, sync publication and explicit pruning.
// Each operation may stop at any durable boundary. The history mutex sits below
// the pre-existing work/project lock and above membership; prune has no outer lock.
test("history publication/pruning model preserves pins, capacity and acyclic lock order under interruption", t => {
  const initial = { history: null, project: false, records: { initial: 4, question: 3, old: 3 }, head: "old", pending: false,
    cursor: false, presented: false, newInitial: false, pcs: [0, 0, 0] };
  const seen = new Set(); let finished = 0, interruptions = 0, rejected = 0;
  const capacity = 16;
  const pinned = s => new Set([s.head, "question", ...(!s.presented || s.head === "sync" ? ["initial"] : []), ...(s.newInitial ? ["newInitial"] : [])]);
  const size = s => Object.values(s.records).reduce((a,b) => a+b, 0);
  function visit(s) {
    const key = JSON.stringify(s); if (seen.has(key)) return; seen.add(key);
    assert.ok(size(s) <= capacity, "quota never exceeded");
    for (const pin of pinned(s)) assert.ok(Object.hasOwn(s.records, pin), `durable protected record: ${pin}`);
    if (s.cursor) assert.ok(s.pending || s.presented, "cursor cannot advance before durable presentation evidence");
    if (s.history === 1) assert.equal(s.project, true, "sync acquired project before history");
    if (s.pcs.every(pc => pc === 9)) finished++;
    for (let actor = 0; actor < 3; actor++) {
      if (s.pcs[actor] === 9) continue;
      const n = structuredClone(s), pc = n.pcs[actor];
      if (pc === 0) { // network outside locks / outer lock acquisition
        if (actor === 1) { if (n.project) continue; n.project = true; }
        n.pcs[actor] = 1;
      } else if (pc === 1) {
        if (n.history !== null) continue;
        n.history = actor; n.pcs[actor] = 2;
      } else if (actor === 0 && pc === 2) {
        if (size(n)+4 <= capacity) { n.records.newInitial = 4; n.newInitial = true; } else rejected++;
        n.pcs[actor] = 8;
      } else if (actor === 1) {
        if (pc === 2) {
          if (size(n)+5 > capacity) { n.pcs[actor] = 8; rejected++; }
          else { n.records.sync = 5; n.pcs[actor] = 3; }
        } else if (pc === 3) { n.head = "sync"; n.pending = true; n.pcs[actor] = 4; }
        else if (pc === 4) { n.cursor = true; n.pcs[actor] = 5; }
        else if (pc === 5) { n.presented = true; n.pending = false; n.pcs[actor] = 8; }
        else if (pc === 8) { n.history = null; n.project = false; n.pcs[actor] = 9; }
      } else if (actor === 2 && pc === 2) {
        const keep = pinned(n); for (const record of Object.keys(n.records)) if (!keep.has(record)) delete n.records[record];
        n.pcs[actor] = 8;
      } else if (pc === 8) { n.history = null; n.pcs[actor] = 9; }
      visit(n);
      if (s.history === actor && pc >= 2 && pc < 8) {
        const crash = structuredClone(s); crash.history = null; if (actor === 1) crash.project = false; crash.pcs[actor] = 9;
        interruptions++; visit(crash);
      }
    }
  }
  visit(initial); assert.ok(seen.size > 100); assert.ok(finished > 0); assert.ok(interruptions > 0); assert.ok(rejected > 0);
  t.diagnostic(`states=${seen.size}, terminal_states=${finished}, interruption_paths=${interruptions}, quota_rejections=${rejected}`);
});

test("publication and cleanup source use the modeled history boundary", async () => {
  const sync = await readFile("src/project-sync.mjs", "utf8"), start = await readFile("src/work-start.mjs", "utf8"), history = await readFile("src/project-history.mjs", "utf8");
  assert.match(sync, /withStoreLock\(`project-sync-[\s\S]*?withHistoryReservation/);
  assert.equal((sync.match(/await historyWrite\("project-sync-/g) ?? []).length, 5);
  assert.doesNotMatch(sync, /writeRecord\("project-sync-(?:events|results)"/);
  assert.doesNotMatch(start, /\bwriteRecord\("work-starts"/);
  assert.match(history, /pruneProjectHistory[\s\S]*?withStoreLock\("project-history"/);
  assert.doesNotMatch(history, /withStoreLock\(`(?:project-sync|project-index|work-start)-/);
});
