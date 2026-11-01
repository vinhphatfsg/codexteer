import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { topics, helpData, renderHelp } from "../src/help.mjs";

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
