import { targetHost, validateHostId } from "./target.mjs";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseThreadTarget(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Thread ID is required.");
  }

  let value = input.trim(), hostId;
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
    const hosts = url.searchParams.getAll("hostId");
    if (hosts.length > 1) throw new Error("A thread link must have only one hostId.");
    if (hosts.length) hostId = validateHostId(hosts[0]);
    value = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  }

  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Invalid local Codex thread ID: ${input}`);
  }
  return { threadId: value.toLowerCase(), hostId };
}

export function normalizeThreadId(input) {
  const { threadId, hostId } = parseThreadTarget(input);
  if (hostId !== undefined && hostId !== targetHost()) {
    throw Object.assign(new Error("Thread link belongs to another host. Select its host with --host or the host-aware CLI entry point."), { code: "HOST_MISMATCH" });
  }
  return threadId;
}

export function threadDeepLink(threadId) {
  const target = parseThreadTarget(threadId), host = target.hostId ?? targetHost();
  const link = `codex://threads/${target.threadId}`;
  return host === "local" ? link : `${link}?${new URLSearchParams({ hostId: host })}`;
}

export function threadComposerDeepLink(threadId, prompt = "") {
  const link = new URL(threadDeepLink(threadId));
  link.searchParams.set("prompt", prompt);
  return link.toString();
}
