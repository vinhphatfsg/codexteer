import { sendDesktopMessage } from "./desktop.mjs";
import { dispatchExternalEffect } from "./supervision.mjs";

// UI automation cannot produce a trustworthy acceptance receipt. Keeping the
// backend adapter behind the common effect gate makes every CLI spelling
// (send, shorthand send, steer and new-turn) fail closed for managed work.
export async function sendDesktopUiMessage(threadId, message, options = {}, storage = {}, dependencies = {}) {
  const send = dependencies.send ?? sendDesktopMessage;
  return dispatchExternalEffect(threadId, options.supervisor, "desktop-ui", () => send(threadId, message, options), { connection: options.connection, ...storage });
}
