import test from "node:test";
import assert from "node:assert/strict";
import { classify, isReadOnlyCommand, NotificationBuffer, notificationOptions } from "../src/notify.mjs";

test("read-only syntax recognizes quoted shells and only all-safe command chains", () => {
  for (const command of [
    "rg -n foo src", "grep -n foo a | head -20", "sed -n '1,120p' src/a.mjs", "cat a; ls", "pwd && which node || command -v npm",
    "find src -name '*.mjs'", "head a | tail -2 | wc -l", "stat a; file a", "sleep 5", "echo 'foo;bar|baz'",
    "git status --short", "git log --oneline", "git diff --stat", "git show HEAD:src/a.mjs", "git rev-parse HEAD", "git branch --list 'codex/*'",
    '/bin/zsh -lc "rg foo src | head -2"', "/bin/bash -c 'git status --short && pwd'", "/usr/bin/rg foo src",
  ]) assert.equal(isReadOnlyCommand(command), true, command);
  for (const command of [
    "", "cat a > b", "echo x >> b", "cat a | tee b", "cat <<EOF", "echo $(pwd)", "echo `pwd`", "echo <(pwd)",
    "rg foo; npm test", "git status && git commit -m x", "find . -delete", "find . -exec rm {} +", "find . -execdir ls {} +",
    "find . -ok rm {} +", "find . -fprint output", "sed -n 'w output' input", "sed -n '1e touch output' input", "sed -ni '1p' input",
    "git branch --list -D topic", "git branch topic", "git diff --output=out", "git show --ext-diff", "git -c alias.x=delete x",
    "rg --pre='touch out' .", "rg --hostname-bin tool .", "file -C -m magic", "cat a & cat b", "cat a;", "cat a ||", "cat a;;cat b",
    "cat 'unclosed", "cat a\\", "env X=1 cat a", "command cat a", "cat a\nnpm test", "cat a\n[truncated]",
  ]) assert.equal(isReadOnlyCommand(command), false, command);
});

test("classification covers wake, normal, quiet and state-only changes without modifying input", () => {
  const rows = [
    ["wake", { type: "userMessage" }], ["wake", { type: "turn", change: "added" }], ["wake", { type: "turn", status: "completed", change: "updated" }],
    ["wake", { type: "agentMessage", phase: "final_answer" }], ["wake", { type: "agentMessage", questions: [] }], ["wake", { type: "plan" }],
    ["wake", { type: "commandExecution", command: "npm test", exit_code: 1 }], ["wake", { type: "commandExecution", command: "npm test", status: "failed" }],
    ["wake", { type: "fileChange", status: "failed" }], ["normal", { type: "fileChange", status: "completed" }],
    ["normal", { type: "commandExecution", command: "npm test", exit_code: 0 }], ["normal", { type: "agentMessage", phase: "commentary" }],
    ["normal", { type: "newPublicEvent" }], ["quiet", { type: "commandExecution", command: "rg missing src", exit_code: 1, status: "failed" }],
    ["quiet", { type: "commandExecution", command: "sleep 60" }], ["quiet", { type: "contextCompaction" }],
    ["quiet", { type: "webSearch" }], ["quiet", { type: "imageView" }],
  ];
  for (const [level, event] of rows) assert.equal(classify(Object.freeze(event)), level, JSON.stringify(event));
  const previous = { status: "active", attention: [] };
  for (const current of [{ status: "active", attention: ["waitingOnApproval"] }, { status: "idle", attention: [] }]) {
    assert.equal(classify(null, { current, previous }), "wake");
  }
  assert.equal(classify(null, { current: previous, previous: { ...previous, attention: ["waitingOnApproval"] } }), "wake");
  const event = { type: "commandExecution", command: "npm test", status: "inProgress", output: "start" };
  assert.equal(classify(event, { previousEvent: { ...event, change: "added" } }), "quiet");
  assert.equal(classify({ ...event, output: "progress" }, { previousEvent: event }), "quiet");
  assert.equal(classify({ ...event, command: "npm run build" }, { previousEvent: event }), "normal");
});

const observation = (cursor, events, extra = {}) => ({ cursor, events, changed: !!events.length, has_more: false, status: "active", attention: [], ...extra });
test("buffer replaces an ID within its turn, counts current entries, and preserves source objects", () => {
  const buffer = new NotificationBuffer({ notify: "digest", settleMs: 1000 });
  const reading = { id: "read", turn_id: "t", type: "commandExecution", command: "cat " + "a".repeat(300), status: "inProgress", output: "secret", diff: "large" };
  buffer.add(observation("c1", [reading]), "c0", 0);
  buffer.add(observation("c2", [{ ...reading, status: "completed", exit_code: 0 }, { ...reading, turn_id: "t2" }]), "c1", 500);
  buffer.add(observation("c3", [{ id: "write", type: "fileChange", changes: [{ diff: "keep me" }] }]), "c2", 1000);
  assert.equal(buffer.reason(1999), null); assert.equal(buffer.reason(2000), "settle");
  const data = buffer.observation("settle", 2000);
  assert.equal(data.cursor, "c3"); assert.equal(data.digest.from_cursor, "c0"); assert.equal(data.digest.held_ms, 2000);
  assert.deepEqual(data.digest.counts, { wake: 0, normal: 1, quiet: 2 });
  assert.equal(data.events[0].status, "completed"); assert.equal(data.events[0].command.length, 200);
  assert.equal(data.events[0].compacted, true); assert.equal("output" in data.events[0], false); assert.equal("diff" in data.events[0], false);
  assert.equal(data.events[2].changes[0].diff, "keep me"); assert.equal(reading.output, "secret"); assert.equal(reading.command.length, 304);
  buffer.clear(); assert.equal(buffer.observation("stopped", 3000), null);
});

test("quiet activity does not reset settle or the oldest hold time; limits wait for complete pages", () => {
  const buffer = new NotificationBuffer({ notify: "digest", settleMs: 1000, maxHoldMs: 10000 });
  buffer.add(observation("c1", [{ id: "normal", type: "unknown" }]), "c0", 0);
  buffer.add(observation("c2", [{ id: "quiet", type: "webSearch" }]), "c1", 900);
  assert.equal(buffer.reason(1000), "settle"); buffer.clear();
  buffer.add(observation("c3", [{ id: "quiet", type: "webSearch" }]), "c2", 2000);
  buffer.add(observation("c4", [{ id: "quiet", type: "webSearch", text: "updated" }]), "c3", 11000);
  assert.equal(buffer.reason(11999), null); assert.equal(buffer.reason(12000), "max-hold");
  buffer.clear();
  buffer.add(observation("c5", Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, type: "webSearch" })), { has_more: true }), "c4", 13000);
  assert.equal(buffer.reason(13000), null);
  buffer.add(observation("c6", []), "c5", 13000);
  assert.equal(buffer.reason(13000), "capacity");
  buffer.clear();
  buffer.add(observation("c7", [{ id: "big", type: "unknown", text: "あ".repeat(22000) }]), "c6", 13000);
  assert.equal(buffer.reason(13000), "capacity");
});

test("attention can wake an empty buffer and partial output keeps its real has_more and cursor", () => {
  const buffer = new NotificationBuffer();
  buffer.add(observation("c1", []), "c0", 0);
  buffer.add(observation("c2", [], { attention: ["waitingOnApproval"], changed: true, has_more: true }), "c1", 1);
  assert.equal(buffer.reason(1), null);
  const partial = buffer.observation("reconnecting", 2);
  assert.equal(partial.has_more, true); assert.equal(partial.cursor, "c2"); assert.equal(partial.digest.from_cursor, "c1");
  buffer.add(observation("c3", [], { attention: ["waitingOnApproval"] }), "c2", 3);
  assert.equal(buffer.reason(3), "wake:attention");
});

test("notification options validate ranges, integers, modes and stable defaults", () => {
  assert.deepEqual(notificationOptions(), { notify: "digest", settleMs: 20000, maxHoldMs: 600000 });
  for (const options of [{ notify: "unknown" }, { settleMs: 999 }, { settleMs: 120001 }, { settleMs: 1000.5 }, { maxHoldMs: 9999 }, { maxHoldMs: 1800001 }, { maxHoldMs: NaN }]) assert.throws(() => notificationOptions(options));
});
