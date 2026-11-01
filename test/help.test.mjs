import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { topics, helpData, renderHelp } from "../src/help.mjs";
import { OPTIONS_INVALID, SUPERVISOR_PAUSED } from "../src/help-errors.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(root, "bin/codexteer.mjs");
const source = readdirSync(path.join(root, "src")).filter(f => f.endsWith(".mjs") && !f.startsWith("help"))
  .map(f => readFileSync(path.join(root, "src", f), "utf8")).join("\n");
const composedCodes = ["RUNTIME_PROTOCOL_UNSUPPORTED", "RUNTIME_PROTOCOL_UNVERIFIED", "CAPABILITY_UNSUPPORTED", "CAPABILITY_UNVERIFIED"];

test("every topic is served by the CLI as JSON and text with the fixed fields", () => {
  for (const name of Object.keys(topics)) {
    const json = spawnSync(process.execPath, [BIN, "help", ...name.split(" "), "--json"], { encoding: "utf8" });
    assert.equal(json.status, 0, name);
    const { ok, data } = JSON.parse(json.stdout);
    assert.equal(ok, true);
    assert.deepEqual(data, JSON.parse(JSON.stringify(helpData(name))), name);
    for (const key of ["title", "when", "returns"]) assert.equal(typeof data[key], "string", `${name}.${key}`);
    for (const key of ["usage", "examples", "notes"]) assert.ok(Array.isArray(data[key]), `${name}.${key}`);
    for (const option of data.options ?? []) assert.equal(typeof option.text, "string", `${name} option ${option.name}`);
    for (const error of data.errors ?? []) assert.ok(error.code && error.when && error.action, `${name} error ${error.code}`);
    assert.doesNotMatch(renderHelp(data), /undefined|\[object Object\]/, name);
  }
});

test("related topics exist and the overview reaches every topic", () => {
  const overview = JSON.stringify(topics.overview);
  for (const [name, topic] of Object.entries(topics)) {
    for (const related of topic.see ?? []) assert.ok(topics[related], `${name} → ${related}`);
    assert.ok(name === "overview" || overview.includes(`help ${name}`), `overview does not route to ${name}`);
  }
});

test("documented error codes are produced and documented flags are parsed by the implementation", () => {
  for (const [name, topic] of Object.entries(topics)) {
    for (const { code } of topic.errors ?? []) assert.ok(source.includes(`"${code}"`) || composedCodes.includes(code), `${name}: ${code}`);
    for (const flag of new Set(topic.usage.join(" ").match(/--[a-z][a-z0-9-]*/g) ?? [])) assert.ok(source.includes(`"${flag}"`), `${name}: ${flag}`);
  }
});

test("rendered usage never places --json where it would be passed to a child command", () => {
  for (const name of Object.keys(topics)) {
    for (const line of renderHelp(helpData(name)).split("\n").filter(l => l.startsWith("  codexteer ") && l.includes(" -- "))) {
      assert.ok(!line.split(" -- ")[1].includes("--json"), `${name}: ${line}`);
    }
  }
});

const THREAD = "33333333-3333-4333-8333-333333333333";
const cli = (args, env = {}) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { ...result, error: args.includes("--json") ? JSON.parse(result.stdout).error : undefined };
};

test("an argument error names its topic, the failing subcommand's usage and the documented action", () => {
  const { status, error } = cli(["findings", "reopen", THREAD, "fixture-id", "--reson", "typo", "--json"]);
  assert.equal(status, 1);
  assert.equal(error.code, "OPTIONS_INVALID");
  assert.equal(error.message, "See codexteer help findings.");
  assert.equal(error.help, "findings");
  assert.equal(error.usage.length, 1);
  assert.match(error.usage[0], /^findings reopen .*--reason TEXT/);
  assert.equal(error.action, OPTIONS_INVALID.action);
  const text = cli(["findings", "reopen", THREAD, "fixture-id", "--reson", "typo"]);
  assert.equal(text.status, 1);
  assert.equal(text.stdout, "");
  assert.deepEqual(text.stderr.trim().split("\n"), ["codexteer: See codexteer help findings.", `使い方: codexteer ${error.usage[0]}`, `対処: ${OPTIONS_INVALID.action}`]);
});

test("a topic's own action for a code wins over the shared one", () => {
  const { error } = cli(["diff", THREAD, "--json"]);
  const documented = topics.diff.errors.find(entry => entry.code === "OPTIONS_INVALID").action;
  assert.notEqual(documented, OPTIONS_INVALID.action);
  assert.equal(error.code, "OPTIONS_INVALID");
  assert.equal(error.help, "diff");
  assert.equal(error.action, documented);
});

test("a paused supervisor's refused send carries the send topic's action", async t => {
  const home = await mkdtemp("/private/tmp/cs-help-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const SESSION = "22222222-2222-4222-8222-000000000055";
  await registerSupervisor(THREAD, SESSION, { home });
  await controlSupervisor(THREAD, "pause", { home });
  const { status, error } = cli(["--supervisor", SESSION, "send", THREAD, "fixture", "--finding", "fixture-id", "--based-on", "fixture-cursor", "--no-sound", "--json"], { CODEX_HOME: home });
  assert.equal(status, 1);
  assert.equal(error.code, "SUPERVISOR_PAUSED");
  assert.equal(error.help, "send");
  assert.equal(error.action, topics.send.errors.find(entry => entry.code === "SUPERVISOR_PAUSED").action);
  assert.equal(error.action, SUPERVISOR_PAUSED.action);
  assert.equal(error.usage, undefined);
});
