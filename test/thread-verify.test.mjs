import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { desktopMembership, initialInstructionText, validateMembershipCatalog } from "../src/creation-verification.mjs";
import { verifyProjectThread } from "../src/thread-verify.mjs";
import { readRecord, writeRecord } from "../src/store.mjs";
import { RUNTIME_CAPABILITIES } from "../src/compatibility.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000013", ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000014";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000015", prompt = "日本語😀 </input>\n</codex_delegation>\n";
const result = value => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });

test("membership preflight requires a supported bounded native schema", () => {
  const catalog = limit => ({ tools: [{ name: "list_threads", namespace: "codex_app", inputSchema: { type: "object", properties: { limit } } }] });
  validateMembershipCatalog(catalog({ type: "integer", minimum: 1, maximum: 50 }));
  for (const limit of [{ type: "integer", maximum: 20 }, { type: "number", minimum: 60 }, { type: "string" }, undefined]) {
    assert.throws(() => validateMembershipCatalog(catalog(limit)), { code: "NATIVE_CREATION_UNSUPPORTED" });
  }
});

test("membership uses the live Desktop snapshot for pinned and recent tasks, without a legacy disk assignment", async () => {
  for (const pinned of [false, true]) {
    const entry = { id: ID, kind: "codex", hostId: "local", projectId: "desktop" };
    const snapshot = { threads: pinned ? [] : [entry], pinnedThreads: pinned ? [entry] : [] };
    const native = async (endpoint, action, args) => { assert.equal(action, "list_threads"); assert.deepEqual(args, { limit: 50 }); return result(snapshot); };
    assert.equal(await desktopMembership(native, {}, ID, "desktop", {}), true);
  }
});

test("missing, ambiguous, different-project, remote and ChatGPT membership never pass", async () => {
  const entry = { id: ID, kind: "codex", hostId: "local", projectId: "desktop" };
  for (const entries of [[], [entry, entry], [{ ...entry, projectId: "same-cwd-other-project" }], [{ ...entry, hostId: "remote" }], [{ ...entry, kind: "chatgpt" }]]) {
    assert.equal(await desktopMembership(async () => result({ threads: entries, pinnedThreads: [] }), {}, ID, "desktop", {}), false);
  }
  await assert.rejects(desktopMembership(async () => result({ threads: [entry] }), {}, ID, "desktop", {}), { code: "NATIVE_PROTOCOL_ERROR" });
});

async function fixture(t) {
  const home = await mkdtemp("/private/tmp/ct-verify-"); t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "workspace"); await mkdir(root);
  const receipt = { schema: 3, attempt_id: ATTEMPT, creation_mode: "standalone", thread_id: ID, turn_id: "first-turn", project_id: "canonical", desktop_project_id: "desktop",
    title: "検証", cwd: root, runtime_workspace_roots: [root], creation_status: "created", sent: true, delivery_status: "accepted", verification_status: "failed",
    error_code: "CREATION_VERIFICATION_FAILED", message_characters: [...prompt].length, prompt_sha256: createHash("sha256").update(prompt).digest("hex") };
  const project = { id: "canonical", name: "test", roots: [{ path: root }] };
  const thread = { id: ID, name: receipt.title, projectId: project.id, cwd: root, environments: [{ environmentId: "local", runtimeWorkspaceRoots: [root] }] };
  const saved = { turns: [{ id: "first-turn", items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }] }, { id: "followup", items: [] }] };
  const state = { instance: "same", cli_version: "fixture", codex_steer_protocol: 1, codex_steer_capabilities: RUNTIME_CAPABILITIES };
  const calls = [], entry = { id: ID, kind: "codex", hostId: "local", projectId: "desktop" };
  const client = { close() { calls.push("close"); }, async request(method, params, options) {
    calls.push(method); assert.notEqual(options?.mutation, true);
    if (method === "project/read") { assert.equal(params.projectId, "canonical"); return { project }; }
    if (method === "thread/read") { assert.equal(params.threadId, ID); return { thread }; }
    throw new Error(`Verification made an unexpected request: ${method}`);
  } };
  const deps = { discover: async () => ({ paths: { home, socket: "socket" }, state }), connect: async () => client, aliases: async () => ({ desktop: project.id }),
    endpoint: async () => ({ socketPath: "native", fingerprint: [1] }), inspectEndpoint: async () => {}, inspectCommand: async () => {}, history: async () => saved,
    native: async (endpoint, action, args, context) => {
      calls.push(action);
      if (action === "catalog") return { tools: [{ name: "list_threads", namespace: "codex_app", inputSchema: { type: "object", properties: { limit: { type: "number" } } } }] };
      assert.equal(action, "list_threads"); assert.deepEqual(context, { threadId: ID, turnId: saved.turns[0].id });
      return result({ threads: [entry], pinnedThreads: [] });
    } };
  await writeRecord("creations", ATTEMPT, receipt, { home });
  return { home, receipt, thread, saved, entry, deps, calls };
}

test("existing failed/accepted receipt verifies and saves an audit without creation, assignment or input", async t => {
  const f = await fixture(t), before = structuredClone(f.saved);
  const verified = await verifyProjectThread(ATTEMPT, {}, f.deps);
  assert.equal(verified.verification_status, "verified"); assert.equal(verified.thread_id, ID); assert.equal(verified.turn_id, "first-turn");
  assert.equal(verified.initial_instruction, "verified"); assert.equal(verified.error_code, undefined);
  assert.equal(verified.verification_history[0].previous_error_code, "CREATION_VERIFICATION_FAILED");
  assert(Object.values(verified.verification_history[0].checks).every(check => check === true));
  assert.deepEqual(f.calls, ["catalog", "project/read", "thread/read", "list_threads", "close"]);
  assert.deepEqual(await readRecord("creations", ATTEMPT, { home: f.home }), verified); assert.deepEqual(f.saved, before);
});

test("fresh membership, roots, mapping, title, first-turn and exact instruction mismatches fail closed", async t => {
  for (const mode of ["membership", "mapping", "canonical", "roots", "title", "turn", "instruction"]) {
    const f = await fixture(t);
    if (mode === "membership") f.entry.projectId = "another";
    if (mode === "mapping") f.deps.aliases = async () => ({ desktop: "another" });
    if (mode === "canonical") f.thread.projectId = "another";
    if (mode === "roots") f.thread.environments[0].runtimeWorkspaceRoots.push("/extra");
    if (mode === "title") f.thread.name = "another";
    if (mode === "turn") f.saved.turns[0].id = "another";
    if (mode === "instruction") f.saved.turns[0].items[0].content[0].text = prompt.trimEnd();
    await assert.rejects(verifyProjectThread(ATTEMPT, {}, f.deps), error => error.code === "CREATION_VERIFICATION_FAILED" && Object.values(error.verification_checks).includes(false) && error.sent === true);
    const stored = await readRecord("creations", ATTEMPT, { home: f.home });
    assert.equal(stored.verification_status, "failed"); assert.equal(stored.creation_status, "created"); assert.equal(stored.delivery_status, "accepted");
  }
});

test("unknown or unaccepted receipts cannot be promoted and make no Desktop request", async t => {
  for (const change of [{ creation_status: "unknown" }, { sent: null, delivery_status: "unknown" }, { thread_id: undefined }, { prompt_sha256: "bad" }, { schema: 99 }]) {
    const f = await fixture(t); await writeRecord("creations", ATTEMPT, { ...f.receipt, ...change }, { home: f.home });
    await assert.rejects(verifyProjectThread(ATTEMPT, {}, f.deps), { code: "CREATION_RECEIPT_UNVERIFIED" }); assert.deepEqual(f.calls, []);
  }
});

test("delegated literal envelope verifies only its original source and hash", async t => {
  const f = await fixture(t);
  const item = { type: "functionCallOutput", namespace: "codex_app", name: "create_thread", output: `<codex_delegation>\n  <source_thread_id>${SOURCE}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>` };
  f.saved.turns[0].items = [item];
  await writeRecord("creations", ATTEMPT, { ...f.receipt, schema: 2, creation_mode: "delegated", context_thread_id: SOURCE, title: null }, { home: f.home });
  assert.equal((await verifyProjectThread(ATTEMPT, {}, f.deps)).initial_instruction, "verified");
  assert.equal(initialInstructionText(f.saved, ID), undefined);
  item.output += "\n";
  await assert.rejects(verifyProjectThread(ATTEMPT, {}, f.deps), { code: "CREATION_VERIFICATION_FAILED" });
});

test("transport, runtime-change and receipt-write failures never report a saved success", async t => {
  for (const mode of ["native", "runtime", "write"]) {
    const f = await fixture(t);
    if (mode === "native") f.deps.native = async () => { throw new Error("offline"); };
    if (mode === "runtime") { const discover = f.deps.discover; let count = 0; f.deps.discover = async () => { const r = await discover(); return ++count === 1 ? r : { ...r, state: { ...r.state, instance: "changed" } }; }; }
    if (mode === "write") f.deps.write = async () => { throw new Error("disk"); };
    await assert.rejects(verifyProjectThread(ATTEMPT, {}, f.deps), error => error.sent === true && error.thread_id === ID && (mode !== "write" || error.receipt_update_required === true));
    assert.equal((await readRecord("creations", ATTEMPT, { home: f.home })).verification_status, "failed");
  }
});

test("CLI verification rejects delivery, creation and managed options before connecting", () => {
  for (const args of [["--new-turn"], ["--project", "x"], ["--timeout-ms", "NaN"], ["--supervisor", SOURCE], ["--connection", "desktop"]]) {
    const r = spawnSync(process.execPath, ["bin/codexteer.mjs", "thread", "verify", ATTEMPT, ...args, "--json"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: "/private/tmp/no-verify-runtime" } });
    assert.equal(r.status, 1); assert.notEqual(JSON.parse(r.stdout).error.code, "RUNTIME_UNAVAILABLE");
  }
});
