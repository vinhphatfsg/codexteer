import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// Bounded model of start publication, sync publication and pruning, explicit or
// by a writer that meets the quota. Each operation may stop at any durable
// boundary. The history mutex sits below the pre-existing work/project lock and
// above membership; prune has no outer lock.
test("history publication/pruning model preserves pins, capacity and acyclic lock order under interruption", t => {
  const initial = { history: null, project: false, records: { initial: 4, question: 3, old: 3 }, head: "old", pending: false,
    cursor: false, presented: false, newInitial: false, pcs: [0, 0, 0] };
  const seen = new Set(); let finished = 0, interruptions = 0, rejected = 0, freed = 0;
  const capacity = 16;
  const pinned = s => new Set([s.head, "question", ...(!s.presented || s.head === "sync" ? ["initial"] : []), ...(s.newInitial ? ["newInitial"] : [])]);
  const size = s => Object.values(s.records).reduce((a,b) => a+b, 0);
  const prune = s => { const keep = pinned(s); for (const record of Object.keys(s.records)) if (!keep.has(record)) delete s.records[record]; };
  // A writer that does not fit prunes once under the history mutex it already holds.
  const fits = (s, need) => {
    if (size(s)+need <= capacity) return true;
    prune(s); if (size(s)+need <= capacity) { freed++; return true; }
    rejected++; return false;
  };
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
        if (fits(n, 4)) { n.records.newInitial = 4; n.newInitial = true; }
        n.pcs[actor] = 8;
      } else if (actor === 1) {
        if (pc === 2) {
          if (fits(n, 5)) { n.records.sync = 5; n.pcs[actor] = 3; }
          else n.pcs[actor] = 8;
        } else if (pc === 3) { n.head = "sync"; n.pending = true; n.pcs[actor] = 4; }
        else if (pc === 4) { n.cursor = true; n.pcs[actor] = 5; }
        else if (pc === 5) { n.presented = true; n.pending = false; n.pcs[actor] = 8; }
        else if (pc === 8) { n.history = null; n.project = false; n.pcs[actor] = 9; }
      } else if (actor === 2 && pc === 2) {
        prune(n); n.pcs[actor] = 8;
      } else if (pc === 8) { n.history = null; n.pcs[actor] = 9; }
      visit(n);
      if (s.history === actor && pc >= 2 && pc < 8) {
        const crash = structuredClone(s); crash.history = null; if (actor === 1) crash.project = false; crash.pcs[actor] = 9;
        interruptions++; visit(crash);
      }
    }
  }
  visit(initial); assert.ok(seen.size > 100); assert.ok(finished > 0); assert.ok(interruptions > 0); assert.ok(rejected > 0); assert.ok(freed > 0);
  t.diagnostic(`states=${seen.size}, terminal_states=${finished}, interruption_paths=${interruptions}, quota_rejections=${rejected}, writers_freed_by_prune=${freed}`);
});

test("publication and cleanup source use the modeled history boundary", async () => {
  const sync = await readFile("src/project-sync.mjs", "utf8"), start = await readFile("src/work-start.mjs", "utf8"), history = await readFile("src/project-history.mjs", "utf8");
  assert.match(sync, /withStoreLock\(`project-sync-[\s\S]*?withHistoryReservation/);
  assert.equal((sync.match(/await historyWrite\(\.\.\./g) ?? []).length, 4);
  assert.equal((sync.match(/withHistoryReservation\(\{ projectId, records/g) ?? []).length, 2);
  assert.match(history, /async function room\([\s\S]*?await prune\(projectId, storage, before, publishing\)[\s\S]*?\n}\n/);
  assert.doesNotMatch(history.slice(history.indexOf("const write = ")), /await prune\([\s\S]*?return action/);
  assert.doesNotMatch(sync, /writeRecord\("project-sync-(?:events|results)"/);
  assert.doesNotMatch(start, /\bwriteRecord\("work-starts"/);
  assert.match(history, /const lock = [^\n]*\n[^\n]*\n\s*return withStoreLock\(`project-history-\$\{key\(projectId\)\}`/);
  for (const name of ["withHistoryReservation", "writeHistoryRecord", "pruneProjectHistory"]) assert.match(history, new RegExp(`function ${name}\\([\\s\\S]*?return lock\\(`));
  assert.doesNotMatch(history, /withStoreLock\(`(?:project-sync|project-index|work-start)-/);
  // Every lock history takes is its own project's, or one tried without waiting.
  assert.equal((history.match(/withStoreLock\(/g) ?? []).length, 2);
  assert.match(history, /async function attempt\([\s\S]*?withStoreLock\(name[\s\S]*?error\.code !== "RECORD_BUSY"\) throw error; return null;/);
  assert.match(history, /async function prune\([\s\S]*?attempt\("project-history"[\s\S]*?publishing \? rows\(\) : \(await attempt\(`project-sync-\$\{key\(projectId\)\}`/);
  // The only waits: both publication paths, each outside every lock it then takes.
  assert.equal((sync.match(/await untilFree\(projectId, deadline, entered => with(?:StoreLock|HistoryReservation)\(/g) ?? []).length, 2);
  assert.equal((history.match(/untilFree\(/g) ?? []).length, 2, "defined once, and called by no history path");
  assert.match(history, /export async function untilFree\([\s\S]*?catch \(error\) \{ if \(last \|\| entered \|\| error\.code !== "RECORD_BUSY"\) throw error; \}/);
  assert.equal((sync.match(/publishing: true/g) ?? []).length, 1, "only the publication's main path holds the project's publication lock");
  assert.match(sync, /withStoreLock\(`project-sync-[^`]*`, async \(\) => withHistoryReservation\(\{ projectId, records, publishing: true \}/);
});

test("the history limit and the lock wait are set only through the storage argument, which no command builds from user input", async () => {
  const sources = await Promise.all(["src", "bin", "scripts"].map(async dir => (await readdir(dir, { recursive: true })).filter(name => /\.m?js$/.test(name)).map(name => `${dir}/${name}`)));
  const naming = [];
  for (const file of sources.flat()) if ((await readFile(file, "utf8")).includes("historyLimitBytes")) naming.push(file);
  assert.deepEqual(naming, ["src/project-history.mjs"]);
  const waiting = [];
  for (const file of sources.flat()) if ((await readFile(file, "utf8")).includes("historyLockWaitMs")) waiting.push(file);
  assert.deepEqual(waiting, ["src/project-history.mjs"]);
  // The commands call history, sync, wait and work start with the default storage.
  for (const file of ["src/cli.mjs", "src/cloud-cli.mjs"]) assert.doesNotMatch((await readFile(file, "utf8")).replace(/storage_bytes/g, ""), /storage/);
});
