import { normalizeThreadId } from "./thread-id.mjs";
import { isCloudTask, cloudTaskId } from "./cloud-id.mjs";

export { isCloudTask } from "./cloud-id.mjs";

// Shared records use the actual backend identifier. Desktop RPC boundaries
// retain their strict UUID validator, so a cloud ID cannot reach a local task.
export function normalizeTaskId(value) {
  return isCloudTask(value) ? cloudTaskId(value) : normalizeThreadId(value);
}

export function taskConnection(value, selected = "shared") {
  const cloud = isCloudTask(value);
  if (cloud && selected === "desktop") throw Object.assign(new Error("A cloud task cannot use a Desktop observation endpoint."), { code: "CLOUD_TARGET_CONFLICT" });
  if (!cloud && selected === "cloud") throw Object.assign(new Error("The cloud connection requires a cloud task ID or link."), { code: "CLOUD_TARGET_CONFLICT" });
  return cloud ? "cloud" : selected;
}
