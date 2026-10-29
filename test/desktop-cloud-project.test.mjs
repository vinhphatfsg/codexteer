import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverProjectApi, verifyProjectReply, validateProjectCatalog, readDesktopProjectState, assignDesktopCloudProject, desktopCloudProjectDoctor, desktopCloudProjectReceipt } from "../src/desktop-cloud-project.mjs";
import { BUNDLED_NODE } from "../src/wrapper.mjs";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", id = `durable_${uuid}`, environment = "ccarenv_fixture", project = "fixture-project";
const pair = generateKeyPairSync("ed25519");
const signed = (method, params, body) => { const payload = JSON.stringify({ domain: `codex.${method.replace("/", ".")}.v1`, request: params, [method === "taskProject/list" ? "catalog" : "project"]: body }); return { payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString("base64") }; };
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "desktop-cloud-project-")); t.after(() => rm(home, { recursive: true, force: true }));
  const api = { paths: { home, socket: "fixture" }, state: { pid: 42, instance: "fixture" }, endpoint: { socketPath: "fixture" }, key: pair.publicKey };
  const calls = [], deps = { home, discoverApi: async () => api, check: async () => {},
    connect: async () => ({ request: async () => ({ thread: { id, environments: [{ environmentId: environment }] } }), close() {} }),
    catalog: async (_api, env) => { assert.equal(env, environment); return [{ project_id: project, name: "Fixture", roots: ["/workspace/example"] }]; },
    call: async (_endpoint, request) => { calls.push(request); return signed(request.method, request.params, { environmentId: environment, projectId: project, threadId: uuid }); },
    readState: async () => ({ assignment: { projectKind: "local", projectId: project }, host_id: "durable", projectless: false }) };
  return { home, api, calls, deps };
}
test("signed project replies bind method, nonce, environment, thread and destination", () => {
  const params = { environmentId: environment, projectId: project, threadId: uuid, nonce: "a".repeat(64) };
  const response = signed("taskProject/assign", params, { environmentId: environment, projectId: project, threadId: uuid });
  assert.equal(verifyProjectReply(response, "taskProject/assign", params, pair.publicKey).projectId, project);
  for (const changed of [{ ...params, nonce: "b".repeat(64) }, { ...params, environmentId: "another" }, { ...params, threadId: "another" }, { ...params, projectId: "another" }]) assert.throws(() => verifyProjectReply(response, "taskProject/assign", changed, pair.publicKey));
  assert.throws(() => verifyProjectReply(response, "taskProject/list", params, pair.publicKey));
  assert.throws(() => verifyProjectReply({ ...response, payload: response.payload + " " }, "taskProject/assign", params, pair.publicKey));
});
test("catalog validation rejects another executor, duplicate identities and relative roots", () => {
  const row = { projectId: project, name: "Fixture", rootPaths: ["/workspace/example"] };
  assert.equal(validateProjectCatalog({ environmentId: environment, projects: [row] }, environment).length, 1);
  for (const value of [{ environmentId: "other", projects: [row] }, { environmentId: environment, projects: [row, row] }, { environmentId: environment, projects: [{ ...row, rootPaths: ["../outside"] }] }]) assert.throws(() => validateProjectCatalog(value, environment));
});
test("discovery uses one owner-validated process, a matching endpoint and its public key only", async () => {
  const encoded = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"), calls = [];
  const options = { discover: async () => ({ paths: { home: "/example" }, state: { pid: 42, node_path: BUNDLED_NODE } }), endpoint: async () => ({ socketPath: "/example/native" }),
    run: (_command, argv) => { calls.push(argv); return { status: 0, stdout: argv.includes("uid=") ? `${process.getuid()} ${BUNDLED_NODE}` : `SECRET=DO_NOT_EMIT CODEX_APP_TOOLS_PIPE_PATH=/example/native CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY=${encoded}` }; } };
  const api = await discoverProjectApi(options); assert.equal(api.key.asymmetricKeyType, "ed25519"); assert.doesNotMatch(JSON.stringify(api), /DO_NOT_EMIT|SECRET=|CODEX_TASK_WORKSPACE/); assert.equal(calls.length, 2);
  await assert.rejects(discoverProjectApi({ ...options, run: () => ({ status: 0, stdout: `0 /untrusted/node` }) }));
  await assert.rejects(discoverProjectApi({ ...options, endpoint: async () => ({ socketPath: "/another/native" }) }));
});
test("assignment uses the actual environment and verifies persisted membership without a caller turn", async t => {
  const f = await fixture(t); const result = await assignDesktopCloudProject(id, "Fixture", f.deps);
  assert.equal(result.delivery_status, "accepted"); assert.equal(result.verification_status, "verified"); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "taskProject/assign"); assert.equal(f.calls[0].params.environmentId, environment); assert.equal(f.calls[0].params.threadId, uuid);
  for (const field of ["callerSource", "turnId", "hostId"]) assert(!Object.hasOwn(f.calls[0].params, field));
  assert.equal((await desktopCloudProjectReceipt(result.attempt_id, { home: f.home })).project_id, project);
});
test("an executor mismatch or missing catalog stops before assignment and never substitutes a local environment", async t => {
  const f = await fixture(t);
  await assert.rejects(assignDesktopCloudProject(id, "Fixture", { ...f.deps, catalog: async (_api, actual) => { assert.equal(actual, environment); throw Object.assign(Error("not ready"), { code: "DESKTOP_CLOUD_PROJECT_UNAVAILABLE" }); } }));
  assert.equal(f.calls.length, 0);
});
test("lost or invalid acknowledgement reserves the target against another assignment", async t => {
  const f = await fixture(t);
  await assert.rejects(assignDesktopCloudProject(id, project, { ...f.deps, call: async () => { throw Object.assign(Error("disconnected"), { uncertain: true }); } }), error => error.delivery_status === "unknown" && !!error.attempt_id);
  await assert.rejects(assignDesktopCloudProject(id, project, { ...f.deps, connect: () => assert.fail("no replay") }), { code: "DESKTOP_CLOUD_PROJECT_PENDING" });
});
test("parameter rejection is not_sent and accepted assignment does not certify a different persisted host", async t => {
  const f = await fixture(t);
  await assert.rejects(assignDesktopCloudProject(id, project, { ...f.deps, call: async () => { throw Object.assign(Error("rejected"), { rpcCode: -32602 }); } }), error => error.delivery_status === "not_sent");
  const result = await assignDesktopCloudProject(id, project, { ...f.deps, readState: async () => ({ assignment: { projectKind: "local", projectId: project }, host_id: "local" }) });
  assert.equal(result.delivery_status, "accepted"); assert.equal(result.verification_status, "not_observed");
});
test("doctor distinguishes recorded membership, unknown source and unavailable registration", async t => {
  const f = await fixture(t), deps = { ...f.deps, catalog: async () => { throw Object.assign(Error("unavailable"), { code: "DESKTOP_CLOUD_PROJECT_UNAVAILABLE" }); }, projects: async () => [{ project_id: "canonical", desktop_project_ids: [project], name: "Fixture", roots: ["/workspace/example"] }] };
  const result = await desktopCloudProjectDoctor(id, "Fixture", deps); assert.equal(result.assignment_api.status, "unavailable"); assert.equal(result.membership.status, "registered"); assert.equal(result.membership.matches_selected_project, true);
  const unknown = await desktopCloudProjectDoctor(id, undefined, { ...deps, readState: async () => ({ assignment: null, projectless: false, host_id: null }) }); assert.equal(unknown.membership.status, "source_unknown");
});
test("profile membership inspection is read-only and refuses symlinks and writable shared state", async t => {
  const f = await fixture(t), file = path.join(f.home, ".codex-global-state.json"), data = JSON.stringify({ "thread-project-assignments": { [uuid]: { projectKind: "local", projectId: project } }, "thread-project-membership-host-ids": { [uuid]: "durable" } });
  await writeFile(file, data, { mode: 0o600 }); assert.equal((await readDesktopProjectState(f.home, id)).host_id, "durable");
  await chmod(file, 0o666); await assert.rejects(readDesktopProjectState(f.home, id)); await rm(file); await writeFile(path.join(f.home, "state.json"), data); await symlink(path.join(f.home, "state.json"), file); await assert.rejects(readDesktopProjectState(f.home, id));
});

test("managed supervisors cannot reassign projects and doctor requires a target for project checks", async t => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const f = await fixture(t), run = promisify(execFile), cli = new URL("../bin/codexteer.mjs", import.meta.url).pathname;
  for (const [args, code] of [[["--connection", "desktop-cloud", "--supervisor", "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", "thread", "assign", id, "--project", project], "SUPERVISOR_CONTROL_FORBIDDEN"], [["--connection", "desktop-cloud", "doctor", "--project", project], "CLOUD_OPTIONS_INVALID"]]) {
    let result; try { result = await run(process.execPath, [cli, ...args, "--json"], { env: { ...process.env, CODEX_HOME: f.home, PATH: "/no-official-cli" } }); } catch (error) { result = error; }
    const response = JSON.parse(result.stdout); assert.equal(response.ok, false); assert.equal(response.error.code, code);
  }
});
