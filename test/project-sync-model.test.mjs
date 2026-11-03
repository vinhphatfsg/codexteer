import test from "node:test";
import assert from "node:assert/strict";

// Exhaustively explore two syncs' read/commit interleavings, a direct membership
// CAS writer, and interruption at each publication stage. Store primitives stay
// unchanged: project-publication -> membership, never the reverse; no network
// operation or supervisor lock is allowed in the commit section.
test("bounded sync publication model preserves cursor generations, attention and lock order", t => {
  const initial = { head: { token: 0, pending: false, attention: false }, rev: 0, evidence: false,
    project: null, index: null, external: false, tasks: [0, 1].map(() => ({ pc: 0, expected: null, rev: null, failed: false })) };
  const seen = new Set(); let terminals = 0, interrupted = 0;
  function visit(s) {
    const key = JSON.stringify(s); if (seen.has(key)) return; seen.add(key);
    assert.ok(!s.index || s.index === "external" || s.project === s.index, "membership owner acquired project first");
    assert.ok(!s.head.attention || s.evidence, "published evidence is durable");
    if (s.head.pending) assert.equal(s.head.attention, true, "interruption retains observed question before CAS");
    if (s.tasks.every(t => t.pc === 8)) terminals++;
    // A crash releases locks; the durable head must already retain attention
    // whenever a successful sync CAS could have advanced past that question.
    if (s.project !== null && s.tasks[s.project - 1]?.pc >= 5) {
      interrupted++; assert.equal(s.head.attention, true);
    }
    if (!s.external && s.index === null) {
      const n = structuredClone(s); n.external = true; n.rev++; visit(n);
    }
    for (let i = 0; i < 2; i++) {
      if (s.tasks[i].pc === 8) continue;
      const n = structuredClone(s), t = n.tasks[i], owner = i + 1;
      switch (t.pc) {
        case 0: t.expected = structuredClone(n.head); t.rev = n.rev; t.pc++; break;
        case 1: // network observation finishes outside every lock
          assert.notEqual(n.project, owner); assert.notEqual(n.index, owner); t.pc++; break;
        case 2:
          if (n.project !== null) { t.failed = true; t.pc = 8; }
          else { n.project = owner; t.pc++; } break;
        case 3:
          if (JSON.stringify(n.head) !== JSON.stringify(t.expected)) { t.failed = true; t.pc = 7; }
          else { n.evidence = true; t.pc++; } break;
        case 4: n.head = { token: owner, pending: true, attention: true }; t.pc++; break;
        case 5:
          assert.equal(n.index, null); n.index = owner;
          if (n.rev === t.rev) n.rev++; else t.failed = true;
          n.index = null; t.pc++; break;
        case 6: n.head = { token: owner, pending: false, attention: true }; t.pc++; break;
        case 7: n.project = null; t.pc = 8; break;
      }
      assert.ok(n.rev >= s.rev, "CAS cannot decrement its generation");
      if (t.failed && s.tasks[i].pc === 3) assert.deepEqual(n.head, s.head, "stale head never replaces published attention");
      visit(n);
    }
  }
  visit(initial);
  t.diagnostic(`states=${seen.size}, terminal_states=${terminals}, interrupted_states=${interrupted}`);
  assert.ok(seen.size > 100); assert.ok(terminals > 0); assert.ok(interrupted > 0);
});
