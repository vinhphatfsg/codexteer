import { nativeToolJson } from "./native-rpc.mjs";

export function validateMembershipCatalog(catalog) {
  const schema = catalog?.tools?.find(tool => tool.name === "list_threads" && tool.namespace === "codex_app")?.inputSchema;
  const limit = schema?.properties?.limit;
  if (schema?.type !== "object" || !["number", "integer"].includes(limit?.type)
    || (limit.minimum ?? 1) > 50 || (limit.maximum ?? 50) < 50) {
    throw Object.assign(new Error("Desktop native tools do not expose the membership snapshot schema."), { code: "NATIVE_CREATION_UNSUPPORTED" });
  }
  return schema;
}

// The persisted legacy assignment map is not Desktop's live membership view.
// Use the same native projection as the sidebar, and fail closed if the task
// is outside this bounded snapshot. Canonical membership is checked separately.
export async function desktopMembership(native, endpoint, threadId, projectId, context, options) {
  const snapshot = nativeToolJson(await native(endpoint, "list_threads", { limit: 50 }, context, options));
  if (!Array.isArray(snapshot.threads) || !Array.isArray(snapshot.pinnedThreads)) {
    throw Object.assign(new Error("Invalid Desktop membership snapshot."), { code: "NATIVE_PROTOCOL_ERROR" });
  }
  const matches = [...snapshot.pinnedThreads, ...snapshot.threads].filter(thread => thread?.id === threadId);
  return matches.length === 1 && matches[0].kind === "codex" && matches[0].hostId === "local" && matches[0].projectId === projectId;
}

export function initialInstructionText(history, sourceId) {
  const item = history.turns?.[0]?.items?.find(item => item.type === "userMessage"
    || (item.type === "functionCallOutput" && item.namespace === "codex_app" && item.name === "create_thread"));
  if (item?.type === "userMessage") return item.content?.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (typeof sourceId !== "string" || typeof item?.output !== "string") return undefined;
  const prefix = `<codex_delegation>\n  <source_thread_id>${sourceId}</source_thread_id>\n  <input>`, suffix = "</input>\n</codex_delegation>";
  return item.output.startsWith(prefix) && item.output.endsWith(suffix) ? item.output.slice(prefix.length, -suffix.length) : undefined;
}

export function initialInstructionMatches(history, prompt, sourceId) {
  return initialInstructionText(history, sourceId) === prompt;
}
