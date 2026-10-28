import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseThreadTarget, normalizeThreadId, threadDeepLink } from "../src/thread-id.mjs";
import { withTarget, targetHost } from "../src/target.mjs";
import { readSnapshot, decodeCursor, observeThread } from "../src/observe.mjs";
import { remoteReadClient, remoteObservationConnection, validateRemoteCatalog } from "../src/remote.mjs";
import { registeredRemoteProjects } from "../src/projects.mjs";
import { registerSupervisor, controlSupervisor, supervisorStatus, withSupervisedSend } from "../src/supervision.mjs";
import { readRecord, writeRecord, storePath } from "../src/store.mjs";
import { nativeRequest } from "../src/native-rpc.mjs";
import { prepareSupervisorPrompt } from "../src/supervise.mjs";
import { streamThread } from "../src/monitor.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", CALLER = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const HOST = "remote-control:env_remote", LINK = `codex://threads/${ID}?hostId=${encodeURIComponent(HOST)}`;
const task = () => ({ id: ID, status: { type: "idle" }, turns: [{ id: "one", status: "completed", items: [{ type: "agentMessage", id: "a", text: "回答" }] }] });
const catalog = { tools: [{ namespace: "codex_app", name: "read_thread", inputSchema: { properties: {
  threadId: { type: "string" }, hostId: { type: "string" }, cursor: { type: "string" }, turnLimit: { maximum: 10 }, includeOutputs: { type: "boolean" }, maxOutputCharsPerItem: { maximum: 20000 },
} } }] };
const page = (turns = task().turns, nextCursor = null, host = HOST) => ({ thread: { id: ID, hostId: host, kind: "codex", title: "remote task", cwd: "C:\\work", status: { type: "idle" } },
  page: { order: "newest_first", hasMore: nextCursor !== null, nextCursor }, turns });
async function temp(t) { const home = await mkdtemp("/private/tmp/ct-remote-"); t.after(() => rm(home, { recursive: true, force: true })); return home; }
function cli(args, env = {}) { const r = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { encoding: "utf8", env: { ...process.env, ...env } }); return { status: r.status, ...JSON.parse(r.stdout) }; }

test("host links preserve encoded routing and cannot silently normalize to local", async () => {
  assert.deepEqual(parseThreadTarget(LINK), { threadId: ID, hostId: HOST });
  assert.equal(new URL(threadDeepLink(LINK)).searchParams.get("hostId"), HOST);
  assert.throws(() => normalizeThreadId(LINK), { code: "HOST_MISMATCH" });
  assert.throws(() => parseThreadTarget(`${LINK}&hostId=local`));
  for (const host of ["", "../local", "x\nlocal"]) assert.throws(() => parseThreadTarget(`codex://threads/${ID}?hostId=${encodeURIComponent(host)}`));
  await Promise.all([withTarget(HOST, undefined, async () => { await Promise.resolve(); assert.equal(normalizeThreadId(LINK), ID); assert.equal(targetHost(), HOST); }),
    withTarget("another", undefined, async () => { await Promise.resolve(); assert.throws(() => normalizeThreadId(LINK), { code: "HOST_MISMATCH" }); })]);
  assert.equal(targetHost(), "local");
});

test("same UUID on three hosts has separate cursors, supervisors and pause controls", async t => {
  const home = await temp(t), session = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003", localCursor = readSnapshot(task()).cursor;
  await registerSupervisor(ID, session, { home });
  await writeRecord("messages", "message", { thread_id: ID, value: "local" }, { home });
  let remoteCursor;
  await withTarget(HOST, CALLER, async () => {
    assert.throws(() => decodeCursor(localCursor, ID), { code: "STALE_CURSOR" });
    remoteCursor = readSnapshot(task()).cursor;
    assert.equal(decodeCursor(remoteCursor, ID).host_id, HOST);
    assert.equal(await readRecord("messages", "message", { home }), null);
    await registerSupervisor(ID, session, { home });
    await controlSupervisor(ID, "pause", { home });
    assert.equal((await supervisorStatus(ID, { home })).state, "paused");
    assert.equal((await supervisorStatus(ID, { home })).host_id, HOST);
    assert.match(storePath("supervisors", ID, home), /\/hosts\/[a-f0-9]{64}\//);
    await assert.rejects(withSupervisedSend(ID, session, () => assert.fail("must not send"), { home }), { code: "REMOTE_READ_ONLY" });
  });
  assert.equal((await supervisorStatus(ID, { home })).state, "active");
  assert.throws(() => decodeCursor(remoteCursor, ID), { code: "STALE_CURSOR" });
  await withTarget("another", undefined, async () => {
    assert.equal((await supervisorStatus(ID, { home })).state, "unregistered");
    assert.throws(() => decodeCursor(remoteCursor, ID), { code: "STALE_CURSOR" });
  });
});

test("remote native reads drain every history page and project safe command output", async () => {
  const calls = [], newest = { id: "two", status: "completed", items: [{ id: "cmd", type: "commandExecution", command: "check", status: "completed", output: { text: "result", truncated: true } }] };
  const client = remoteReadClient(async (action, args) => { calls.push({ action, args }); return args.cursor ? page(task().turns) : page([newest], "older"); }, HOST);
  const deps = { discover: async () => ({ paths: { socket: "test" } }), connect: async () => client };
  const read = await withTarget(HOST, CALLER, () => observeThread(ID, { includeOutput: true }, deps));
  assert.deepEqual(read.events.map(e => e.id), ["one", "a", "two", "cmd"]);
  assert.equal(read.events.at(-1).output, "result\n[truncated by Desktop]");
  assert.equal(read.host_id, HOST);
  assert.equal(read.history_scope, "desktop-native-public-history");
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.action === "read_thread" && c.args.hostId === HOST && c.args.threadId === ID));
  await assert.rejects(client.request("turn/start", { threadId: ID }, { mutation: true }), { code: "REMOTE_READ_ONLY" });
});

test("remote reads reject other hosts, incomplete or repeating pages, with no local fallback", async () => {
  for (const result of [page(task().turns, null, "local"), { ...page(), turns: undefined }, page([{ id: "one", status: "completed" }])]) {
    const c = remoteReadClient(async () => result, HOST);
    await assert.rejects(c.request("thread/read", { threadId: ID, includeTurns: true }));
  }
  const c = remoteReadClient(async () => page(task().turns, "same"), HOST);
  await assert.rejects(c.request("thread/read", { threadId: ID, includeTurns: true }), { code: "OBSERVATION_CHANGED" });
  assert.throws(() => validateRemoteCatalog({ tools: [] }), { code: "REMOTE_READ_UNSUPPORTED" });
  validateRemoteCatalog(catalog);
});

test("remote connection authenticates a real local caller and closes on schema failure", async () => {
  const state = { instance: "runtime" }, paths = { socket: "test", home: "test" };
  let closed = 0, calls = [];
  const dependencies = { discover: async () => ({ paths, state }), connect: async () => ({ close() { closed++; } }), endpoint: async () => ({}), inspectCommand: async () => ({}),
    caller: async (_client, id) => ({ id, turns: [{ id: "actual-turn" }] }),
    native: async (_client, _endpoint, action, args, context) => { calls.push({ action, args, context }); return action === "catalog" ? catalog : { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(page()) }] }; } };
  const connection = remoteObservationConnection({ hostId: HOST, contextThread: CALLER }, dependencies);
  await connection.discover();
  const client = await connection.connect("test");
  await client.request("thread/read", { threadId: ID }); client.close();
  assert.equal(closed, 1);
  assert.deepEqual(calls.at(-1).context, { threadId: CALLER, turnId: "actual-turn" });
  assert.equal(calls.at(-1).args.hostId, HOST);
  const invalid = remoteObservationConnection({ hostId: HOST, contextThread: LINK }, dependencies);
  await assert.rejects(invalid.discover(), { code: "REMOTE_CONTEXT_INVALID" });
  const bad = remoteObservationConnection({ hostId: HOST, contextThread: CALLER }, { ...dependencies, native: async () => ({ tools: [] }) });
  await bad.discover(); await assert.rejects(bad.connect("test"), { code: "REMOTE_READ_UNSUPPORTED" });
  assert.equal(closed, 2);
  const controller = new AbortController();
  const cancellable = remoteObservationConnection({ hostId: HOST, contextThread: CALLER }, dependencies);
  await cancellable.discover(); const remote = await cancellable.connect("test", { signal: controller.signal });
  controller.abort(); remote.close();
  assert.equal(closed, 3);
  const timed = remoteObservationConnection({ hostId: HOST, contextThread: CALLER }, { ...dependencies,
    native: async (...args) => { if (args[2] === "catalog") return catalog; throw Object.assign(new Error("read timeout"), { code: "NATIVE_TIMEOUT" }); },
  });
  await timed.discover(); const timeoutClient = await timed.connect("test");
  await assert.rejects(timeoutClient.request("thread/read", { threadId: ID }), { code: "TIMEOUT", uncertain: false });
  timeoutClient.close();
});

test("remote native reads are allowlisted without arbitrary tools or argument overrides", () => {
  const context = { threadId: CALLER, turnId: "actual-turn" }, args = { threadId: ID, hostId: HOST, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 };
  assert.equal(nativeRequest("read_thread", args, context).params.hostId, "local");
  assert.equal(nativeRequest("read_thread", args, context).params.arguments.hostId, HOST);
  assert.throws(() => nativeRequest("send_message_to_thread", { ...args, prompt: "never" }, context));
  assert.throws(() => nativeRequest("read_thread", { ...args, turnLimit: 1000 }, context));
  assert.throws(() => nativeRequest("read_thread", { ...args, unexpected: true }, context));
});

test("registered remote projects preserve remote paths and label offline availability honestly", async t => {
  const home = await temp(t), file = `${home}/.codex-global-state.json`, project = { id: "project", hostId: HOST, label: "Windows", remotePath: "C:\\work\\報告" };
  await writeFile(file, JSON.stringify({ "remote-projects": [project], secret: "must not leak" }), { mode: 0o600 });
  const projects = await registeredRemoteProjects(home);
  assert.equal(projects[0].roots[0], project.remotePath);
  assert.equal(projects[0].availability, "unverified");
  assert.equal(JSON.stringify(projects).includes("secret"), false);
  const result = cli(["projects", "list", "--host", HOST], { CODEX_HOME: home });
  assert.equal(result.ok, true); assert.equal(result.data.count, 1);
  assert.equal(cli(["projects", "list", "--remote"], { CODEX_HOME: home }).data.count, 1);
  await writeFile(file, JSON.stringify({ "remote-projects": [project, project] }));
  await assert.rejects(registeredRemoteProjects(home), /Duplicate/);
  await chmod(file, 0o666); await assert.rejects(registeredRemoteProjects(home), { code: "PROJECT_REGISTRY_UNSAFE" });
});

test("CLI preserves link host, rejects conflicting routes and all remote mutations before access", () => {
  const resolved = cli(["thread", "resolve", LINK]);
  assert.equal(resolved.data.host_id, HOST);
  assert.equal(new URL(resolved.data.deep_link).searchParams.get("hostId"), HOST);
  assert.equal(cli(["--host", "different", "read", LINK]).error.code, "HOST_MISMATCH");
  assert.equal(cli(["--connection", "desktop", "read", LINK]).error.code, "HOST_CONNECTION_MISMATCH");
  for (const args of [["send", LINK, "never", "--dry-run"], [LINK, "never"], ["thread", "repair", LINK, "--apply"], ["--host", HOST, "thread", "create", "--project", "p", "never"], ["instructions", "retract", LINK, "message", "--reason", "never"]]) {
    assert.equal(cli(args).error.code, "REMOTE_READ_ONLY");
  }
});

test("remote supervisor prompt pins host and caller in every command and excludes sending", async () => {
  const prompt = await withTarget(HOST, CALLER, () => prepareSupervisorPrompt(ID, undefined, { usePathCli: true }));
  assert.equal(prompt.observation_only, true);
  assert.equal(prompt.host_id, HOST);
  assert(prompt.prompt.includes("--host 'remote-control:env_remote' --remote-transport native --context-thread '" + CALLER + "'"));
  assert(!prompt.prompt.includes(` send ${ID}`));
  const result = cli(["--context-thread", CALLER, "supervise", "prompt", LINK, "--use-path-cli"]);
  assert.equal(result.ok, true); assert.equal(result.data.host_id, HOST);
});

test("saved remote prompt renderer preserves host restrictions across module copies", async t => {
  const home = await temp(t);
  const result = cli(["--context-thread", CALLER, "supervise", "prompt", LINK], { CODEX_HOME: home });
  assert.equal(result.ok, true);
  assert.equal(result.data.observation_only, true);
  assert.equal(result.data.host_id, HOST);
  assert(result.data.prompt.includes(`対象ホスト: ${HOST}`));
  assert(!result.data.prompt.includes(` send ${ID}`));
  assert(!result.data.prompt.includes("必要最小限の軌道修正と、その結果の確認を委任"));
});

test("remote agent launch registers and stops only the selected host's supervisor", async t => {
  const home = await temp(t), bin = `${home}/bin`;
  await mkdir(bin);
  await writeFile(`${bin}/codex`, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({prompt: process.argv.at(-1)}));\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["bin/codexteer.mjs", "--host", HOST, "--context-thread", CALLER, "supervise", ID, "--agent", "codex", "--use-path-cli"], {
    encoding: "utf8", env: { ...process.env, CODEX_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const { prompt } = JSON.parse(result.stdout);
  assert(prompt.includes(`対象ホスト: ${HOST}`)); assert(!prompt.includes(` send ${ID}`));
  assert.equal((await supervisorStatus(ID, { home })).state, "unregistered");
  await withTarget(HOST, CALLER, async () => assert.equal((await supervisorStatus(ID, { home })).state, "stopped"));
});

test("remote streaming retains host in connection notifications and drains changes", async () => {
  const controller = new AbortController(), snapshots = task(), lines = [];
  await withTarget(HOST, CALLER, () => streamThread(ID, { signal: controller.signal, notify: "all" }, async data => { lines.push(data); }, {
    discover: async () => ({ paths: { socket: "test" } }), connect: async () => ({ close() {}, request: async () => ({ thread: structuredClone(snapshots) }) }),
    sleep: async () => { if (snapshots.turns[0].items.length === 1) snapshots.turns[0].items.push({ id: "b", type: "agentMessage", text: "changed" }); else controller.abort(); },
  }));
  assert.equal(lines[0].host_id, HOST);
  assert.equal(lines[1].host_id, HOST);
  assert.equal(lines[1].events[0].text, "changed");
});
