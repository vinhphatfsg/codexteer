import { tempPrefix } from "../test-support/temp.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { topics, helpData, renderHelp, renderErrors, errorRemedy } from "../src/help.mjs";
import * as sharedErrors from "../src/help-errors.mjs";
import { OPTIONS_INVALID, SUPERVISOR_PAUSED } from "../src/help-errors.mjs";
import { registerSupervisor, controlSupervisor } from "../src/supervision.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(root, "bin/codexteer.mjs");
const source = readdirSync(path.join(root, "src")).filter(f => f.endsWith(".mjs") && !f.startsWith("help"))
  .map(f => readFileSync(path.join(root, "src", f), "utf8")).join("\n");
const composedCodes = ["RUNTIME_PROTOCOL_UNSUPPORTED", "RUNTIME_PROTOCOL_UNVERIFIED", "CAPABILITY_UNSUPPORTED", "CAPABILITY_UNVERIFIED"];

test("help routes orchestration verbs to four operations and preserves low-level details", () => {
  const overview = helpData();
  for (const verb of ["頼む", "見る", "言う", "止める", "再開する"]) assert.ok(overview.use_cases.some(c => c.need.includes(verb)));
  assert.ok(overview.see.includes("details")); assert.ok(helpData("details").use_cases.some(c => c.command === "help supervise"));
  for (const name of ["orchestrate", "orchestrate prompt"]) {
    const notes = helpData(name).notes.join(" ");
    assert.match(notes, /Desktop Cloud/); assert.match(notes, /work start/); assert.match(notes, /project control/);
    assert.doesNotMatch(notes, /Web Cloud|--connection cloud(?:\s|$)|Codex担当は調査/);
  }
  assert.match(helpData("project").usage.join(" "), /project control pause\|stop\|resume/);
  assert.match(helpData("orchestrate prompt").returns, /cloud_command（Desktop Cloud/);
});

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
    assert.doesNotMatch(renderHelp(data), /undefined|\[object Object\]/, name);
    assert.equal(data.errors, undefined, name);
  }
});

test("help pages point to their error list, which --errors prints alone", () => {
  for (const [name, topic] of Object.entries(topics)) {
    const words = ["help", ...name.split(" ")], documented = topic.errors ?? [], data = helpData(name);
    assert.equal(data.errors_command, documented.length ? `codexteer ${words.join(" ")} --errors` : undefined, name);
    const page = renderHelp(data);
    for (const { code, action } of documented) assert.ok(!page.includes(`→ ${action}`), `${name} page still lists ${code}`);
    if (documented.length) assert.ok(page.includes(`一覧: codexteer ${words.join(" ")} --errors`), name);
    const list = JSON.parse(spawnSync(process.execPath, [BIN, ...words, "--errors", "--json"], { encoding: "utf8" }).stdout).data;
    assert.deepEqual(Object.keys(list).sort(), ["errors", "topic", "version"], name);
    assert.deepEqual(list.errors, JSON.parse(JSON.stringify(documented)), name);
    for (const error of list.errors) assert.ok(error.code && error.when && error.action, `${name} error ${error.code}`);
    const text = renderErrors(list);
    for (const { code, action } of documented) assert.ok(text.includes(`  ${code}: `) && text.includes(`→ ${action}`), `${name} --errors ${code}`);
    assert.ok(!text.includes("使い方:"), name);
  }
  const page = spawnSync(process.execPath, [BIN, "help", "send"], { encoding: "utf8" }).stdout;
  assert.equal(page, `${renderHelp(helpData("send"))}\n`);
  const errors = spawnSync(process.execPath, [BIN, "send", "--help", "--errors"], { encoding: "utf8" }).stdout;
  assert.equal(errors, `${renderErrors(helpData("send", { errors: true }))}\n`);
});

test("related topics exist and the overview reaches every topic", () => {
  const overview = JSON.stringify(topics.overview) + JSON.stringify(topics.details);
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

const usageLines = (topic, prefix) => topics[topic].usage.filter(line => line.startsWith(prefix));

test("an argument error under a connection names that connection's usage, not the local one", async t => {
  const home = await mkdtemp(tempPrefix("cs-help-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  const desktopCloud = cli(["--connection", "desktop-cloud", "thread", "create", "--json"], env).error;
  assert.equal(desktopCloud.code, "DESKTOP_CLOUD_OPTIONS_INVALID");
  assert.deepEqual(desktopCloud.usage, usageLines("thread", "--connection desktop-cloud thread create "));
  const cloud = cli(["--connection", "cloud", "thread", "receipt", "--json"], env).error;
  assert.equal(cloud.code, "CLOUD_OPTIONS_INVALID");
  assert.deepEqual(cloud.usage, usageLines("thread", "--connection cloud thread receipt "));
  const local = cli(["thread", "create", "--bogus", "--json"], env).error;
  assert.equal(local.code, "OPTIONS_INVALID");
  assert.deepEqual(local.usage, usageLines("thread", "thread create "));
  const list = cli(["--connection", "desktop-cloud", "threads", "list", "--limit", "101", "--json"], env).error;
  assert.equal(list.code, "DESKTOP_CLOUD_OPTIONS_INVALID");
  assert.deepEqual(list.usage, usageLines("threads", "--connection desktop-cloud threads list "));
  const unsupported = cli(["--connection", "desktop-cloud", "thread", "verify", "fixture-attempt", "--json"], env).error;
  assert.equal(unsupported.code, "CLOUD_OPTIONS_INVALID");
  assert.deepEqual(unsupported.usage, topics.thread.usage.filter(line => /^--connection (\S+\|)?desktop-cloud(\|\S+)? /.test(line)));
});

test("an argument error routed by its task ID names that connection's usage, as text and JSON", async t => {
  const home = await mkdtemp(tempPrefix("cs-help-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home };
  const resolve = usageLines("thread", "--connection cloud|desktop-cloud thread resolve ");
  for (const [args, usage] of [
    [["thread", "assign", "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "--bogus"], usageLines("thread", "--connection desktop-cloud thread assign ")],
    [["thread", "resolve", "durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "--bogus"], resolve],
    [["thread", "resolve", "task_e_0123456789abcdef", "--bogus"], resolve],
    [["doctor", "--thread", "task_e_0123456789abcdef", "--bogus"], usageLines("doctor", "--connection desktop|cloud|desktop-cloud doctor ")],
    [["thread", "resolve", THREAD, "--bogus"], usageLines("thread", "thread resolve ")],
  ]) {
    assert.equal(usage.length, 1, args.join(" "));
    const { status, error } = cli([...args, "--json"], env);
    assert.equal(status, 1, args.join(" "));
    assert.match(error.code, /OPTIONS_INVALID$/, args.join(" "));
    assert.deepEqual(error.usage, usage, args.join(" "));
    const text = cli(args, env);
    assert.equal(text.status, 1, args.join(" "));
    assert.deepEqual(text.stderr.split("\n").filter(line => line.startsWith("使い方: ")), usage.map(line => `使い方: codexteer ${line}`), args.join(" "));
  }
});

test("a code the invoked topic does not document carries no action borrowed from another topic", async t => {
  const home = await mkdtemp(tempPrefix("cs-help-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const documents = (topic, code) => (topics[topic].errors ?? []).some(entry => entry.code === code);
  assert.ok(documents("history", "DESKTOP_CLOUD_OPTIONS_INVALID") && !documents("threads", "DESKTOP_CLOUD_OPTIONS_INVALID"));
  const args = ["--connection", "desktop-cloud", "threads", "list", "--limit", "101"];
  const { status, error } = cli([...args, "--json"], { CODEX_HOME: home });
  assert.equal(status, 1);
  assert.equal(error.code, "DESKTOP_CLOUD_OPTIONS_INVALID");
  assert.equal(error.help, "threads");
  assert.equal(Object.hasOwn(error, "action"), false);
  const text = cli(args, { CODEX_HOME: home });
  assert.equal(text.status, 1);
  assert.equal(text.stderr.split("\n").some(line => line.startsWith("対処:")), false);
});

test("every remedy action comes from the invoked topic or the shared registry", () => {
  const shared = new Map(Object.values(sharedErrors).map(entry => [entry.code, entry.action]));
  const codes = new Set([...shared.keys(), ...Object.values(topics).flatMap(topic => (topic.errors ?? []).map(entry => entry.code))]);
  for (const name of Object.keys(topics)) for (const code of codes) {
    const own = topics[name].errors?.find(entry => entry.code === code)?.action;
    assert.equal(errorRemedy(name.split(" "), code)?.action, own ?? shared.get(code), `${name} ${code}`);
  }
});

test("a paused supervisor's refused send carries the send topic's action", async t => {
  const home = await mkdtemp(tempPrefix("cs-help-"));
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

test("thread help and bundled skill route new Cloud creation through Desktop Cloud", async () => {
  assert.ok(topics.thread.usage.some(line => line.startsWith("--connection desktop-cloud thread create ")));
  assert.equal(topics.thread.usage.some(line => line.startsWith("--connection cloud thread create ")), false);
  assert.doesNotMatch(topics.thread.when, /Web Cloudの作成/);
  const skill = readFileSync(new URL("../.codex/skills/codexteer/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(skill, /--connection cloud thread create/);
  assert.match(skill, /--connection desktop-cloud work start/);
});

test("a stopped managed task routes continuation through a new work start, not a new supervisor prompt", () => {
  for (const [argv, code] of [[["work", "tell", THREAD, "fixture"], "SUPERVISOR_STOPPED"], [["work", "start", "--project", "sample", "--title", "t", "fixture"], "MANAGED_SUPERVISOR_STOPPED"]]) {
    const remedy = errorRemedy(argv, code);
    assert.equal(remedy.help, "work", code);
    assert.match(remedy.action, /work start/, code);
    assert.match(remedy.action, /ユーザーが明示的に指示/, code);
    assert.doesNotMatch(remedy.action, /本文の生成/, code);
  }
  assert.equal(errorRemedy(["supervise", "status", THREAD], "SUPERVISOR_STOPPED").action, sharedErrors.SUPERVISOR_STOPPED.action);
});
