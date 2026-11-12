import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tempPrefix } from "../test-support/temp.mjs";

const bin = new URL("../bin/codexteer.mjs", import.meta.url), preload = new URL("../test-support/cloud-models-register.mjs", import.meta.url).href;
test("real CLI switches defaults between invocations and both creation commands send the chosen pair", async t => {
  const home = await mkdtemp(tempPrefix("cloud-models-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const models = [{ model: "model-a", displayName: "A", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
    { model: "model-b", displayName: "B", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "max" }] }];
  await writeFile(`${home}/fixture.json`, JSON.stringify({ models, calls: [], threads: {} }));
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, ["--import", preload, bin.pathname, "--connection", "desktop-cloud", ...args, "--json"],
      { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, expected, result.stderr || result.stdout); return JSON.parse(result.stdout);
  };
  assert.equal(cli(["models", "list"]).data.models.length, 2);
  cli(["models", "set", "--model", "model-b", "--thinking", "max"]);
  assert.deepEqual(cli(["models", "show"]).data.saved, { model: "model-b", thinking: "max" });
  const first = cli(["thread", "create", "--environment", "test-config", "Fixture instruction"]).data;
  assert.equal(first.model_selection.model, "model-b"); assert.equal(first.model_selection.thinking, "max");
  cli(["models", "set", "--model", "model-a", "--thinking", "high"]);
  const workArgs = ["work", "start", "--project", "fixture", "--environment", "test-config", "--root", home, "--title", "Fixture work", "Fixture work instruction"];
  const work = cli(workArgs).data; assert.equal(work.stage, "observed"); assert.equal(work.model_selection.thinking, "high");
  cli(["models", "set", "--model", "model-a", "--thinking", "low"]);
  assert.equal(cli(workArgs).data.thread_id, work.thread_id);
  assert.equal(cli(workArgs).data.model_selection.thinking, "high");
  cli([...workArgs, "--thinking", "low"], 1);
  const state = JSON.parse(await readFile(`${home}/fixture.json`, "utf8"));
  assert.deepEqual(state.calls.filter(c => c.method === "thread/start").map(c => [c.params.model, c.params.config.model_reasoning_effort]), [["model-b", "max"], ["model-a", "high"]]);
  assert.deepEqual(state.calls.filter(c => c.method === "turn/start").map(c => [c.params.model, c.params.effort]), [["model-b", "max"], ["model-a", "high"]]);
  cli(["models", "set", "--model", "model-b", "--thinking", "high"], 1);
  assert.equal(cli(["models", "show"]).data.saved.thinking, "low");
  cli(["models", "select"], 1);
  cli(["--supervisor", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "models", "reset"], 1);
  cli(["models", "reset"]); assert.equal(cli(["models", "show"]).data.saved, null);
  const dry = cli(["thread", "create", "--environment", "test-config", "--dry-run", "Preview"]).data;
  assert.equal(dry.model_selection.thinking, "low"); assert.equal(dry.sent, false);
});
