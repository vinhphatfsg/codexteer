import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { claimRuntime, discoverRuntime, readRuntime, runtimePaths } from "../src/runtime.mjs";

async function setup(t) {
  const home = await mkdtemp("/private/tmp/cs-home-test-");
  const paths = await runtimePaths(home);
  t.after(async () => { await rm(paths.directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  return { home, paths };
}

test("runtime sockets fit macOS paths and separate CODEX_HOME instances", async t => {
  const { home, paths } = await setup(t);
  assert.ok(Buffer.byteLength(paths.socket) < 104);
  assert.ok(Buffer.byteLength(paths.control) < 104);
  assert.notEqual(paths.socket, (await runtimePaths(home + "/other")).socket);
});

test("runtime ownership and live duplicate protection", async t => {
  const { home, paths } = await setup(t);
  const lease = await claimRuntime(home);
  await lease.update({ server_pid: process.pid, desktop_connected: true });
  const record = await readRuntime(paths);
  assert.equal(record.desktop_connected, true);
  await assert.rejects(claimRuntime(home), /already owns/);
  await lease.release();
  await assert.rejects(readRuntime(paths), { code: "ENOENT" });
});

test("unsafe permissions fail closed", async t => {
  const { home, paths } = await setup(t);
  await claimRuntime(home);
  await chmod(paths.state, 0o644);
  await assert.rejects(readRuntime(paths), { code: "RUNTIME_UNSAFE" });
  await assert.rejects(discoverRuntime(home), { code: "RUNTIME_UNSAFE" });
});

test("discovery distinguishes missing, not-ready and malformed runtime state", async t => {
  const { home, paths } = await setup(t);
  await assert.rejects(discoverRuntime(home), { code: "RUNTIME_UNAVAILABLE" });
  await claimRuntime(home);
  await assert.rejects(discoverRuntime(home), { code: "RUNTIME_NOT_READY" });
  for (const contents of ["invalid json", "null", "{}", '{"schema":2}']) {
    await writeFile(paths.state, contents, { mode: 0o600 });
    await assert.rejects(discoverRuntime(home), { code: "RUNTIME_INVALID" });
  }
});

test("concurrent recovery cannot replace a newly acquired lease", async t => {
  const { home, paths } = await setup(t);
  await claimRuntime(home);
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }).pid;
  const record = JSON.parse(await readFile(paths.state, "utf8"));
  await writeFile(paths.state, JSON.stringify({ ...record, pid: dead }), { mode: 0o600 });
  const attempts = await Promise.allSettled([claimRuntime(home), claimRuntime(home)]);
  const winners = attempts.filter(r => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  const current = await readRuntime(paths);
  assert.notEqual(current.instance, record.instance);
  assert.equal(current.pid, process.pid);
  await winners[0].value.release();
});
