import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULTS = Object.freeze({
  follow_up_mode: "steer",
  composer_enter_behavior: "enter",
  submit_shortcut: "plain",
});

export function parseDesktopSettings(source) {
  let section = "";
  const values = {};

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== "desktop" || line === "" || line.startsWith("#")) continue;

    const valueMatch = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/u);
    if (valueMatch) values[valueMatch[1]] = valueMatch[2];
  }

  const followUpMode = values.followUpQueueMode === "queue" ? "queue" : "steer";
  const composerEnterBehavior = ["cmdIfMultiline", "cmdAlways"].includes(values.composerEnterBehavior)
    ? values.composerEnterBehavior
    : "enter";
  const submitShortcut = followUpMode === "queue"
    ? composerEnterBehavior === "enter" ? "command" : "command-shift"
    : "plain";

  return {
    follow_up_mode: followUpMode,
    composer_enter_behavior: composerEnterBehavior,
    submit_shortcut: submitShortcut,
  };
}

export function readDesktopSettings(configPath = path.join(
  process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  "config.toml",
)) {
  if (!existsSync(configPath)) return { ...DEFAULTS };
  return parseDesktopSettings(readFileSync(configPath, "utf8"));
}
