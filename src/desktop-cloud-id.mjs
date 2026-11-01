import { normalizeThreadId } from "./thread-id.mjs";
import { isCloudTask } from "./cloud-id.mjs";
import { connectionMismatch } from "./connection-error.mjs";
export function isDesktopCloudTask(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("durable_")) return true;
  try { const u = new URL(value); return u.protocol === "codex:" && u.hostname === "threads" && u.searchParams.getAll("hostId").includes("durable"); } catch { return false; }
}
export function desktopCloudId(value) {
  if (!isDesktopCloudTask(value)) {
    if (isCloudTask(value)) throw connectionMismatch("cloud", "desktop-cloud");
    let local = false;
    try { normalizeThreadId(value); local = true; } catch {}
    if (local) throw connectionMismatch("shared", "desktop-cloud");
    throw Object.assign(new Error("Desktop Cloud requires a durable_ ID or a link with hostId=durable."), { code: "CLOUD_TARGET_CONFLICT" });
  }
  let uuid = value.slice(8);
  if (!value.startsWith("durable_")) {
    const url = new URL(value);
    if (url.searchParams.getAll("hostId").length !== 1 || url.username || url.password || url.port) throw Object.assign(new Error("Ambiguous Desktop Cloud link."), { code: "CLOUD_TARGET_CONFLICT" });
    uuid = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  }
  return "durable_" + normalizeThreadId(uuid);
}
export const desktopCloudUuid = value => desktopCloudId(value).slice(8);
export const desktopCloudLink = value => `codex://threads/${desktopCloudUuid(value)}?hostId=durable`;
