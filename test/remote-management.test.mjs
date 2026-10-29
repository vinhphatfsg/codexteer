import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { withTarget } from "../src/target.mjs";
import { readRecord } from "../src/store.mjs";
import { validateControlRequest } from "../src/remote-control.mjs";
import { listRemoteThreads, remoteProjectsOnClient, createRemoteProjectThread, verifyRemoteProjectThread, ensureRemoteDesktopSubscription } from "../src/remote-management.mjs";
import { remoteCaptureInputs, remoteFingerprintFile, remoteWatchInputs, runRemoteCommand, runRemoteShellCommand, remoteShellScript } from "../src/remote-io.mjs";
import { spawnSync } from "node:child_process";

const HOST = "remote-control:env_fixture", ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const scope = fn => withTarget(HOST, SOURCE, fn, { transport: "paired" });
const adapter = client => ({ route: () => ({ discover: async () => ({ paths: { socket: "fake", home: "/unused" } }), connect: async () => client }) });

test("remote task discovery pages through Desktop filtering and retains remote IDs and links", () => scope(async () => {
  const calls = [], client = { close() {}, async request(method, args) {
    calls.push({ method, args }); assert.equal(method, "thread/list"); assert.equal(args.useStateDbOnly, true);
    return calls.length === 1 ? { data: [{ id: SOURCE, originator: "cli" }], nextCursor: "page2" }
      : { data: [{ id: ID, name: "remote test", originator: "Codex Desktop", projectId: "canonical", cwd: "C:\\test" }], nextCursor: "page3" };
  } };
  const result = await listRemoteThreads({ limit: 1, desktopOnly: true, projectId: "canonical", search: "test" }, adapter(client));
  assert.equal(result.threads[0].thread_id, ID); assert.equal(result.threads[0].host_id, HOST);
  assert(result.threads[0].deep_link.includes("hostId=remote-control%3Aenv_fixture"));
  assert.equal(result.next_cursor, "page3"); assert.equal(result.has_more, true);
  assert.equal(calls[1].args.cursor, "page2"); assert.equal(calls[1].args.projectId, "canonical");
  await assert.rejects(listRemoteThreads({ limit: 2 }, adapter({ close() {}, request: async () => ({ data: [{ id: ID }], nextCursor: "repeat" }) })), { code: "REMOTE_PROTOCOL_ERROR" });
}));

test("live project discovery preserves Windows roots and rejects cursor/identity corruption", () => scope(async () => {
  const project = { id: "canonical", name: "live", roots: [{ path: "\\\\host\\share\\workspace" }] };
  assert.deepEqual(await remoteProjectsOnClient({ request: async () => ({ data: [project], nextCursor: null }) }), [project]);
  await assert.rejects(remoteProjectsOnClient({ request: async () => ({ data: [{ ...project, roots: [{ path: "relative" }] }] }) }), { code: "REMOTE_PROTOCOL_ERROR" });
  await assert.rejects(remoteProjectsOnClient({ request: async () => ({ data: [project], nextCursor: "repeat" }) }), { code: "REMOTE_PROTOCOL_ERROR" });
}));

async function creationFixture(t, { wrongHost = false, unknown = false, assignedProject = null } = {}) {
  const home = await mkdtemp("/private/tmp/ct-remote-create-"); t.after(() => rm(home, { recursive: true, force: true }));
  const prompt = "fixture initial instruction", title = "fixture test", project = { id: "canonical", name: "Live name", roots: [{ path: "C:\\test" }] };
  const saved = { project_id: "desktop", name: "Desktop label", host_id: HOST, roots: ["C:\\test"] };
  let thread = { id: ID, projectId: assignedProject, cwd: "C:\\test", name: title, turns: [{ id: "first", status: "completed", items: [{ id: "initial", type: "functionCallOutput", namespace: "codex_app", name: "create_thread", output: `<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>` }] }], environments: [{ environmentId: "local", runtimeWorkspaceRoots: ["C:\\test"] }] };
  const nativeCalls = [], rawCalls = [];
  const listSchema = { type: "object", properties: { limit: { type: "number", maximum: 50 } } };
  const session = { context: { threadId: SOURCE, turnId: "source-turn" }, close() {}, catalog: { tools: [
    { name: "list_threads", namespace: "codex_app", inputSchema: listSchema }, { name: "list_projects", namespace: "codex_app", inputSchema: { type: "object" } },
    { name: "create_thread", namespace: "codex_app", inputSchema: { required: ["prompt", "target"], properties: { prompt: { type: "string" }, target: { anyOf: [{ required: ["projectId"], properties: { type: { enum: ["project"] }, projectId: { type: "string" }, environment: { anyOf: [{ properties: { type: { enum: ["local"] } } }] } } }] } } } },
  ] }, async invoke(action, args) {
    nativeCalls.push({ action, args });
    if (action === "create_thread") { if (unknown) throw Object.assign(new Error("lost acknowledgement"), { code: "NATIVE_TIMEOUT", uncertain: true }); return { threadId: ID, hostId: wrongHost ? "remote-control:env_other" : HOST }; }
    assert.equal(action, "list_threads"); return { threads: [{ id: ID, hostId: HOST, projectId: "desktop" }], pinnedThreads: [] };
  } };
  const client = { close() {}, async request(method, args) { rawCalls.push({ method, args });
    if (method === "project/list") return { data: [project], nextCursor: null };
    if (method === "thread/metadata/update") { thread.projectId = args.projectId; return {}; }
    assert.equal(method, "thread/read"); return { thread: structuredClone(thread) };
  } };
  return { prompt, title, home, thread, project, saved, nativeCalls, rawCalls, dependencies: { registry: async () => [saved], desktop: async () => session,
    route: () => ({ discover: async () => ({ paths: { socket: "fake", home } }), connect: async () => client }) } };
}

function fixturePaths(f, projectRoot, savedRoot = projectRoot, cwd = projectRoot, roots = [projectRoot]) {
  f.project.roots = [{ path: projectRoot }]; f.saved.roots = [savedRoot];
  f.thread.cwd = cwd; f.thread.environments[0].runtimeWorkspaceRoots = roots;
}

test("POSIX remote project mapping and scope preserve case while Windows paths remain insensitive", t => scope(async () => {
  const wrong = await creationFixture(t); fixturePaths(wrong, "/srv/project", "/srv/Project");
  await assert.rejects(createRemoteProjectThread("desktop", wrong.prompt, { dryRun: true }, wrong.dependencies), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(createRemoteProjectThread("canonical", wrong.prompt, { dryRun: true }, wrong.dependencies), { code: "DESKTOP_PROJECT_MAPPING_UNVERIFIED" });
  assert.equal(wrong.nativeCalls.length, 0);
  for (const [a, b] of [["C:\\Projects\\Example", "c:/projects/example"], ["\\\\HOST\\Share\\Example", "\\\\host\\share\\example"]]) {
    const f = await creationFixture(t); fixturePaths(f, a, b);
    assert.equal((await createRemoteProjectThread("desktop", f.prompt, { dryRun: true }, f.dependencies)).project_id, "canonical");
  }
  const cwd = await creationFixture(t); fixturePaths(cwd, "/srv/Project", "/srv/Project", "/srv/project");
  await assert.rejects(createRemoteProjectThread("canonical", cwd.prompt, { title: cwd.title }, cwd.dependencies), { code: "CREATION_SCOPE_MISMATCH" });
  const artifact = await creationFixture(t); fixturePaths(artifact, "/srv/Project", "/srv/Project", "/srv/Project",
    ["/srv/Project", `/home/example/visualizations/2026/10/28/${ID}`]);
  artifact.thread.path = "/home/example/sessions/2026/10/28/fixture.jsonl";
  assert.equal((await createRemoteProjectThread("canonical", artifact.prompt, { title: artifact.title }, artifact.dependencies)).verification_status, "verified");
}));

test("failed remote reverification revokes stale flags while preserving accepted creation", t => scope(async () => {
  const f = await creationFixture(t), prior = process.env.CODEX_HOME; process.env.CODEX_HOME = f.home;
  try {
    const created = await createRemoteProjectThread("canonical", f.prompt, { title: f.title }, f.dependencies);
    const mutations = () => f.nativeCalls.filter(c => c.action === "create_thread").length + f.rawCalls.filter(c => c.method === "thread/metadata/update").length;
    const before = mutations(); f.thread.projectId = "moved";
    await assert.rejects(verifyRemoteProjectThread(created.attempt_id, { timeoutMs: 1 }, f.dependencies), error => error.code === "CREATION_VERIFICATION_FAILED" && error.sent === true);
    const failed = await readRecord("creations", created.attempt_id, { home: f.home });
    assert.equal(failed.verification_status, "failed"); assert.equal(failed.creation_status, "created"); assert.equal(failed.delivery_status, "accepted");
    for (const key of ["desktop_project_membership", "app_server_project_membership", "initial_instruction", "observed_runtime_workspace_roots"]) assert.equal(Object.hasOwn(failed, key), false);
    assert.equal(failed.verification_history.at(-1).status, "failed"); assert.equal(mutations(), before);
    f.thread.projectId = "canonical";
    const recovered = await verifyRemoteProjectThread(created.attempt_id, { timeoutMs: 1 }, f.dependencies);
    assert.equal(recovered.verification_status, "verified"); assert.equal(Object.hasOwn(recovered, "error_code"), false); assert.equal(mutations(), before);
  } finally { if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior; }
}));

test("remote native creation sends once, verifies both project identities and preserves no-op dry run", t => scope(async () => {
  const f = await creationFixture(t);
  const dry = await createRemoteProjectThread("desktop", f.prompt, { title: f.title, dryRun: true }, f.dependencies);
  assert.equal(dry.sent, false); assert.equal(f.nativeCalls.length, 0);
  const result = await createRemoteProjectThread("canonical", f.prompt, { title: f.title }, f.dependencies);
  assert.equal(result.verification_status, "verified"); assert.equal(result.project_id, "canonical"); assert.equal(result.desktop_project_id, "desktop");
  assert.equal(result.host_id, HOST); assert.equal(f.nativeCalls.filter(c => c.action === "create_thread").length, 1);
  assert.equal(f.nativeCalls[0].args.target.projectId, "desktop");
  const receipt = await readRecord("creations", result.attempt_id, { home: f.home }); assert.equal(receipt.delivery_status, "accepted");
}));

test("wrong-host and lost native creation acknowledgements are never replayed or followed by mutations", t => scope(async () => {
  for (const options of [{ wrongHost: true }, { unknown: true }]) {
    const f = await creationFixture(t, options); let error;
    try { await createRemoteProjectThread("canonical", f.prompt, { title: f.title }, f.dependencies); } catch (e) { error = e; }
    assert(error); assert.equal(f.nativeCalls.filter(c => c.action === "create_thread").length, 1);
    assert.equal(f.rawCalls.filter(c => c.method === "thread/metadata/update").length, 0);
    const receipt = await readRecord("creations", error.attempt_id, { home: f.home });
    assert.equal(receipt.creation_status, options.wrongHost ? "created" : "unknown");
    assert.equal(receipt.delivery_status, "unknown"); if (options.wrongHost) assert.equal(receipt.thread_id, ID);
  }
}));

test("remote creation preserves a known accepted child when its project changed and never overwrites the move", t => scope(async () => {
  const f = await creationFixture(t, { assignedProject: "other-project" });
  await assert.rejects(createRemoteProjectThread("canonical", f.prompt, { title: f.title }, f.dependencies), error => error.code === "PROJECT_CHANGED" && error.creation_status === "created" && error.delivery_status === "accepted" && error.thread_id === ID);
  assert.equal(f.rawCalls.filter(call => call.method === "thread/metadata/update").length, 0);
  assert.equal(f.nativeCalls.filter(call => call.action === "create_thread").length, 1);
}));

test("remote Desktop subscription checks destination host before opening anything", () => scope(async () => {
  const calls = [], session = { catalog: { tools: [{ namespace: "codex_app", name: "navigate_to_codex_page", inputSchema: { properties: { threadId: { type: "string" } } } }] },
    async invoke(action) { calls.push(action); return { threads: [{ id: ID, hostId: "remote-control:env_wrong" }], pinnedThreads: [] }; } };
  await assert.rejects(ensureRemoteDesktopSubscription(ID, { session }), { code: "HOST_MISMATCH" });
  assert.deepEqual(calls, ["list_threads"]);
}));

test("paired management does not allow permission overrides or enable management on the Desktop-key route", () => {
  const command = { command: ["echo", "fixture"], processId: "ours", timeoutMs: 1000 };
  assert.doesNotThrow(() => validateControlRequest("command/exec", command, { management: true }));
  assert.throws(() => validateControlRequest("command/exec", { ...command, sandboxPolicy: { type: "dangerFullAccess" } }, { management: true }), { code: "REMOTE_COMMAND_INVALID" });
  assert.throws(() => validateControlRequest("command/exec", command), { code: "REMOTE_METHOD_UNSUPPORTED" });
  assert.throws(() => validateControlRequest("turn/start", { threadId: ID, input: [], clientUserMessageId: "ours" }, { management: true }), { code: "REMOTE_STEER_INVALID" });
});

test("remote evidence rejects changes and symlinks and snapshots never follow untrusted directory names", () => scope(async () => {
  const file = "C:\\test\\input.txt", info = { isFile: true, isDirectory: false, isSymlink: false, modifiedAtMs: 100, createdAtMs: 1 };
  const client = { request: async method => method === "fs/readFile" ? { dataBase64: Buffer.from("fixture").toString("base64") } : info };
  const snapshot = await remoteCaptureInputs([file], [], { client }); assert.equal(snapshot.files[0].size, 7);
  let n = 0; await assert.rejects(remoteFingerprintFile(file, { request: async method => method === "fs/readFile" ? { dataBase64: "YQ==" } : { ...info, modifiedAtMs: ++n } }), { code: "STALE_EVIDENCE" });
  await assert.rejects(remoteFingerprintFile(file, { request: async () => ({ ...info, isSymlink: true }) }), { code: "REMOTE_SYMLINK_UNSUPPORTED" });
  await assert.rejects(remoteCaptureInputs(["C:\\test"], [], { client: { request: async method => method === "fs/getMetadata" ? { ...info, isFile: false, isDirectory: true } : { entries: [{ fileName: "..\\escape" }] } } }), { code: "REMOTE_FILESYSTEM_ERROR" });
}));

test("remote checkpoint watcher detects edit-and-restore notifications and lost subscriptions", () => scope(async () => {
  const client = new EventEmitter(); let open = true, watchId;
  client.close = () => { open = false; }; client.isOpen = () => open;
  client.request = async (method, args) => { if (method === "fs/watch") { watchId = args.watchId; return { path: args.path }; } return {}; };
  const watch = await remoteWatchInputs({ roots: ["C:\\test"], excludes: [] }, adapter(client));
  client.emit("notification", { method: "fs/changed", params: { watchId, changedPaths: ["C:\\test\\input.txt"] } });
  assert.equal(watch.touched.size, 1); open = false; assert.match(watch.error, /disconnected/); await watch.close();
}));

test("remote commands preserve argv and selected cwd and never execute a local process", () => scope(async () => {
  const calls = [], client = { close() {}, async request(method, args) { calls.push({ method, args }); return { exitCode: 0, stdout: "remote fixture", stderr: "" }; } };
  const result = await runRemoteCommand(["remote-program", "literal & argument"], { cwd: "C:\\test", timeoutMs: 1000 }, adapter(client));
  assert.equal(result.pid, null); assert.equal(result.host_id, HOST); assert.equal(result.output_tail, "remote fixture");
  assert.deepEqual(calls[0].args.command, ["remote-program", "literal & argument"]); assert.equal(calls[0].args.cwd, "C:\\test");
  assert.equal(calls[0].args.sandboxPolicy, undefined);
}));

test("explicit remote shell quotes literal argv and confirms persisted item plus exit marker", () => scope(async () => {
  let command, dispatched = 0;
  const thread = () => ({ id: ID, status: { type: "idle" }, turns: command ? [{ id: "shell-turn", status: "completed", items: [{ id: "shell-item", type: "commandExecution", command,
    status: "completed", exitCode: 7, aggregatedOutput: `fixture output\r\n${command.match(/CODEXTEER_EXEC_[a-f0-9-]{36}/)[0]}:7\r\nstderr after stdout marker\r\n` }] }] : [] });
  const client = { close() {}, async request(method, args) { if (method === "thread/shellCommand") { dispatched++; command = args.command; return {}; } assert.equal(method, "thread/read"); return { thread: thread() }; } };
  const result = await runRemoteShellCommand(["program", "literal '; $(&)"], { threadId: ID, shell: "powershell", timeoutMs: 1000 }, adapter(client));
  assert.equal(dispatched, 1); assert.equal(result.exit_code, 7); assert.equal(result.output_tail, "fixture output\r\nstderr after stdout marker\r\n");
  assert.equal(result.execution_permissions, "host-full-access"); assert(command.includes("'literal ''; $(&)'"));
  const marker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", literal = "a' b $(echo bad) `echo bad` ; & ";
  const script = remoteShellScript(["printf", "%s", literal], { shell: "posix", marker });
  const parsed = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(parsed.status, 0); assert.equal(parsed.stdout, `${literal}\nCODEXTEER_EXEC_${marker}:0\n`);
  assert.throws(() => remoteShellScript(["program"], { marker }), { code: "REMOTE_SHELL_REQUIRED" });
}));

test("remote shell cannot run in an active task and an unknown accepted completion is never replayed", () => scope(async () => {
  let dispatched = 0;
  const client = { close() {}, async request(method) {
    if (method === "thread/shellCommand") { dispatched++; return {}; }
    if (dispatched) throw Object.assign(new Error("read lost"), { code: "CONNECTION_FAILED", uncertain: false });
    return { thread: { id: ID, status: { type: "idle" } } };
  } };
  await assert.rejects(runRemoteShellCommand(["program"], { threadId: ID, shell: "powershell" }, adapter(client)), error => error.uncertain === true);
  assert.equal(dispatched, 1);
  await assert.rejects(runRemoteShellCommand(["program"], { threadId: ID, shell: "powershell" }, adapter({ close() {}, request: async () => ({ thread: { id: ID, status: { type: "active" } } }) })), { code: "REMOTE_SHELL_TASK_BUSY" });
}));

test("refused generic command execution never invokes the full-access shell", () => scope(async () => {
  const methods = [];
  await assert.rejects(runRemoteCommand(["program"], {}, adapter({ close() {}, request: async method => { methods.push(method); throw Object.assign(new Error("rejected"), { code: "RPC_REJECTED", uncertain: false }); } })), { code: "RPC_REJECTED" });
  assert.deepEqual(methods, ["command/exec"]);
}));

test("paired host-specific operations fail explicitly before any local fallback or connection", () => {
  for (const [args, code] of [
    [["desktop", "start"], "REMOTE_HOST_OPERATION_UNSUPPORTED"],
    [["desktop", "update", "--dry-run"], "REMOTE_HOST_OPERATION_UNSUPPORTED"],
    [["desktop", "update-status"], "REMOTE_HOST_OPERATION_UNSUPPORTED"],
    [["thread", "repair", ID], "REMOTE_REPAIR_UNSUPPORTED"],
    [["send", ID, "fixture", "--backend", "ui"], "REMOTE_UI_UNSUPPORTED"],
  ]) {
    const result = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", "--host", HOST, "--remote-transport", "paired", ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: "/nonexistent-remote-fixture" } });
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
});
