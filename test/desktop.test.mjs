import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenArgs, buildSendPlan, sendDesktopMessage } from "../src/desktop.mjs";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

test("builds a redacted send plan", () => {
  const plan = buildSendPlan(THREAD_ID, "方針を変更して", 2000, {
    follow_up_mode: "queue",
    composer_enter_behavior: "enter",
    submit_shortcut: "command",
  });
  assert.equal(plan.thread_id, THREAD_ID);
  assert.equal(plan.wait_ms, 2000);
  assert.equal(plan.message_characters, 7);
  assert.equal(plan.delivery_strategy, "deep-link-prefill");
  assert.equal(plan.delivery_action, "steer");
  assert.equal(plan.focus_policy, "restore-previous-app");
  assert.equal(plan.submit_shortcut, "command");
  assert.equal("message" in plan, false);
});

test("opens composer deep links in the background", () => {
  const link = `codex://threads/${THREAD_ID}?prompt=test`;
  assert.deepEqual(buildOpenArgs(link, { background: true }), [
    "-g",
    "-b",
    "com.openai.codex",
    link,
  ]);
});

test("can explicitly keep Codex focused", () => {
  const settings = {
    follow_up_mode: "steer",
    composer_enter_behavior: "enter",
    submit_shortcut: "plain",
  };
  const plan = buildSendPlan(THREAD_ID, "test", 1500, settings, { keepFocus: true });
  assert.equal(plan.focus_policy, "keep-codex-focused");
});

test("uses a normal submission shortcut for a stopped thread", () => {
  const settings = {
    follow_up_mode: "queue",
    composer_enter_behavior: "enter",
    submit_shortcut: "command",
  };
  const plan = buildSendPlan(THREAD_ID, "通常送信", 1500, settings, { newTurn: true });
  assert.equal(plan.delivery_action, "new-turn");
  assert.equal(plan.submit_shortcut, "plain");
});

test("respects command-based new-turn submission settings", () => {
  const settings = {
    follow_up_mode: "queue",
    composer_enter_behavior: "cmdAlways",
    submit_shortcut: "command-shift",
  };
  const plan = buildSendPlan(THREAD_ID, "通常送信", 1500, settings, { newTurn: true });
  assert.equal(plan.submit_shortcut, "command");
});

test("dry run does not touch the desktop", () => {
  const result = sendDesktopMessage(THREAD_ID, "test", { dryRun: true });
  assert.equal(result.sent, false);
  assert.equal(result.dry_run, true);
});

test("rejects invalid wait time", () => {
  assert.throws(
    () => sendDesktopMessage(THREAD_ID, "test", { dryRun: true, waitMs: -1 }),
    /--wait-ms/,
  );
});
