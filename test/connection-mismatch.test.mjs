import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { taskConnection } from "../src/task-id.mjs";
import { desktopCloudId, desktopCloudLink } from "../src/desktop-cloud-id.mjs";
import { cloudConnection } from "../src/cloud-connection.mjs";

const local = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", durable = `durable_${local}`, cloud = "task_fixture_mismatch";
const bin = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "connection-mismatch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, run: args => {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: home, CODEX_HOME: home },
    });
    assert.ifError(result.error);
    return result;
  } };
}
function hint(error, expected, selected, code = "CLOUD_TARGET_CONFLICT") {
  assert.equal(error.code, code);
  assert.equal(error.expected_connection, expected);
  assert.equal(error.connection, selected);
  assert(error.message.includes(`--connection ${expected}`));
  return true;
}

test("CLI connection mismatches provide actionable JSON without accessing a backend or writing records", async t => {
  const { home, run } = await fixture(t);
  for (const [target, expected, selections, code] of [
    [durable, "desktop-cloud", ["shared", "desktop"]],
    [desktopCloudLink(durable), "desktop-cloud", ["shared", "desktop"]],
    [cloud, "cloud", ["shared", "desktop", "desktop-cloud"]],
    [`https://chatgpt.com/codex/tasks/${cloud}`, "cloud", ["shared", "desktop", "desktop-cloud"]],
    [local, "shared", ["desktop-cloud"]],
    [`codex://threads/${local}`, "shared", ["desktop-cloud"]],
    // These were rejected by the Web Cloud ID validator, with this code.
    [durable, "desktop-cloud", ["cloud"], "CLOUD_OPTIONS_INVALID"],
    [local, "shared", ["cloud"], "CLOUD_OPTIONS_INVALID"],
  ]) {
    for (const selected of selections) {
      const result = run(["--connection", selected, "supervise", "status", target, "--json"]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false);
      hint(output.error, expected, selected, code);
    }
  }
  assert.deepEqual(await readdir(home), []);
});

test("plain errors and different command shapes retain the same correction, ignoring option values and forwarded text", async t => {
  const { run } = await fixture(t);
  for (const [selected, target, expected] of [["shared", durable, "desktop-cloud"], ["desktop", durable, "desktop-cloud"], ["desktop-cloud", local, "shared"]]) {
    const result = run(["--connection", selected, "supervise", "status", target]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert(result.stderr.includes(`--connection ${expected}`));
  }
  for (const args of [
    ["read", "--source", cloud, durable],
    ["doctor", "--thread", durable],
    ["resource", "status", "fixture", "--thread", durable],
    ["findings", "create", "--key", cloud, durable],
    ["supervise", "stop", durable],
    ["supervise", "prompt", durable, "--", "--connection", "cloud"],
    ["send", durable, cloud],
    [durable, cloud],
  ]) {
    const result = run(["--connection", "shared", ...args, "--json"]);
    assert.equal(result.status, 1);
    hint(JSON.parse(result.stdout).error, "desktop-cloud", "shared");
  }
});

test("valid explicit and omitted connections keep identical offline supervision status", async t => {
  const { run } = await fixture(t);
  for (const [target, connection] of [[local, "shared"], [durable, "desktop-cloud"], [cloud, "cloud"]]) {
    const args = ["supervise", "status", target, "--json"];
    const implicit = run(args), explicit = run(["--connection", connection, ...args]);
    assert.equal(implicit.status, 0, implicit.stdout + implicit.stderr);
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout), JSON.parse(implicit.stdout));
  }
});

test("shared task helpers reject mismatched connections with a corrective hint and keep default resolution", () => {
  for (const [target, selected, expected] of [
    [durable, "desktop", "desktop-cloud"], [durable, "cloud", "desktop-cloud"],
    [cloud, "desktop", "cloud"], [cloud, "desktop-cloud", "cloud"],
    [local, "cloud", "shared"], [local, "desktop-cloud", "shared"],
  ]) assert.throws(() => taskConnection(target, selected), error => hint(error, expected, selected));
  assert.throws(() => desktopCloudId(local), error => hint(error, "shared", "desktop-cloud"));
  assert.throws(() => desktopCloudId(cloud), error => hint(error, "cloud", "desktop-cloud"));
  assert.equal(taskConnection(durable), "desktop-cloud");
  assert.equal(taskConnection(cloud), "cloud");
  assert.equal(taskConnection(local), "shared");
  assert.equal(taskConnection(local, "desktop"), "desktop");
});

test("host routing, UI backend, ambiguous links and invalid IDs keep their existing errors without connection hints", async t => {
  const { run } = await fixture(t);
  for (const args of [
    ["--connection", "desktop-cloud", "--host", "local", "supervise", "status", durable],
    ["--connection", "cloud", "doctor", "--backend", "ui", "--thread", cloud],
    ["--connection", "cloud", "send", cloud, "fixture", "--backend", "ui", "--dry-run"],
    ["--connection", "desktop-cloud", "supervise", "status", desktopCloudLink(durable) + "&hostId=local"],
    ["--connection", "desktop-cloud", "supervise", "status", "invalid-id"],
  ]) {
    const result = run([...args, "--json"]);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "CLOUD_TARGET_CONFLICT");
    assert(!Object.hasOwn(error, "expected_connection"));
    assert(!Object.hasOwn(error, "connection"));
  }
  await assert.rejects(cloudConnection().connect("another-endpoint"), error => {
    assert.equal(error.code, "CLOUD_TARGET_CONFLICT");
    assert(!Object.hasOwn(error, "expected_connection"));
    return true;
  });
});

test("an option value documented in help is never read as the routing target", async () => {
  const { topics } = await import("../src/help.mjs");
  const { selectedCloudInvocation } = await import("../src/task-id.mjs");
  const options = new Set();
  for (const topic of Object.values(topics)) for (const line of topic.usage ?? []) {
    for (const match of line.matchAll(/(--[a-z][a-z-]*)[ =]([A-Z][A-Z_|-]*|N)\b/g)) options.add(match[1]);
  }
  assert.ok(options.has("--event-offset") && options.has("--work"));
  for (const option of options) assert.equal(selectedCloudInvocation([option, cloud, "read", local]), false, option);
});

test("work tell routes a Desktop Cloud target automatically and refuses the observation-only connection", async t => {
  const { run } = await fixture(t);
  const error = args => JSON.parse(run([...args, "--json"]).stdout).error;
  assert.equal(error(["work", "tell", durable, "fixture"]).code, "WORK_TELL_UNMANAGED");
  assert.equal(error(["work", "tell", desktopCloudLink(durable), "fixture"]).code, "WORK_TELL_UNMANAGED");
  assert.equal(error(["--connection", "desktop", "work", "tell", local, "fixture"]).code, "DESKTOP_READ_ONLY");
  assert.equal(error(["work", "tell", local, "fixture"]).code, "WORK_TELL_UNMANAGED");
});
