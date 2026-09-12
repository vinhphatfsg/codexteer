import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { threadComposerDeepLink, threadDeepLink } from "./thread-id.mjs";
import { readDesktopSettings } from "./settings.mjs";

const APP_PATH = "/Applications/ChatGPT.app";
const APP_BUNDLE_ID = "com.openai.codex";
const OPEN = "/usr/bin/open";
const OSASCRIPT = "/usr/bin/osascript";
const SEND_SCRIPT = fileURLToPath(new URL("../scripts/send.applescript", import.meta.url));
const INSPECT_SCRIPT = fileURLToPath(new URL("../scripts/inspect.applescript", import.meta.url));
const ACCESSIBILITY_SCRIPT = fileURLToPath(new URL("../scripts/accessibility.applescript", import.meta.url));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

export function desktopDoctor() {
  const desktopSettings = readDesktopSettings();
  const checks = {
    macos: process.platform === "darwin",
    chatgpt_app: existsSync(APP_PATH),
    open_command: existsSync(OPEN),
    osascript_command: existsSync(OSASCRIPT),
    send_script: existsSync(SEND_SCRIPT),
    inspect_script: existsSync(INSPECT_SCRIPT),
    accessibility_script: existsSync(ACCESSIBILITY_SCRIPT),
    accessibility: false,
  };

  if (checks.macos && checks.osascript_command) {
    const result = run(OSASCRIPT, [
      "-e",
      'tell application "System Events" to return UI elements enabled',
    ], { timeout: 3000 });
    checks.accessibility = result.status === 0 && result.stdout.trim() === "true";
  }

  return {
    ready: Object.values(checks).every(Boolean),
    backend: "desktop-ui",
    desktop_settings: desktopSettings,
    checks,
    remediation: checks.accessibility
      ? null
      : "Enable Accessibility for your terminal app in System Settings > Privacy & Security > Accessibility.",
  };
}

export function buildOpenArgs(deepLink, { background = false } = {}) {
  return [...(background ? ["-g"] : []), "-b", APP_BUNDLE_ID, deepLink];
}

export function openDesktopThread(threadId, { focusComposer = false, prompt, background = false } = {}) {
  const deepLink = focusComposer ? threadComposerDeepLink(threadId, prompt) : threadDeepLink(threadId);
  const result = run(OPEN, buildOpenArgs(deepLink, { background }));
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Failed to open ${deepLink}`);
  }
  return {
    thread_id: threadId,
    deep_link: threadDeepLink(threadId),
    backend: "desktop-ui",
    focus_composer: focusComposer,
    background,
  };
}

function validateWaitMs(waitMs) {
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) {
    throw new Error("--wait-ms must be an integer between 0 and 30000.");
  }
}

function requireReadyDesktop() {
  const doctor = desktopDoctor();
  if (doctor.ready) return;
  const missing = Object.entries(doctor.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(", ");
  throw new Error(`Desktop backend is not ready: ${missing}. ${doctor.remediation ?? ""}`.trim());
}

function frontmostProcessId() {
  const result = run(OSASCRIPT, [
    "-e",
    'tell application "System Events" to return unix id of first application process whose frontmost is true',
  ], { timeout: 3000 });
  if (result.error) throw result.error;
  const processId = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isInteger(processId) || processId < 1) {
    throw new Error(result.stderr.trim() || "Could not identify the previously focused application.");
  }
  return processId;
}

function enableDesktopAccessibility() {
  const result = run(OSASCRIPT, [ACCESSIBILITY_SCRIPT, "enable"], { timeout: 5000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not enable the Codex accessibility tree.");
  }
  return result.stdout.trim() || "unchanged";
}

function restoreDesktopAccessibility(mode) {
  if (mode !== "manual" && mode !== "enhanced") return;
  const result = run(OSASCRIPT, [ACCESSIBILITY_SCRIPT, "restore", mode], { timeout: 5000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not restore the Codex accessibility state.");
  }
}

export function inspectDesktopUi(threadId, { waitMs = 1500 } = {}) {
  validateWaitMs(waitMs);
  requireReadyDesktop();
  const accessibilityMode = enableDesktopAccessibility();
  let result;
  try {
    openDesktopThread(threadId, { focusComposer: true });
    result = run(OSASCRIPT, [INSPECT_SCRIPT, String(waitMs)], {
      timeout: waitMs + 15000,
    });
  } finally {
    restoreDesktopAccessibility(accessibilityMode);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not inspect the Codex Desktop UI.");
  }
  return {
    thread_id: threadId,
    backend: "desktop-ui",
    accessibility_mode: accessibilityMode,
    diagnostic: result.stdout.trim(),
  };
}

function newTurnShortcut(message, composerEnterBehavior) {
  if (composerEnterBehavior === "cmdAlways") return "command";
  if (composerEnterBehavior === "cmdIfMultiline" && message.includes("\n")) return "command";
  return "plain";
}

export function buildSendPlan(
  threadId,
  message,
  waitMs = 1500,
  desktopSettings = readDesktopSettings(),
  { newTurn = false, keepFocus = false } = {},
) {
  const submitShortcut = newTurn
    ? newTurnShortcut(message, desktopSettings.composer_enter_behavior)
    : desktopSettings.submit_shortcut;
  return {
    thread_id: threadId,
    deep_link: threadDeepLink(threadId),
    backend: "desktop-ui",
    delivery_strategy: "deep-link-prefill",
    delivery_action: newTurn ? "new-turn" : "steer",
    focus_policy: keepFocus ? "keep-codex-focused" : "restore-previous-app",
    wait_ms: waitMs,
    follow_up_mode: desktopSettings.follow_up_mode,
    composer_enter_behavior: desktopSettings.composer_enter_behavior,
    submit_shortcut: submitShortcut,
    message_characters: [...message].length,
  };
}

export function sendDesktopMessage(
  threadId,
  message,
  { dryRun = false, waitMs = 1500, newTurn = false, keepFocus = false } = {},
) {
  if (message.trim() === "") throw new Error("Message must not be empty.");
  validateWaitMs(waitMs);

  const desktopSettings = readDesktopSettings();
  const plan = buildSendPlan(threadId, message, waitMs, desktopSettings, { newTurn, keepFocus });
  if (dryRun) return { ...plan, dry_run: true, sent: false };

  requireReadyDesktop();
  const previousProcessId = keepFocus ? 0 : frontmostProcessId();
  openDesktopThread(threadId, { focusComposer: true, prompt: message, background: true });
  const result = run(OSASCRIPT, [
    SEND_SCRIPT,
    String(waitMs),
    plan.submit_shortcut,
    keepFocus ? "keep" : "restore",
    String(previousProcessId),
  ], {
    timeout: waitMs + 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Codex Desktop did not accept the steering message.");
  }

  return { ...plan, dry_run: false, sent: null, delivery_status: "submitted_unverified" };
}
