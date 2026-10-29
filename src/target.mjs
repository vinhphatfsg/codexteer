import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

// One invocation selects one host, including for downstream local records.
const targets = new AsyncLocalStorage();
export const targetHost = () => targets.getStore()?.hostId ?? "local";
export const targetContext = () => targets.getStore()?.contextThread;
export const remoteTransport = () => targets.getStore()?.remoteTransport ?? "native";
export const isControlTransport = (transport = remoteTransport()) => ["control", "paired"].includes(transport);
export function validateRemoteTransport(value) {
  if (!["native", "control", "paired"].includes(value)) throw Object.assign(new Error("--remote-transport must be native, control or paired."), { code: "INVALID_REMOTE_TRANSPORT" });
  return value;
}
export function validateHostId(hostId) {
  if (typeof hostId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(hostId)) {
    throw Object.assign(new Error("Invalid host ID."), { code: "INVALID_HOST" });
  }
  return hostId;
}
export const withTarget = (hostId, contextThread, operation, { transport = "native" } = {}) => targets.run({ hostId: validateHostId(hostId), contextThread, remoteTransport: validateRemoteTransport(transport) }, operation);
export const hostNamespace = () => targetHost() === "local" ? null : createHash("sha256").update(targetHost()).digest("hex");
export const hostFields = () => targetHost() === "local" ? {} : { host_id: targetHost(), remote_transport: remoteTransport() };
export function remoteReadOnly() {
  return Object.assign(new Error("The native remote route supports observation only. Select --remote-transport paired for remote task creation, listing and new-turn operations, or a configured control route for active-turn steering. No route was switched automatically."), { code: "REMOTE_READ_ONLY", sent: false, delivery_status: "not_sent" });
}
