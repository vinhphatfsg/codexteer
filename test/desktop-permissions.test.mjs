import { validatePermissionSchemas } from "../src/native-command.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { tempPrefix } from "../test-support/temp.mjs";
import { readDesktopPermissionSelection, permissionParams, desktopPermissionMode } from "../src/desktop-permissions.mjs";

async function fixture(t, atoms) {
  const home = await mkdtemp(tempPrefix("ct-permissions-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, ".codex-global-state.json");
  if (atoms !== undefined) await writeFile(file, JSON.stringify({ "electron-persisted-atom-state": atoms }), { mode: 0o600 });
  return { home, file };
}
const pick = agentMode => ({ "permission-selection-by-host-id:local": { kind: "agent-mode", agentMode }, "agent-mode-by-host-id": { local: agentMode } });

for (const [mode, profile, reviewer, approval] of [
  ["guardian-approvals", ":workspace", "auto_review", "on-request"],
  ["auto", ":workspace", "user", "on-request"],
  ["read-only", ":read-only", "user", "on-request"],
  ["full-access", ":danger-full-access", "user", "never"],
]) test(`saved Desktop ${mode} selection is copied without config guessing`, async t => {
  const { home } = await fixture(t, pick(mode));
  const params = await desktopPermissionMode({ request() { assert.fail("built-in selection needs no config read"); } }, { home, state: {} });
  assert.deepEqual(params, { permissions: profile, approvalPolicy: approval, approvalsReviewer: reviewer });
});

test("legacy picker is read only when the new picker has no selection", async t => {
  const { home } = await fixture(t, { "agent-mode-by-host-id": { local: "guardian-approvals" } });
  assert.deepEqual(await readDesktopPermissionSelection(home), { kind: "agent-mode", agentMode: "guardian-approvals" });
});

for (const atoms of [undefined, {}, { "agent-mode-by-host-id": { remote: "full-access" } },
  { ...pick("guardian-approvals"), "agent-mode-by-host-id": { local: "read-only" } },
  { ...pick("guardian-approvals"), "permission-selection-by-host-id:local": { kind: "future" } },
  { "permission-selection-by-host-id:local": { kind: "agent-mode", agentMode: "constructor" } },
  { "heartbeat-thread-permissions-by-id": { unrelated: { approvalsReviewer: "auto_review" } } },
]) test("missing, ambiguous or unknown selection does not infer broader permissions", async t => {
  const { home } = await fixture(t, atoms);
  await assert.rejects(readDesktopPermissionSelection(home), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
});

test("unsafe or malformed state is refused", async t => {
  const { home, file } = await fixture(t, pick("auto"));
  await chmod(file, 0o666);
  await assert.rejects(readDesktopPermissionSelection(home), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
  await chmod(file, 0o600); await writeFile(file, "{");
  await assert.rejects(readDesktopPermissionSelection(home), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
  await rm(file); await symlink("other", file);
  await assert.rejects(readDesktopPermissionSelection(home), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
});

test("named profiles are copied only from an explicit Desktop selection", async t => {
  const { home } = await fixture(t, { "permission-selection-by-host-id:local": { kind: "profile", profileId: "restricted" } });
  assert.deepEqual(permissionParams(await readDesktopPermissionSelection(home)), { permissions: "restricted" });
});

test("custom config retains sandbox root, network and temporary-directory restrictions", async t => {
  const { home } = await fixture(t, { "permission-selection-by-host-id:local": { kind: "custom" } });
  const config = { approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_mode: "workspace-write",
    sandbox_workspace_write: { writable_roots: ["/extra"], network_access: false, exclude_slash_tmp: true, exclude_tmpdir_env_var: true } };
  const client = { async request(method, params) { assert.equal(method, "config/read"); assert.deepEqual(params, { cwd: "/project", includeLayers: false }); return { config }; } };
  const params = await desktopPermissionMode(client, { home, state: {}, cwd: "/project", roots: ["/project", "/second"] });
  assert.deepEqual(params, { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/project", "/second", "/extra"], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
  assert.deepEqual(permissionParams({ kind: "custom" }, config, { operation: "thread/start" }), { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", config: { sandbox_workspace_write: config.sandbox_workspace_write } });
  for (const key of ["approval_policy", "approvals_reviewer", "sandbox_mode"]) await assert.rejects(desktopPermissionMode({ async request() { return { config: { ...config, [key]: null } }; } }, { home }), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
});

test("selection changes during permission preparation are not dispatched", async () => {
  let reads = 0;
  await assert.rejects(desktopPermissionMode({}, {}, {
    readSelection: async () => ({ kind: "agent-mode", agentMode: ++reads === 1 ? "guardian-approvals" : "read-only" }),
  }), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
});

test("unsupported permission schemas fail closed", () => {
  assert.throws(() => validatePermissionSchemas({}), { code: "DESKTOP_PERMISSION_UNVERIFIED" });
});
