import { isDesktopCloudTask, desktopCloudId } from "./desktop-cloud-id.mjs";
import { normalizeThreadId } from "./thread-id.mjs";
import { isCloudTask, cloudTaskId } from "./cloud-id.mjs";
import { connectionMismatch } from "./connection-error.mjs";

export { isCloudTask } from "./cloud-id.mjs";

// Shared records use the actual backend identifier. Desktop RPC boundaries
// retain their strict UUID validator, so a cloud ID cannot reach a local task.
export function normalizeTaskId(value) {
  return isDesktopCloudTask(value) ? desktopCloudId(value) : isCloudTask(value) ? cloudTaskId(value) : normalizeThreadId(value);
}

export function taskConnection(value, selected = "shared") {
  if (isDesktopCloudTask(value)) {
    if (!["shared", "desktop-cloud"].includes(selected)) throw connectionMismatch("desktop-cloud", selected);
    return "desktop-cloud";
  }
  if (selected === "desktop-cloud") throw connectionMismatch(isCloudTask(value) ? "cloud" : "shared", selected);
  const cloud = isCloudTask(value);
  if (cloud && selected === "desktop") throw connectionMismatch("cloud", selected);
  if (!cloud && selected === "cloud") throw connectionMismatch("shared", selected);
  return cloud ? "cloud" : selected;
}
