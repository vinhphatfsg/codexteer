import { readFile } from "node:fs/promises";
import path from "node:path";

export async function desktopMembership(home, threadId, projectId) {
  const state = JSON.parse(await readFile(path.join(home, ".codex-global-state.json"), "utf8"));
  const assignment = state["thread-project-assignments"]?.[threadId];
  return assignment?.projectKind === "local" && assignment.projectId === projectId;
}

export function initialInstructionMatches(history, prompt, sourceId) {
  const item = history.turns?.[0]?.items?.find(item => item.type === "userMessage"
    || (item.type === "functionCallOutput" && item.namespace === "codex_app" && item.name === "create_thread"));
  if (item?.type === "userMessage") return item.content?.filter(part => part.type === "text").map(part => part.text).join("\n") === prompt;
  const expected = `<codex_delegation>\n  <source_thread_id>${sourceId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
  return item?.output === expected;
}
