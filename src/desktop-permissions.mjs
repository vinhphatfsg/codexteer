import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

const failure = () => Object.assign(new Error("Desktop's saved local permission selection could not be verified. Select a permission mode in Desktop and retry; no instruction was sent."), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
const modes = {
  "read-only": { permissions: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
  auto: { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" },
  granular: { permissions: ":workspace", approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true } }, approvalsReviewer: "user" },
  "guardian-approvals": { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
  "full-access": { permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" },
};

const entries = value => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];

// Desktop keeps account atoms under its current content owner and device atoms
// in the older map; it reads the two merged, the device map winning.
function desktopAtoms(state) {
  const owner = state?.["electron-renderer-content-owner"];
  const owned = typeof owner === "string" ? state[`electron-owner-atoms:${owner}`] : undefined;
  return Object.fromEntries([...entries(owned), ...entries(state?.["electron-persisted-atom-state"])]);
}

// Read only the selected mode, never heartbeat permissions from another chat.
// Desktop has both a permission-selection picker and an older agent-mode picker.
export async function readDesktopPermissionSelection(home) {
  let file;
  try {
    file = await open(path.join(home, ".codex-global-state.json"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 16 * 1024 * 1024) throw failure();
    const atoms = desktopAtoms(JSON.parse(await file.readFile("utf8")));
    const selected = atoms?.["permission-selection-by-host-id:local"];
    const legacy = atoms?.["agent-mode-by-host-id"]?.local;
    if (selected !== undefined) {
      if (selected?.kind === "agent-mode" && legacy !== undefined && legacy !== selected.agentMode) throw failure();
      if (selected?.kind === "agent-mode" && Object.hasOwn(modes, selected.agentMode)) return { kind: "agent-mode", agentMode: selected.agentMode };
      if (selected?.kind === "profile" && typeof selected.profileId === "string" && selected.profileId.trim() && !selected.profileId.startsWith(":")) return { kind: "profile", profileId: selected.profileId };
      if (selected?.kind === "custom" || selected?.kind === "server-default") return { kind: selected.kind };
      throw failure();
    }
    if (Object.hasOwn(modes, legacy) || legacy === "custom") return { kind: legacy === "custom" ? "custom" : "agent-mode", ...(legacy === "custom" ? {} : { agentMode: legacy }) };
    throw failure();
  } catch { throw failure(); } finally { await file?.close(); }
}

export function permissionParams(selection, config, { operation = "turn/start", roots = [] } = {}) {
  if (selection.kind === "agent-mode" && Object.hasOwn(modes, selection.agentMode)) return structuredClone(modes[selection.agentMode]);
  if (selection.kind === "profile") return { permissions: selection.profileId };
  // An explicitly selected config/default mode needs all three values. Do not
  // manufacture a broader mode from partial config or another thread's rollout.
  if (!["custom", "server-default"].includes(selection.kind)
    || !["untrusted", "on-request", "never"].includes(config?.approval_policy)
    || !["user", "auto_review", "guardian_subagent"].includes(config?.approvals_reviewer)
    || !["read-only", "workspace-write", "danger-full-access"].includes(config?.sandbox_mode)) throw failure();
  const common = { approvalPolicy: config.approval_policy, approvalsReviewer: config.approvals_reviewer };
  const workspace = config.sandbox_workspace_write;
  if (workspace != null && (typeof workspace !== "object" || Array.isArray(workspace)
    || (workspace.writable_roots !== undefined && (!Array.isArray(workspace.writable_roots) || workspace.writable_roots.some(root => typeof root !== "string" || !path.isAbsolute(root) || root.includes("\0"))))
    || ["network_access", "exclude_slash_tmp", "exclude_tmpdir_env_var"].some(key => workspace[key] != null && typeof workspace[key] !== "boolean"))) throw failure();
  if (operation === "thread/start") return { ...common, sandbox: config.sandbox_mode,
    ...(workspace == null ? {} : { config: { sandbox_workspace_write: workspace } }) };
  const sandboxPolicy = config.sandbox_mode === "workspace-write" ? {
    type: "workspaceWrite", writableRoots: [...new Set([...roots, ...workspace?.writable_roots ?? []])],
    networkAccess: workspace?.network_access ?? false, excludeSlashTmp: workspace?.exclude_slash_tmp ?? false,
    excludeTmpdirEnvVar: workspace?.exclude_tmpdir_env_var ?? false,
  } : config.sandbox_mode === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" };
  return { ...common, sandboxPolicy };
}

// The standalone creation preflight verifies the matching bundled permission
// schemas once, before either fresh selection is read. No subprocess is needed here.
export async function desktopPermissionMode(client, { home, cwd, operation = "turn/start", roots = [] }, { readSelection = readDesktopPermissionSelection } = {}) {
  const selection = await readSelection(home);
  const config = ["custom", "server-default"].includes(selection.kind)
    ? (await client.request("config/read", { cwd, includeLayers: false })).config : undefined;
  const params = permissionParams(selection, config, { operation, roots });
  if (!isDeepStrictEqual(selection, await readSelection(home))) throw failure();
  return params;
}
