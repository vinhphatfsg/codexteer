import test from "node:test";
import assert from "node:assert/strict";
import { parseDesktopSettings } from "../src/settings.mjs";

test("defaults to normal Enter for steering mode", () => {
  assert.deepEqual(parseDesktopSettings(""), {
    follow_up_mode: "steer",
    composer_enter_behavior: "enter",
    submit_shortcut: "plain",
  });
});

test("uses Command-Enter to override queue mode with Enter submission", () => {
  const settings = parseDesktopSettings(`
[desktop]
followUpQueueMode = "queue"
`);
  assert.equal(settings.follow_up_mode, "queue");
  assert.equal(settings.submit_shortcut, "command");
});

test("uses Command-Shift-Enter with command-based composer submission", () => {
  const settings = parseDesktopSettings(`
[desktop]
followUpQueueMode = "queue"
composerEnterBehavior = "cmdAlways"
`);
  assert.equal(settings.composer_enter_behavior, "cmdAlways");
  assert.equal(settings.submit_shortcut, "command-shift");
});

test("treats the legacy interrupt mode as steering", () => {
  const settings = parseDesktopSettings(`
[desktop]
followUpQueueMode = "interrupt"
`);
  assert.equal(settings.follow_up_mode, "steer");
  assert.equal(settings.submit_shortcut, "plain");
});
