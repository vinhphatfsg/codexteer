import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { discoverRuntime, codexHome } from "./runtime.mjs";
import { BUNDLED_NODE } from "./wrapper.mjs";
import { discoverNativeEndpoint, nativeRpc, inspectNativeEndpoint } from "./native-rpc.mjs";
import { connectDesktopCloud } from "./desktop-cloud-api.mjs";
import { desktopCloudId, desktopCloudUuid } from "./desktop-cloud-id.mjs";
import { listProjects } from "./projects.mjs";
import { listRecords, readRecord, writeRecord, withStoreLock, storePath } from "./store.mjs";
const failure = (message, code = "DESKTOP_CLOUD_PROJECT_UNAVAILABLE", uncertain = false) => Object.assign(new Error(message), { code, uncertain });
const sha = value => createHash("sha256").update(value).digest("hex");

export async function discoverProjectApi({ discover = discoverRuntime, endpoint = discoverNativeEndpoint, run = spawnSync } = {}) {
  const selected = await discover(), { state } = selected;
  const owned = run("/bin/ps", ["-p", String(state.pid), "-o", "uid=", "-o", "comm="], { encoding: "utf8", timeout: 3000 });
  const owner = owned.stdout?.trim().match(/^(\d+)\s+(.+)$/);
  if (owned.status !== 0 || !owner || Number(owner[1]) !== process.getuid() || owner[2] !== BUNDLED_NODE || state.node_path !== BUNDLED_NODE) throw failure("Cannot verify the selected Desktop process.");
  const target = await endpoint(state);
  // Extract only the inherited endpoint and public verification key from this
  // one owner-validated process. Never emit or persist its environment.
  const processEnv = run("/bin/ps", ["eww", "-p", String(state.pid), "-o", "command="], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
  const pipe = processEnv.stdout?.match(/(?:^| )CODEX_APP_TOOLS_PIPE_PATH=([^ \n]*)/)?.[1];
  const encoded = processEnv.stdout?.match(/(?:^| )CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY=([^ \n]*)/)?.[1];
  if (processEnv.status !== 0 || pipe !== target.socketPath || !encoded || !/^[A-Za-z0-9+/]{40,200}={0,2}$/.test(encoded)) throw failure("The selected Desktop has no verifiable project API identity.");
  let key;
  try { key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" }); } catch { throw failure("Invalid Desktop project API verification key."); }
  if (key.asymmetricKeyType !== "ed25519") throw failure("Unsupported Desktop project API signature.");
  return { ...selected, endpoint: target, key, key_id: sha(key.export({ format: "der", type: "spki" })) };
}
export function verifyProjectReply(reply, method, params, key) {
  if (!["taskProject/list", "taskProject/assign"].includes(method) || typeof reply?.payload !== "string" || Buffer.byteLength(reply.payload) > 8 * 1024 * 1024
    || typeof reply.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(reply.signature)) throw failure("Invalid signed project response.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
  let body, valid = false;
  try { valid = verify(null, Buffer.from(reply.payload), key, Buffer.from(reply.signature, "base64")); body = JSON.parse(reply.payload); } catch {}
  if (!valid || body?.domain !== `codex.${method.replace("/", ".")}.v1` || !isDeepStrictEqual(body.request, params)) throw failure("Project response signature or request binding did not match.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
  return method === "taskProject/list" ? body.catalog : body.project;
}
async function current(api, discover = discoverRuntime) {
  const next = await discover();
  if (next.paths.home !== api.paths.home || next.paths.socket !== api.paths.socket || next.state.pid !== api.state.pid || next.state.instance !== api.state.instance) throw failure("Desktop changed during the operation. Inspect the receipt before retrying.", "DESKTOP_CLOUD_PROJECT_BINDING_CHANGED");
  await inspectNativeEndpoint(api.endpoint.socketPath, api.endpoint.fingerprint);
}
export function validateProjectCatalog(catalog, environmentId) {
  if (catalog?.environmentId !== environmentId || !Array.isArray(catalog.projects) || catalog.projects.length > 10000) throw failure("Invalid project catalog environment.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
  const ids = new Set();
  for (const row of catalog.projects) {
    if (typeof row?.projectId !== "string" || !row.projectId || row.projectId.length > 400 || ids.has(row.projectId) || typeof row.name !== "string" || !row.name.trim()
      || !Array.isArray(row.rootPaths) || !row.rootPaths.length || row.rootPaths.some(root => typeof root !== "string" || root.includes("\0") || !(path.isAbsolute(root) || path.win32.isAbsolute(root)))) throw failure("Invalid project catalog entry.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
    ids.add(row.projectId);
  }
  return catalog.projects.map(row => ({ project_id: row.projectId, name: row.name, roots: [...row.rootPaths] }));
}
async function catalogOnApi(api, environmentId, { call = nativeRpc, check = current } = {}) {
  await check(api);
  const params = { environmentId, nonce: randomBytes(32).toString("hex") };
  let response;
  try { response = await call(api.endpoint, { jsonrpc: "2.0", id: randomUUID(), method: "taskProject/list", params }); }
  catch { throw failure("Desktop did not authorize project assignment for this task's actual environment. This API requires its own ready Desktop executor; the environment ID is never substituted."); }
  const rows = validateProjectCatalog(verifyProjectReply(response, "taskProject/list", params, api.key), environmentId);
  await check(api); return rows;
}
async function targetEnvironment(client, id) {
  const { thread } = await client.request("thread/read", { threadId: id });
  if (thread?.id !== id || !Array.isArray(thread.environments) || thread.environments.length !== 1 || typeof thread.environments[0]?.environmentId !== "string" || !thread.environments[0].environmentId) throw failure("Cannot verify the Cloud task's environment.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
  return thread.environments[0].environmentId;
}
export async function readDesktopProjectState(home, threadInput) {
  const id = desktopCloudUuid(threadInput), file = await open(path.join(home, ".codex-global-state.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 16 * 1024 * 1024) throw failure("Unsafe Desktop project state.", "DESKTOP_CLOUD_PROJECT_STATE_UNSAFE");
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0); if (bytesRead > 16 * 1024 * 1024) throw failure("Desktop project state exceeded its limit.");
    const state = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), assignment = state["thread-project-assignments"]?.[id];
    if (assignment != null && (typeof assignment.projectKind !== "string" || typeof assignment.projectId !== "string" || !assignment.projectId || assignment.projectId.length > 400)) throw failure("Invalid Desktop project membership record.", "DESKTOP_CLOUD_PROJECT_PROTOCOL");
    return { assignment: assignment ?? null, host_id: state["thread-project-membership-host-ids"]?.[id] ?? null,
      projectless: Array.isArray(state["projectless-thread-ids"]) && state["projectless-thread-ids"].includes(id) };
  } finally { await file.close(); }
}
export async function desktopCloudProjectDoctor(target, selector, { connect = connectDesktopCloud, discoverApi = discoverProjectApi, catalog = catalogOnApi,
  readState = readDesktopProjectState, projects = listProjects } = {}) {
  const id = desktopCloudId(target); let client, api;
  const report = { assignment_api: { status: "unavailable" }, membership: { status: "unverified" } };
  try {
    client = await connect(); const environment = await targetEnvironment(client, id);
    try { api = await discoverApi(); } catch (error) { report.assignment_api.reason_code = error.code ?? "DESKTOP_CLOUD_PROJECT_UNAVAILABLE"; return report; }
    let rows;
    try { rows = await catalog(api, environment); report.assignment_api.status = "available"; }
    catch (error) { if (error.code === "DESKTOP_CLOUD_PROJECT_PROTOCOL" || error.code === "DESKTOP_CLOUD_PROJECT_BINDING_CHANGED") throw error; report.assignment_api.reason_code = error.code ?? "DESKTOP_CLOUD_PROJECT_UNAVAILABLE"; report.assignment_api.reason = "The actual Cloud environment was not accepted by Desktop's executor-bound API."; }
    let selected;
    if (selector !== undefined) {
      const inventory = rows ?? (await projects()).flatMap(row => (row.desktop_project_ids ?? []).map(legacy => ({ ...row, canonical_project_id: row.project_id, project_id: legacy })));
      const matches = inventory.filter(row => row.project_id === selector || row.canonical_project_id === selector || row.name === selector);
      if (matches.length !== 1) throw failure("Select exactly one Desktop project ID or exact name.", "PROJECT_NOT_FOUND"); selected = matches[0];
      report.selected_project = selected;
    }
    const state = await readState(api.paths.home, id);
    report.membership = { status: state.assignment?.projectKind === "local" ? (state.host_id === "durable" ? "registered" : "recorded_host_unverified") : state.projectless ? "projectless" : "source_unknown",
      project_id: state.assignment?.projectId ?? null, host_id: state.host_id, source: "read-only-desktop-profile-state" };
    if (selected) report.membership.matches_selected_project = state.assignment?.projectKind === "local" && state.assignment.projectId === selected.project_id && state.host_id === "durable";
    return report;
  } finally { try { client?.close(); } catch { /* Preserve diagnostics. */ } }
}
export async function assignDesktopCloudProject(target, selector, { connect = connectDesktopCloud, discoverApi = discoverProjectApi, catalog = catalogOnApi,
  call = nativeRpc, check = current, readState = readDesktopProjectState, ...storage } = {}) {
  const id = desktopCloudId(target);
  if (typeof selector !== "string" || !selector.trim()) throw failure("--project is required.", "PROJECT_REQUIRED");
  return withStoreLock(`desktop-cloud-project-${id}`, async () => {
    if ((await listRecords("desktop-cloud-projects", storage)).some(row => row.thread_id === id && row.delivery_status === "unknown")) throw failure("An earlier assignment is unknown. Inspect its receipt; do not replay it.", "DESKTOP_CLOUD_PROJECT_PENDING");
    let client, receipt, api, dispatching = false;
    try {
      client = await connect(); const environmentId = await targetEnvironment(client, id); api = await discoverApi();
      if (api.paths.home !== (storage.home ?? codexHome())) throw failure("Desktop project profile does not match the CLI profile.", "DESKTOP_CLOUD_PROJECT_BINDING_CHANGED");
      const rows = await catalog(api, environmentId), matches = rows.filter(row => row.project_id === selector || row.name === selector);
      if (matches.length !== 1) throw failure("Select one project returned by the signed catalog.", "PROJECT_NOT_FOUND");
      const selected = matches[0], attempt = randomUUID();
      receipt = { schema: 1, type: "desktop-cloud-project", attempt_id: attempt, thread_id: id, environment_id: environmentId, project_id: selected.project_id,
        delivery_status: "not_sent", verification_status: "unverified", receipt_path: storePath("desktop-cloud-projects", attempt, storage.home) };
      await writeRecord("desktop-cloud-projects", attempt, receipt, storage); await check(api);
      if (await targetEnvironment(client, id) !== environmentId) throw failure("Task environment changed before assignment.", "DESKTOP_CLOUD_PROJECT_BINDING_CHANGED");
      const params = { environmentId, projectId: selected.project_id, threadId: desktopCloudUuid(id), nonce: randomBytes(32).toString("hex") };
      receipt.delivery_status = "unknown"; await writeRecord("desktop-cloud-projects", attempt, receipt, storage); dispatching = true;
      const response = await call(api.endpoint, { jsonrpc: "2.0", id: randomUUID(), method: "taskProject/assign", params });
      const assigned = verifyProjectReply(response, "taskProject/assign", params, api.key);
      if (!isDeepStrictEqual(assigned, { environmentId, projectId: selected.project_id, threadId: desktopCloudUuid(id) })) throw failure("Assignment response target did not match.", "DESKTOP_CLOUD_PROJECT_PROTOCOL", true);
      receipt.delivery_status = "accepted"; receipt.proof_sha256 = sha(response.payload);
      await writeRecord("desktop-cloud-projects", attempt, receipt, storage); await check(api);
      const stored = await readState(api.paths.home, id);
      receipt.verification_status = stored.assignment?.projectKind === "local" && stored.assignment.projectId === selected.project_id && stored.host_id === "durable" ? "verified" : "not_observed";
      await writeRecord("desktop-cloud-projects", attempt, receipt, storage); return receipt;
    } catch (error) {
      if (receipt) {
        if (receipt.delivery_status !== "accepted") receipt.delivery_status = dispatching && ![-32601, -32602].includes(error.rpcCode) ? "unknown" : "not_sent";
        try { await writeRecord("desktop-cloud-projects", receipt.attempt_id, { ...receipt, error_code: error.code ?? "DESKTOP_CLOUD_PROJECT_UNAVAILABLE" }, storage); } catch { error.receipt_update_required = true; }
        Object.assign(error, { attempt_id: receipt.attempt_id, receipt_path: receipt.receipt_path, delivery_status: receipt.delivery_status, uncertain: receipt.delivery_status === "unknown" });
      }
      throw error;
    } finally { try { client?.close(); } catch { /* Preserve diagnostics. */ } }
  }, storage);
}
export async function desktopCloudProjectReceipt(attempt, storage = {}) {
  if (typeof attempt !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt)) throw failure("Invalid assignment attempt ID.");
  const row = await readRecord("desktop-cloud-projects", attempt, storage);
  if (!row || row.type !== "desktop-cloud-project" || row.attempt_id !== attempt) throw failure("Assignment receipt not found."); return row;
}
