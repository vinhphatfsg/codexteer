import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tempPrefix } from "../test-support/temp.mjs";
import { cloudModelsOnClient, desktopCloudModels, readCloudModelDefaults, setCloudModelDefaults, resetCloudModelDefaults, resolveCloudModelSelection, selectCloudModel } from "../src/desktop-cloud-models.mjs";
import { pickCloudModel } from "../src/cloud-model-picker.mjs";
import { createDesktopCloudTask, sendDesktopCloudInput, desktopCloudReceipt } from "../src/desktop-cloud.mjs";
import { listRecords, writeRecord } from "../src/store.mjs";

const row = (model, efforts, isDefault = false) => ({ model, displayName: model, isDefault, defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
const catalog = () => [row("model-a", ["low", "high"], true), row("model-b", ["medium", "max"])];
const config = "fixture-config", threadId = "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
async function fixture(t) {
  const home = await mkdtemp(tempPrefix("cloud-models-")); t.after(() => rm(home, { force: true, recursive: true }));
  const state = { rows: catalog(), calls: [], closed: 0, turns: [] };
  const client = { close() { state.closed++; }, async request(method, params) {
    state.calls.push({ method, params });
    if (method === "model/list") { if (state.catalogError) throw Object.assign(Error("catalog unavailable"), { code: "CONNECTION_FAILED" }); return { data: state.rows }; }
    if (method === "thread/start") { if (state.lostCreate) throw Object.assign(Error("lost"), { uncertain: true }); return { thread: { id: threadId } }; }
    if (method === "thread/name/set") return {};
    if (method === "thread/read") return { thread: { id: threadId, status: { type: "idle" }, turns: state.turns, environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config }] } };
    if (method === "turn/start") return { turn: { id: "turn-fixture" } };
    throw Error(`Unexpected ${method}`);
  } };
  return { state, client, deps: { home, connect: async () => client, environments: async () => ({ environments: [{ id: config, name: "Fixture" }] }) } };
}

test("catalog paginates and excludes hidden models without inventing effort choices", async () => {
  const calls = [];
  const models = await cloudModelsOnClient({ async request(method, params) {
    assert.equal(method, "model/list"); calls.push(params);
    return params.cursor ? { data: [catalog()[1]] } : { data: [catalog()[0], { hidden: true }], nextCursor: "second" };
  } });
  assert.deepEqual(models.map(row => row.efforts), [["low", "high"], ["medium", "max"]]); assert.equal(calls[1].cursor, "second");
});

test("invalid, duplicate and looping catalogs fail closed", async () => {
  for (const response of [{}, { data: [] }, { data: [catalog()[0], catalog()[0]] }, { data: [row("model-a", [])] },
    { data: [{ ...catalog()[0], defaultReasoningEffort: "ultra" }] }, { data: [{ ...catalog()[0], supportedReasoningEfforts: {} }] },
    { data: [{ ...catalog()[0], model: "bad\nmodel" }] }, { data: [catalog()[0]], nextCursor: "loop" }]) {
    await assert.rejects(cloudModelsOnClient({ request: async () => response }), { code: "DESKTOP_CLOUD_MODELS_UNVERIFIED" });
  }
});

test("saved pairs are atomic, private, read afresh, and reset to catalog defaults", async t => {
  const { deps } = await fixture(t);
  assert.equal(await readCloudModelDefaults(deps), null);
  const first = await setCloudModelDefaults({ model: "model-b", thinking: "max" }, deps);
  assert.equal((await stat(first.settings_path)).mode & 0o777, 0o600);
  assert.equal((await resolveCloudModelSelection({}, deps)).thinking, "max");
  await setCloudModelDefaults({ model: "model-a", thinking: "high" }, deps);
  assert.deepEqual(await readCloudModelDefaults(deps), { model: "model-a", thinking: "high" });
  await resetCloudModelDefaults(deps);
  assert.equal((await resolveCloudModelSelection({}, deps)).thinking, "low");
});

test("explicit overrides preserve only a compatible saved effort and never silently replace unavailable settings", async t => {
  const { deps, state } = await fixture(t);
  await setCloudModelDefaults({ model: "model-a", thinking: "high" }, deps);
  assert.equal((await resolveCloudModelSelection({ model: "model-a" }, deps)).thinking, "high");
  assert.equal((await resolveCloudModelSelection({ model: "model-b" }, deps)).thinking, "medium");
  assert.equal((await resolveCloudModelSelection({ thinking: "low" }, deps)).model, "model-a");
  await assert.rejects(resolveCloudModelSelection({ thinking: "max" }, deps), { code: "DESKTOP_CLOUD_MODEL_INVALID" });
  state.rows = [catalog()[1]];
  await assert.rejects(resolveCloudModelSelection({}, deps), { code: "DESKTOP_CLOUD_MODEL_INVALID" });
  assert.equal((await resolveCloudModelSelection({ model: "model-b", thinking: "max" }, deps)).thinking, "max");
  const models = await desktopCloudModels(deps);
  assert.throws(() => selectCloudModel(models), { code: "DESKTOP_CLOUD_MODELS_UNVERIFIED" });
});

test("rejected saves and corrupt settings cannot fall back silently", async t => {
  const { deps, state } = await fixture(t);
  const saved = await setCloudModelDefaults({ model: "model-a", thinking: "high" }, deps), before = await readFile(saved.settings_path, "utf8");
  for (const options of [{ model: "model-b", thinking: "high" }, { model: "missing", thinking: "low" }, { model: "model-a" }]) {
    await assert.rejects(setCloudModelDefaults(options, deps), { code: "DESKTOP_CLOUD_MODEL_INVALID" });
    assert.equal(await readFile(saved.settings_path, "utf8"), before);
  }
  state.catalogError = true;
  await assert.rejects(setCloudModelDefaults({ model: "model-b", thinking: "max" }, deps), { code: "CONNECTION_FAILED" });
  assert.equal(await readFile(saved.settings_path, "utf8"), before); state.catalogError = false;
  await writeFile(saved.settings_path, "{broken");
  await assert.rejects(resolveCloudModelSelection({}, deps), { code: "DESKTOP_CLOUD_MODEL_SETTINGS_INVALID" });
  await setCloudModelDefaults({ model: "model-b", thinking: "max" }, deps);
  assert.equal((await readCloudModelDefaults(deps)).model, "model-b");
  await writeRecord("settings", "desktop-cloud-model", { schema: 99 }, deps);
  await assert.rejects(readCloudModelDefaults(deps), { code: "DESKTOP_CLOUD_MODEL_SETTINGS_INVALID" });
});

test("picker shows supported efforts, reprompts invalid numbers and saves the chosen pair", async t => {
  const { deps, state } = await fixture(t), answers = ["oops", "2", "9", "2"], lines = [];
  state.rows[1].displayName = "Name\x1b[31m\n";
  const result = await pickCloudModel({ ...deps, output: { write: s => lines.push(s) }, ask: async () => answers.shift() });
  assert.equal(result.model, "model-b"); assert.equal(result.thinking, "max");
  assert.match(lines.join(""), /medium/); assert.doesNotMatch(lines.join(""), /\x1b/);
  assert.equal(state.calls.filter(c => c.method === "model/list").length, 2);
});

test("picker cancellation/EOF and catalog changes during selection leave defaults unchanged", async t => {
  const { deps, state } = await fixture(t);
  await setCloudModelDefaults({ model: "model-a", thinking: "high" }, deps);
  for (const answers of [["q"], ["2", "q"], [undefined]]) {
    await assert.rejects(pickCloudModel({ ...deps, output: { write() {} }, ask: async () => answers.shift() }), { code: "DESKTOP_CLOUD_MODEL_CANCELLED" });
    assert.equal((await readCloudModelDefaults(deps)).thinking, "high");
  }
  const answers = ["2", "2"];
  await assert.rejects(pickCloudModel({ ...deps, output: { write() {} }, ask: async () => { const answer = answers.shift(); if (!answers.length) state.rows = [catalog()[0]]; return answer; } }), { code: "DESKTOP_CLOUD_MODEL_INVALID" });
  assert.equal((await readCloudModelDefaults(deps)).model, "model-a");
  await assert.rejects(pickCloudModel({ ...deps, input: { isTTY: false } }), { code: "DESKTOP_CLOUD_MODEL_TTY_REQUIRED" });
});

test("cancellation during catalog revalidation cannot publish new defaults", async t => {
  const { deps, client } = await fixture(t);
  await setCloudModelDefaults({ model: "model-a", thinking: "high" }, deps);
  const request = client.request.bind(client);
  for (const disconnected of [false, true]) {
    const abort = new AbortController();
    client.request = async (...args) => { const result = await request(...args); abort.abort(); if (disconnected) throw Error("closed"); return result; };
    await assert.rejects(setCloudModelDefaults({ model: "model-b", thinking: "max" }, { ...deps, signal: abort.signal }), { code: "DESKTOP_CLOUD_MODEL_CANCELLED" });
    assert.deepEqual(await readCloudModelDefaults(deps), { model: "model-a", thinking: "high" });
  }
});

test("creation sends the selected pair in the thread and first turn; continuations inherit existing settings", async t => {
  const { deps, state } = await fixture(t);
  await setCloudModelDefaults({ model: "model-b", thinking: "max" }, deps);
  const result = await createDesktopCloudTask(config, "Fixture instruction", {}, deps);
  assert.equal(result.model_selection.model, "model-b"); assert.equal(result.model_selection.thinking, "max");
  const start = state.calls.find(c => c.method === "thread/start").params, first = state.calls.find(c => c.method === "turn/start").params;
  assert.equal(start.model, "model-b"); assert.equal(start.config.model_reasoning_effort, "max");
  assert.equal(first.model, "model-b"); assert.equal(first.effort, "max");
  await setCloudModelDefaults({ model: "model-a", thinking: "low" }, deps);
  await sendDesktopCloudInput(threadId, "Continue", { newTurn: true }, deps);
  const next = state.calls.filter(c => c.method === "turn/start").at(-1).params;
  assert.equal(next.model, undefined); assert.equal(next.effort, undefined);
});

test("dry-run resolves the real selection without creating records or mutations", async t => {
  const { deps, state } = await fixture(t);
  const result = await createDesktopCloudTask(config, "Fixture", { dryRun: true, model: "model-b", thinking: "max" }, deps);
  assert.equal(result.model_selection.thinking, "max"); assert.equal(result.sent, false);
  assert(state.calls.every(c => c.method === "model/list")); assert.deepEqual(await listRecords("desktop-cloud-creations", deps), []);
});

test("unsupported selection cannot dispatch; a proven pre-dispatch attempt can retry once and unknown creation cannot", async t => {
  const { deps, state } = await fixture(t), attemptId = randomUUID();
  state.catalogError = true;
  await assert.rejects(createDesktopCloudTask(config, "Fixture", { attemptId }, deps), error => error.creation_dispatched === false && error.creation_status === "not_created");
  state.catalogError = false;
  await createDesktopCloudTask(config, "Fixture", { attemptId }, deps);
  await assert.rejects(createDesktopCloudTask(config, "Fixture", { attemptId }, deps), { code: "DESKTOP_CLOUD_CREATION_PENDING" });
  assert.equal(state.calls.filter(c => c.method === "thread/start").length, 1);
  const unknown = randomUUID(); state.lostCreate = true;
  await assert.rejects(createDesktopCloudTask(config, "Another", { attemptId: unknown }, deps), error => error.creation_dispatched && error.creation_status === "unknown");
  await assert.rejects(createDesktopCloudTask(config, "Another", { attemptId: unknown }, deps), { code: "DESKTOP_CLOUD_CREATION_PENDING" });
  assert.equal((await desktopCloudReceipt(unknown, deps)).creation_dispatched, true);
  const before = state.calls.length;
  await assert.rejects(createDesktopCloudTask(config, "Invalid", { thinking: "unsupported" }, deps), { code: "DESKTOP_CLOUD_MODEL_INVALID" });
  assert(state.calls.slice(before).every(c => c.method === "model/list"));
});
