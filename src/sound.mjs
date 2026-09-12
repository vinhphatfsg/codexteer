import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SEND_NOTIFICATION_SOUND = fileURLToPath(new URL("../assets/send-pururu.wav", import.meta.url));

export function playSendSound(receipt, { run = spawnSync, platform = process.platform } = {}) {
  if (receipt.dry_run) return { played: false, reason: "dry_run" };
  if (receipt.sent !== true || receipt.delivery_status !== "accepted") return { played: false, reason: "not_accepted" };
  if (platform !== "darwin") return { played: false, reason: "unsupported_platform" };
  // Audio failure must not turn an accepted send into a retryable failure.
  try {
    const result = run("/usr/bin/afplay", [SEND_NOTIFICATION_SOUND], { encoding: "utf8", timeout: 5000 });
    if (!result.error && result.status === 0) return { played: true };
  } catch { /* Preserve the send receipt even if playback cannot start. */ }
  return { played: false, reason: "playback_failed" };
}
