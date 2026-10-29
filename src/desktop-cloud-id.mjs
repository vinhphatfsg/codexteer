import { normalizeThreadId } from "./thread-id.mjs";
export function isDesktopCloudTask(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("durable_")) return true;
  try { const u = new URL(value); return u.protocol === "codex:" && u.hostname === "threads" && u.searchParams.get("hostId") === "durable"; } catch { return false; }
}
export function desktopCloudId(value) {
  if (!isDesktopCloudTask(value)) throw Object.assign(new Error("Desktop Cloud requires a durable_ ID or a link with hostId=durable."), { code: "CLOUD_TARGET_CONFLICT" });
  return "durable_" + normalizeThreadId(value.startsWith("durable_") ? value.slice(8) : value);
}
export const desktopCloudUuid = value => desktopCloudId(value).slice(8);
export const desktopCloudLink = value => `codex://threads/${desktopCloudUuid(value)}?hostId=durable`;
