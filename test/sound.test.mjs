import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SEND_NOTIFICATION_SOUND, playSendSound } from "../src/sound.mjs";

const accepted = { sent: true, delivery_status: "accepted", dry_run: false };

test("dry runs and unconfirmed delivery never launch audio playback", () => {
  let calls = 0;
  const run = () => { calls++; return { status: 0 }; };
  for (const receipt of [
    { ...accepted, dry_run: true },
    { sent: false, delivery_status: "not_sent" },
    { sent: null, delivery_status: "unknown" },
    { sent: null, delivery_status: "submitted_unverified" },
  ]) assert.equal(playSendSound(receipt, { run, platform: "darwin" }).played, false);
  assert.deepEqual(playSendSound(accepted, { run, platform: "linux" }), { played: false, reason: "unsupported_platform" });
  assert.equal(calls, 0);
});

test("accepted send plays the bundled Pururu sample once without changing its speed", () => {
  const calls = [];
  const result = playSendSound(accepted, { platform: "darwin", run(...args) { calls.push(args); return { status: 0 }; } });
  assert.deepEqual(result, { played: true });
  assert.deepEqual(calls, [["/usr/bin/afplay", [SEND_NOTIFICATION_SOUND], { encoding: "utf8", timeout: 5000 }]]);
  assert.ok(path.isAbsolute(SEND_NOTIFICATION_SOUND));
  const audio = readFileSync(SEND_NOTIFICATION_SOUND);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  assert.ok(audio.length > 44);
});

test("missing player or sound, playback errors and timeouts preserve accepted delivery without retrying", () => {
  for (const outcome of [{ status: 1 }, { status: null, error: new Error("ETIMEDOUT") }, new Error("ENOENT")]) {
    let calls = 0;
    const receipt = structuredClone(accepted);
    const result = playSendSound(receipt, { platform: "darwin", run() {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } });
    assert.deepEqual(result, { played: false, reason: "playback_failed" });
    assert.deepEqual(receipt, accepted);
    assert.equal(calls, 1);
  }
});
