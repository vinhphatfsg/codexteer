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

const values = new Set("--environment --connection --supervisor --require-node-version --host --remote-transport --context-thread --thread --backend --source --kind --evidence --based-on --finding --expires-at --supersedes --checkpoint --limit --max-chars --since --poll-ms --timeout-ms --until --notify --settle-ms --max-hold-ms --owner --key --condition --note --rating --reason --root --path --exclude --command --cwd --artifact --status --by --token --ttl-ms --agent --project --env --branch --title --byte-budget --continue --offset --sync-token --model --thinking --cursor --attempt --event-offset --work --wait-ms --search".split(" "));

// "cloud", "desktop-cloud", or false for local. The router and error-usage selection
// both read this one rule.
export function selectedCloudInvocation(argv) {
  const end = argv.indexOf("--"), own = end < 0 ? argv : argv.slice(0, end);
  const connection = own.indexOf("--connection");
  const positional = [];
  for (let i = 0; i < own.length; i++) {
    if (values.has(own[i])) { i++; continue; }
    if (!own[i].startsWith("--")) positional.push(own[i]);
  }
  const [command, action] = positional;
  if (["help", "--help", "--version"].includes(command) || own.includes("--help") || own.includes("--version")) return false;
  if (connection >= 0 && ["cloud", "desktop-cloud"].includes(own[connection + 1])) return own[connection + 1];
  const thread = own.indexOf("--thread");
  if (["doctor", "resource"].includes(command) && thread >= 0) return isDesktopCloudTask(own[thread + 1]) ? "desktop-cloud" : isCloudTask(own[thread + 1]) ? "cloud" : false;
  if (command === "thread" && action === "create") return false;
  const nested = ["history", "instructions", "findings", "checkpoint", "thread"].includes(command)
    || (command === "supervise" && ["prompt", "register", "status", "pause", "resume", "stop", "list"].includes(action))
    || (command === "work" && action === "tell");
  const target = isCloudTask(command) || isDesktopCloudTask(command) ? command : positional[nested ? 2 : 1];
  return isDesktopCloudTask(target) ? "desktop-cloud" : isCloudTask(target) ? "cloud" : false;
}
