import test from "node:test";
import assert from "node:assert/strict";
import { performUpdate, launchDesktopUpdate } from "../src/update.mjs";

function fixture({ builds = ["1", "2"], processes = [[10], [20], []], phases = ["installing"], ready = true } = {}) {
  const events = []; let time = 0;
  const next = values => values.length > 1 ? values.shift() : values[0];
  return { events, deps: {
    now: () => time, sleep: async ms => { time += ms; },
    build: async () => next(builds), pids: async () => next(processes),
    ui: async op => { events.push(op); return op === "check" ? "checking" : next(phases); },
    save: async s => events.push(s.phase), quit: async () => events.push("quit"),
    start: async () => events.push("start"),
    doctor: async () => ({ ready, connection: { mode: "shared" }, checks: { bundled_wrapper_node: ready }, cli_version_status: "matched" }),
  } };
}
const options = { timeoutMs: 10000, initialBuild: "1", initialPids: [10] };
test("official update then new process, normal quit, wrapper start and verification", async () => {
  const { events, deps } = fixture();
  const result = await performUpdate(options, deps);
  assert.equal(result.phase, "complete");
  assert.equal(result.final_build, "2");
  assert.equal(result.wrapper_verified, true);
  assert.deepEqual(events, ["checking", "check", "advance", "installing", "restoring_wrapper", "quit", "start"]);
});
test("new build alone never interrupts the old process", async () => {
  const { events, deps } = fixture({ builds: ["2"], processes: [[10]] });
  await assert.rejects(performUpdate(options, deps), { code: "UPDATE_TIMEOUT" });
  assert.ok(!events.includes("quit"));
});
test("process restart alone is not a successful update", async () => {
  const { events, deps } = fixture({ builds: ["1"], processes: [[20]] });
  await assert.rejects(performUpdate(options, deps), { code: "UPDATE_TIMEOUT" });
  assert.ok(!events.includes("start"));
});
test("no update does not quit or pretend to verify wrapper", async () => {
  const { events, deps } = fixture({ phases: ["up_to_date"] });
  assert.deepEqual(await performUpdate(options, deps), { phase: "up_to_date", initial_build: "1", final_build: "1", wrapper_verified: false });
  assert.ok(!events.includes("quit"));
});
test("refused normal quit does not force kill or launch another instance", async () => {
  const { events, deps } = fixture({ builds: ["2"], processes: [[20]] });
  await assert.rejects(performUpdate(options, deps), { code: "UPDATE_QUIT_TIMEOUT" });
  assert.ok(!events.includes("start"));
});
test("failed verification cannot report completion", async () => {
  const { deps } = fixture({ ready: false });
  await assert.rejects(performUpdate(options, deps), { code: "UPDATE_WRAPPER_UNVERIFIED" });
});
test("unknown dialog times out without quitting", async () => {
  const { events, deps } = fixture({ builds: ["1"], processes: [[10]], phases: ["waiting"] });
  await assert.rejects(performUpdate(options, deps), { code: "UPDATE_TIMEOUT" });
  assert.ok(!events.includes("quit"));
});
test("dry run has no platform effects and validates timeout", async () => {
  assert.equal((await launchDesktopUpdate({ dryRun: true })).started, false);
  for (const timeoutMs of [NaN, 0, Infinity, 10000.5, 3600001]) {
    await assert.rejects(launchDesktopUpdate({ dryRun: true, timeoutMs }), { code: "UPDATE_ARGUMENT" });
  }
});

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("launcher pins saved worker, profile, cwd, detached stdio and excludes a second updater", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "update-launch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let launch, unref = false;
  const dependencies = {
    home, platform: "darwin", pids: () => [123], build: () => "11431", ui: () => "checking",
    prepare: async () => ({ directory: "/saved distribution" }),
    spawnWorker: (exe, argv, options) => {
      launch = { exe, argv, options };
      const child = new EventEmitter(); child.pid = 456; child.unref = () => { unref = true; };
      process.nextTick(() => child.emit("spawn")); return child;
    },
  };
  const result = await launchDesktopUpdate({}, dependencies);
  assert.equal(result.started, true);
  assert.equal(unref, true);
  assert.equal(launch.argv[0], "/saved distribution/bin/codexteer-update.mjs");
  assert.equal(launch.options.cwd, "/saved distribution");
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.stdio, "ignore");
  assert.equal(launch.options.env.CODEX_HOME, JSON.parse(launch.argv[1]).root.replace(/\/codex-steer\/desktop-update$/, ""));
  await assert.rejects(launchDesktopUpdate({}, dependencies), { code: "UPDATE_BUSY" });
});
test("worker spawn failure is persisted and releases the update lock", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "update-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dependencies = {
    home, platform: "darwin", pids: () => [123], build: () => "1", ui: () => "checking",
    prepare: async () => ({ directory: "/saved" }),
    spawnWorker: () => { const child = new EventEmitter(); process.nextTick(() => child.emit("error", new Error("spawn failed"))); return child; },
  };
  await assert.rejects(launchDesktopUpdate({}, dependencies), /spawn failed/);
  const status = JSON.parse(await readFile(path.join(home, "codex-steer/desktop-update/status.json")));
  assert.equal(status.phase, "failed");
  // The second failure must be spawn failure again, never a retained UPDATE_BUSY.
  await assert.rejects(launchDesktopUpdate({}, dependencies), /spawn failed/);
});

test("temporary missing bundle during installation is retried before restoring wrapper", async () => {
  const { deps, events } = fixture({ processes: [[10], [], [20], []] });
  let reads = 0;
  deps.build = async () => { if (++reads === 2) throw new Error("bundle being replaced"); return reads === 1 ? "1" : "2"; };
  assert.equal((await performUpdate(options, deps)).phase, "complete");
  assert.equal(events.filter(e => e === "quit").length, 1);
});
test("unexplained bundle inspection failure does not trigger restart", async () => {
  const { deps, events } = fixture();
  deps.build = async () => { throw new Error("cannot inspect app"); };
  await assert.rejects(performUpdate(options, deps), /cannot inspect app/);
  assert.ok(!events.includes("quit"));
});
