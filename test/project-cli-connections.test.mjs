import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tempPrefix } from "../test-support/temp.mjs";
import { helpData } from "../src/help.mjs";

const TOKEN = "11111111-1111-4111-8111-000000000009", THREAD = "11111111-1111-4111-8111-000000000001";

// One runnable call per usage line of `help project`, against a project with no
// members, so no call reaches a backend.
const calls = {
  "project control pause|stop|resume --project ID --all": ["control", "pause", "--project", "P", "--all"],
  "project control pause|stop|resume --project ID --work THREAD": ["control", "stop", "--project", "P", "--work", THREAD],
  "project sync --project ID [--byte-budget N]": ["sync", "--project", "P", "--byte-budget", "8000"],
  "project sync --project ID --exclude-unreadable THREAD --reason TEXT": ["sync", "--project", "P", "--exclude-unreadable", THREAD, "--reason", "gone"],
  "project sync --continue TOKEN --offset N --event-offset N [--byte-budget N]": ["sync", "--continue", TOKEN, "--offset", "0", "--event-offset", "0", "--byte-budget", "8000"],
  "project wait --project ID [--timeout-ms N] [--json]": ["wait", "--project", "P", "--timeout-ms", "0"],
  "project guard --project ID": ["guard", "--project", "P"],
  "project guard --project ID --status [--json]": ["guard", "--project", "P", "--status"],
  "project event TOKEN": ["event", TOKEN],
  "project prune --project ID": ["prune", "--project", "P"],
};

test("every project usage in help parses the same way on the local and the cloud command lines", async t => {
  const home = await mkdtemp(tempPrefix("ct-project-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(helpData("project").usage, Object.keys(calls), "each usage line has a call here");
  const run = (connection, args) => {
    const result = spawnSync(process.execPath, ["bin/codexteer.mjs", ...connection, "project", ...args, "--json"],
      { cwd: new URL("../", import.meta.url), env: { ...process.env, CODEX_HOME: home }, encoding: "utf8" });
    const output = JSON.parse(result.stdout);
    return { exit: result.status, ok: output.ok, command: output.command, error: output.error?.code, stop_hook: output.data?.stop_hook, hook: "ok" in output ? undefined : output };
  };
  const differences = [];
  for (const [usage, args] of Object.entries(calls)) {
    const local = run([], args);
    assert.doesNotMatch(local.error ?? "", /OPTIONS_INVALID$/, `${usage}: the local command line accepts its own usage`);
    for (const connection of ["desktop-cloud", "cloud"]) {
      const cloud = run(["--connection", connection], args);
      if (JSON.stringify(cloud) !== JSON.stringify(local)) differences.push({ usage, connection, local, cloud });
    }
  }
  assert.deepEqual(differences, []);
});
