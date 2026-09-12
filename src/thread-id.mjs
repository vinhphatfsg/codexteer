const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeThreadId(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Thread ID is required.");
  }

  let value = input.trim();
  if (value.startsWith("codex://")) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid Codex thread URL: ${input}`);
    }
    if (url.hostname !== "threads") {
      throw new Error(`Expected codex://threads/<thread-id>: ${input}`);
    }
    value = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  }

  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Invalid local Codex thread ID: ${input}`);
  }
  return value.toLowerCase();
}

export function threadDeepLink(threadId) {
  return `codex://threads/${normalizeThreadId(threadId)}`;
}

export function threadComposerDeepLink(threadId, prompt = "") {
  const query = new URLSearchParams({ prompt });
  return `${threadDeepLink(threadId)}?${query}`;
}
