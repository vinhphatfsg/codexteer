import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createProjectThread, creationOptions, validateNativeCreationCatalog } from "../src/thread-create.mjs";
import { projectsOnClient, projectWorkspace, resolveProject } from "../src/projects.mjs";
import { initialInstructionMatches } from "../src/creation-verification.mjs";
import { validateStandaloneCreationCatalog } from "../src/standalone-create.mjs";
import { RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";
import { RpcFailure } from "../src/rpc.mjs";

const CHILD = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", CONTEXT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
export const catalog = { tools: [
  { name: "list_projects", namespace: "codex_app", inputSchema: { type: "object" } },
  { name: "move_thread_to_project", namespace: "codex_app", inputSchema: { required: ["threadId", "projectId"], properties: { threadId: { type: "string" }, projectId: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
  { name: "create_thread", namespace: "codex_app", inputSchema: { required: ["prompt", "target"], properties: { prompt: { type: "string" }, target: { anyOf: [{ required: ["projectId"], properties: { type: { enum: ["project"] }, projectId: { type: "string" }, environment: { anyOf: [{ properties: { type: { enum: ["local"] } } }] } } }] } } } },
] };
const result = value => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });

async function fixture(t) {
  const home = await mkdtemp("/private/tmp/ct-create-"); t.after(() => rm(home, { recursive: true, force: true }));
  const roots = [path.join(home, "primary"), path.join(home, "secondary")]; await Promise.all(roots.map(root => mkdir(root)));
  const project = { id: "canonical", name: "サンプル", roots: roots.map(path => ({ path })) }, calls = [], writes = [];
  let canonical;
  const thread = { id: CHILD, name: "検証", cwd: roots[0], environments: [{ environmentId: "local", runtimeWorkspaceRoots: roots }] };
  const nativeProject = { projectId: "desktop", projectKind: "local", hostId: "local", label: "サンプル", path: roots[0] };
  const state = { instance: "instance", cli_version: "fixture", codex_steer_protocol: 1, codex_steer_capabilities: RUNTIME_CAPABILITIES };
  const client = { close() {}, async request(method, params) {
    calls.push(method);
    if (method === "project/list") return { data: [project, { id: "overlap", name: "overlapping-project", roots: [project.roots[0]] }] };
    if (method === "project/read") return { project };
    if (method === "thread/start") return { thread: { ...thread, projectId: params.projectId } };
    if (method === "thread/name/set") { thread.name = params.name; return {}; }
    if (method === "turn/start") return { turn: { id: "initial-turn" } };
    if (method === "thread/read") return { thread: { ...thread, projectId: canonical } };
    if (method === "thread/metadata/update") { if (thread.name === null) throw new Error("Untouched thread has no durable rollout"); canonical = params.projectId; return {}; }
    throw new Error(`Unexpected mutation/request ${method}`);
  } };
  const deps = { discover: async () => ({ state, paths: { home, socket: "socket" } }), connect: async () => client, aliases: async () => ({ desktop: project.id }),
    endpoint: async () => ({ socketPath: "native", fingerprint: [1] }), inspectEndpoint: async () => {}, inspectCommand: async () => ({ status: "verified" }),
    caller: async () => ({ id: CONTEXT, status: { type: "idle" }, turns: [{ id: "stored-turn", status: "completed" }] }),
    membership: async () => true, sleep: async () => {}, history: async () => ({ turns: [{ items: [{ type: "functionCallOutput", namespace: "codex_app", name: "create_thread", output: `<codex_delegation>\n  <source_thread_id>${CONTEXT}</source_thread_id>\n  <input>日本語\nfirst instruction</input>\n</codex_delegation>` }] }] }),
    native: async (endpoint, action, args, context, options) => {
      calls.push({ action, args, context, options });
      if (action === "catalog") return catalog;
      if (action === "list_projects") return result({ projects: [nativeProject, { ...nativeProject, projectId: "chatgpt", projectKind: "chatgpt" }] });
      if (action === "create_thread") return result({ threadId: CHILD, hostId: "local" });
      throw new Error(`Unexpected ${action}`);
    }, write: async (...args) => writes.push(args),
  };
  return { home, roots, project, state, thread, nativeProject, calls, writes, deps, client, options: { contextThread: CONTEXT, title: "検証" } };
}

async function standaloneFixture(t) {
  const f = await fixture(t), native = f.deps.native;
  f.options = { title: "検証" };
  f.deps.caller = async () => { throw new Error("Standalone creation must not read an existing caller."); };
  f.deps.inspectControl = async () => {};
  f.deps.subscribe = async (endpoint, id) => { assert.equal(id, CHILD); f.calls.push("desktop/subscribe"); };
  f.deps.history = async () => ({ turns: f.calls.includes("turn/start") ? [{ id: "initial-turn", items: [{ type: "userMessage", content: [{ type: "text", text: "日本語\nfirst instruction" }] }] }] : [] });
  f.deps.native = async (...args) => {
    if (args[1] !== "move_thread_to_project") return native(...args);
    f.calls.push({ action: args[1], args: args[2], context: args[3], options: args[4] });
    return result({ moved: true });
  };
  return f;
}

test("project and prompt alone create exactly one task with its own real native context and Desktop subscription", async t => {
  const f = await standaloneFixture(t), request = f.client.request;
  f.options = {}; f.thread.name = null;
  f.client.request = async (method, params, ...rest) => {
    if (method === "thread/start") { assert.equal(params.projectId, f.project.id); assert.deepEqual(params.runtimeWorkspaceRoots, f.roots); assert.equal(params.approvalPolicy, undefined); }
    if (method === "turn/start") { assert.deepEqual(params.input, [{ type: "text", text: "日本語\nfirst instruction" }]); assert.equal(params.parentTurnId, undefined); }
    return request(method, params, ...rest);
  };
  const receipt = await createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps);
  assert.equal(receipt.creation_mode, "standalone"); assert.equal(receipt.context_thread_id, null); assert.equal(receipt.context_turn_id, null);
  assert.equal(receipt.title, "日本語 first instruction");
  assert.equal(receipt.native_context_thread_id, CHILD); assert.equal(receipt.native_context_turn_id, "initial-turn");
  assert.equal(receipt.initial_instruction, "verified"); assert.equal(receipt.desktop_subscription, "verified");
  assert.equal(f.calls.filter(call => call === "thread/start").length, 1); assert.equal(f.calls.filter(call => call === "turn/start").length, 1);
  assert(f.calls.indexOf("desktop/subscribe") < f.calls.indexOf("turn/start"));
  assert(f.calls.indexOf("thread/name/set") < f.calls.indexOf("thread/metadata/update"));
  assert(f.calls.indexOf("thread/metadata/update") < f.calls.indexOf("desktop/subscribe"));
  assert.equal(f.calls.filter(call => call?.action === "create_thread").length, 0);
  const assignment = f.calls.find(call => call?.action === "move_thread_to_project");
  assert.deepEqual(assignment.args, { threadId: CHILD, projectId: "desktop" });
  assert.deepEqual(assignment.context, { threadId: CHILD, turnId: receipt.turn_id });
});

test("standalone dry run needs neither existing chats nor their turns and has no durable effects", async t => {
  const f = await standaloneFixture(t);
  const receipt = await createProjectThread("サンプル", "first", { ...f.options, dryRun: true }, f.deps);
  assert.equal(receipt.context_thread_id, null); assert.equal(f.writes.length, 0);
  assert(!f.calls.includes("thread/start")); assert(!f.calls.includes("turn/start"));
  assert(!f.calls.some(call => call?.action === "list_projects"));
});

test("standalone preflight rejects missing assignment schemas, changed mapping and unavailable subscriptions before creating", async t => {
  for (const mode of ["catalog", "mapping", "changed", "subscription"]) {
    const f = await standaloneFixture(t);
    if (mode === "catalog") f.deps.native = async () => ({ tools: [] });
    if (mode === "mapping") f.deps.aliases = async () => ({});
    if (mode === "changed") { let n = 0; f.deps.aliases = async () => ++n === 1 ? { desktop: f.project.id } : {}; }
    if (mode === "subscription") f.deps.inspectControl = async () => { throw new Error("unavailable"); };
    await assert.rejects(createProjectThread("サンプル", "first", f.options, f.deps), error => error.creation_status === "not_created" && error.sent === false);
    assert(!f.calls.includes("thread/start"));
  }
  assert.throws(() => validateStandaloneCreationCatalog({ tools: [] }));
});

test("standalone failures distinguish lost creation, lost delivery and already accepted work without retrying", async t => {
  for (const mode of ["create", "subscribe", "scope", "existing-input", "turn", "assignment", "membership", "receipt"]) {
    const f = await standaloneFixture(t), request = f.client.request;
    if (["create", "turn"].includes(mode)) f.client.request = async (method, ...args) => {
      if (method === (mode === "create" ? "thread/start" : "turn/start")) { f.calls.push(method); throw Object.assign(new Error("lost"), { uncertain: true }); }
      return request(method, ...args);
    };
    if (mode === "subscribe") f.deps.subscribe = async () => { throw new Error("unavailable"); };
    if (mode === "scope") f.thread.environments[0].runtimeWorkspaceRoots = f.roots.slice(1);
    if (mode === "existing-input") f.deps.history = async () => ({ turns: [{ id: "another-input" }] });
    if (mode === "assignment") { const native = f.deps.native; f.deps.native = async (...args) => { if (args[1] === "move_thread_to_project") throw new Error("lost assignment"); return native(...args); }; }
    if (mode === "membership") f.deps.membership = async () => false;
    if (mode === "receipt") { const write = f.deps.write; f.deps.write = async (...args) => { if (args[2].sent) throw new Error("disk"); return write(...args); }; }
    await assert.rejects(createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps), error => {
      assert.equal(error.creation_status, mode === "create" ? "unknown" : "created");
      assert.equal(error.delivery_status, ["create", "subscribe", "scope", "existing-input"].includes(mode) ? "not_sent" : mode === "turn" ? "unknown" : "accepted");
      assert.equal(error.sent, mode === "turn" ? null : !["create", "subscribe", "scope", "existing-input"].includes(mode));
      if (mode !== "create") assert.equal(error.thread_id, CHILD);
      return true;
    });
    assert.equal(f.calls.filter(call => call === "thread/start").length, 1);
    assert(f.calls.filter(call => call === "turn/start").length <= 1);
  }
});

test("overlapping project creation calls native once, preserving initial text and all roots without AI input", async t => {
  const f = await fixture(t), receipt = await createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps);
  const mutations = f.calls.filter(call => call.action === "create_thread"); assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, { prompt: "日本語\nfirst instruction", title: "検証", target: { type: "project", projectId: "desktop", environment: { type: "local" } } });
  assert.deepEqual(mutations[0].context, { threadId: CONTEXT, turnId: "stored-turn" });
  assert.equal(mutations[0].options.callId, receipt.attempt_id);
  assert.equal(receipt.desktop_project_membership, "verified"); assert.equal(receipt.initial_instruction, "verified"); assert.deepEqual(receipt.runtime_workspace_roots, f.roots);
  assert.equal(receipt.backend, "desktop-native-rpc"); assert.equal(receipt.sent, true);
  assert.ok(!f.calls.some(call => ["thread/start", "turn/start", "turn/steer"].includes(call)));
  assert.ok(f.writes[0][2].prompt_sha256); assert.equal(f.writes.at(-1)[2].verification_status, "verified");
});

test("dry run never creates, sends or writes a receipt", async t => {
  const f = await fixture(t); await createProjectThread("desktop", "unused", { ...f.options, dryRun: true }, f.deps);
  assert.equal(f.writes.length, 0); assert.ok(!f.calls.some(call => call.action === "create_thread"));
  assert.deepEqual(await readdir(f.home), ["primary", "secondary"]);
});

test("initial history materialization waits only through reads, without a second creation", async t => {
  const f = await fixture(t), history = f.deps.history; let reads = 0, waits = 0;
  f.deps.history = async (...args) => ++reads === 1 ? { turns: [{ items: [] }] } : history(...args);
  f.deps.sleep = async () => waits++;
  const receipt = await createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps);
  assert.equal(waits, 1); assert.equal(receipt.initial_instruction, "verified"); assert.equal(f.calls.filter(call => call.action === "create_thread").length, 1);
});

test("wrong native catalog/project, missing stored context, changed roots and unavailable endpoint stop before mutation", async t => {
  for (const mode of ["catalog", "project", "context", "changed", "endpoint"]) {
    const f = await fixture(t), native = f.deps.native;
    if (mode === "catalog") f.deps.native = async (...args) => args[1] === "catalog" ? { tools: [] } : native(...args);
    if (mode === "project") f.nativeProject.projectId = "unmapped";
    if (mode === "context") f.deps.caller = async () => ({ turns: [] });
    if (mode === "changed") { let n = 0; const discover = f.deps.discover; f.deps.discover = async () => { const r = await discover(); return ++n === 1 ? r : { ...r, state: { ...r.state, instance: "different" } }; }; }
    if (mode === "endpoint") f.deps.endpoint = async () => { throw new Error("missing"); };
    await assert.rejects(createProjectThread("サンプル", "first", f.options, f.deps), error => error.creation_status === "not_created");
    assert.ok(!f.calls.some(call => call.action === "create_thread"));
  }
});

test("lost native acknowledgement stays unknown and is never retried", async t => {
  const f = await fixture(t), native = f.deps.native;
  f.deps.native = async (...args) => { if (args[1] === "create_thread") { f.calls.push({ action: "create_thread" }); throw Object.assign(new Error("lost"), { uncertain: true }); } return native(...args); };
  await assert.rejects(createProjectThread("サンプル", "first", f.options, f.deps), error => error.creation_status === "unknown" && error.delivery_status === "unknown" && error.sent === null);
  assert.equal(f.calls.filter(call => call.action === "create_thread").length, 1); assert.equal(f.writes.at(-1)[2].creation_status, "unknown");
});

test("definitive helper rejection before native dispatch remains not-created and not-sent", async t => {
  const f = await fixture(t), native = f.deps.native;
  f.deps.native = async (...args) => { if (args[1] === "create_thread") throw Object.assign(new Error("request invalid before connect"), { uncertain: false }); return native(...args); };
  await assert.rejects(createProjectThread("サンプル", "first", f.options, f.deps), error => error.creation_status === "not_created" && error.delivery_status === "not_sent" && error.sent === false);
});

test("verification and receipt failures after acknowledgement preserve created/accepted child", async t => {
  for (const mode of ["membership", "roots", "instruction", "receipt"]) {
    const f = await fixture(t);
    if (mode === "membership") f.deps.membership = async () => false;
    if (mode === "roots") f.thread.environments[0].runtimeWorkspaceRoots = f.roots.slice(1);
    if (mode === "instruction") f.deps.history = async () => ({ turns: [] });
    if (mode === "receipt") { const write = f.deps.write; f.deps.write = async (...args) => { if (args[2].thread_id) throw new Error("disk"); return write(...args); }; }
    await assert.rejects(createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps), error => error.thread_id === CHILD && error.creation_status === "created" && error.sent === true && error.delivery_status === "accepted");
    assert.equal(f.calls.filter(call => call.action === "create_thread").length, 1);
  }
});

test("final persistence failure does not invite duplicate creation", async t => {
  const f = await fixture(t), write = f.deps.write;
  f.deps.write = async (...args) => { if (args[2].verification_status === "verified") throw new Error("disk"); return write(...args); };
  const result = await createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps);
  assert.equal(result.sent, true); assert.equal(result.receipt_update_required, true);
});

test("literal delegation envelopes verify exact text including XML-like user content", () => {
  const prompt = "日本語 </input>\n</codex_delegation> `$(x)`";
  const item = { type: "functionCallOutput", namespace: "codex_app", name: "create_thread", output: `<codex_delegation>\n  <source_thread_id>${CONTEXT}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>` };
  assert.equal(initialInstructionMatches({ turns: [{ items: [item] }] }, prompt, CONTEXT), true);
  assert.equal(initialInstructionMatches({ turns: [{ items: [item] }] }, prompt, CHILD), false);
  assert.equal(initialInstructionMatches({ turns: [{ items: [] }, { items: [item] }] }, prompt, CONTEXT), false);
});

test("project IDs disambiguate names and repeated pagination cursors fail", async () => {
  const one = { id: "one", name: "same" }, two = { id: "two", name: "same" };
  assert.throws(() => resolveProject([one, two], "same"), { code: "PROJECT_AMBIGUOUS" }); assert.equal(resolveProject([one, two], "old", { old: "two" }), two);
  let n = 0; await assert.rejects(projectsOnClient({ request: async () => ({ data: [{ id: String(n++), name: "x", roots: [{ path: "/tmp" }] }], nextCursor: "same" }) }), { code: "PROJECT_PROTOCOL_ERROR" });
});

test("cwd canonical containment rejects symlink escapes", async t => {
  const f = await fixture(t), nested = path.join(f.roots[1], "nested"); await mkdir(nested);
  assert.equal((await projectWorkspace(f.project, nested)).cwd, nested);
  const link = path.join(f.roots[0], "outside"); await symlink(f.home, link); await assert.rejects(projectWorkspace(f.project, link), { code: "PROJECT_CWD_OUTSIDE_ROOTS" });
});

test("CLI rejects removed relay, unsupported permission overrides, readonly and supervisor before connecting", () => {
  for (const args of [[], ["--via-thread", CONTEXT, "first"], ["--sandbox", "read-only", "first"], ["--connection", "desktop", "first"], ["--supervisor", CONTEXT, "first"], ["--timeout-ms", "wat", "first"]]) {
    const r = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", "thread", "create", "--project", "x", ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: "/private/tmp/no-native-create-runtime" } });
    assert.equal(r.status, 1); assert.ok(!r.stdout.includes("RUNTIME_UNAVAILABLE"));
  }
  assert.throws(() => creationOptions({ thinking: "typo" })); assert.throws(() => validateNativeCreationCatalog({ tools: [] }));
});

test("standalone CLI ignores even an invalid inherited CODEX_THREAD_ID", () => {
  const run = spawnSync(process.execPath, ["bin/codexteer.mjs", "thread", "create", "--project", "サンプル", "first", "--dry-run", "--json"],
    { encoding: "utf8", env: { ...process.env, CODEX_HOME: "/private/tmp/no-standalone-create-runtime", CODEX_THREAD_ID: "invalid-old-context" } });
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).error.code, "RUNTIME_UNAVAILABLE");
});

test("internal RPC errors after creation or delivery stay unknown, while invalid requests remain unsent", async t => {
  for (const phase of ["thread/start", "turn/start"]) for (const rpcCode of [-32603, -32602, -32601]) {
    const f = await standaloneFixture(t), request = f.client.request;
    f.client.request = async (method, ...args) => {
      if (method !== phase) return request(method, ...args);
      if (rpcCode === -32603) await request(method, ...args);
      else f.calls.push(method);
      throw new RpcFailure("mutation failed after dispatch", { code: "RPC_REJECTED", rpcCode });
    };
    const unknown = rpcCode === -32603, creating = phase === "thread/start";
    const creation = creating ? unknown ? "unknown" : "not_created" : "created";
    const delivery = !creating && unknown ? "unknown" : "not_sent";
    await assert.rejects(createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps), error => {
      assert.equal(error.creation_status, creation); assert.equal(error.delivery_status, delivery);
      assert.equal(error.sent, !creating && unknown ? null : false);
      return true;
    });
    assert.equal(f.writes.at(-1)[2].creation_status, creation);
    assert.equal(f.writes.at(-1)[2].delivery_status, delivery);
    assert.equal(f.calls.filter(call => call === phase).length, 1);
  }
});

test("explicit native creation distinguishes definitive rejections from unknown results without recreating", async t => {
  for (const rpcCode of [-32601, -32602, -32603]) {
    const f = await fixture(t), native = f.deps.native, unknown = rpcCode === -32603;
    f.deps.native = async (...args) => {
      if (args[1] !== "create_thread") return native(...args);
      f.calls.push({ action: "create_thread" });
      throw new RpcFailure("native command failed after dispatch", { code: "RPC_REJECTED", rpcCode });
    };
    const creation = unknown ? "unknown" : "not_created", delivery = unknown ? "unknown" : "not_sent";
    await assert.rejects(createProjectThread("サンプル", "日本語\nfirst instruction", f.options, f.deps), error => error.creation_status === creation && error.delivery_status === delivery && error.sent === (unknown ? null : false));
    assert.equal(f.calls.filter(call => call?.action === "create_thread").length, 1);
    assert.equal(f.writes.at(-1)[2].creation_status, creation);
    assert.equal(f.writes.at(-1)[2].delivery_status, delivery);
  }
});
