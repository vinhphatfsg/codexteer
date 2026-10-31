import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { withStoreLock, writeRecord, storePath } from "../src/store.mjs";

const storeUrl = new URL("../src/store.mjs", import.meta.url).href;
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/cs-store-lock-");
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home };
}
async function deadHolder(storage) {
  const dead = spawnSync("/usr/bin/true");
  assert.equal(dead.status, 0);
  await writeRecord("locks", "k", { token: "crashed-holder", pid: dead.pid }, storage);
}
// Pause a real child immediately after publishing a recovery lock. Other
// processes observe the actual PID and hard link, with no product test hooks.
async function recoverer(t, storage) {
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.promises.link;
    fs.promises.link = async (source, target) => {
      await link(source, target);
      if (target.includes('/lock-recovery/')) {
        process.send({ held: target });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    };
    syncBuiltinESMExports();
    const { withStoreLock } = await import(${JSON.stringify(storeUrl)});
    try { await withStoreLock('k', async () => process.send({ entered: true })); }
    catch (e) { process.send({ error: e.code || e.message }); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, CODEX_HOME: storage.home }, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } });
  const result = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code, signal]) => { throw new Error(`recoverer exited: ${code}/${signal}`); })
  ]);
  assert.ok(result.held, JSON.stringify(result));
  return { child, file: result.held, async crash() { child.kill("SIGKILL"); await once(child, "exit"); } };
}

test("F1: a dead holder and a legacy orphan .recover directory no longer wedge the key", async t => {
  const storage = await fixture(t);
  await deadHolder(storage);
  await mkdir(`${storePath("locks", "k", storage.home)}.recover`, { mode: 0o700 });
  assert.equal(await withStoreLock("k", async () => 42, storage), 42);
  // The legacy artifact is left alone; it no longer participates in locking.
  assert.deepEqual(await readdir(storePath("locks", null, storage.home)), ["k.json.recover"]);
});

test("a live holder is never displaced, even with a legacy orphan recovery directory", async t => {
  const storage = await fixture(t);
  await withStoreLock("k", async () => {
    await mkdir(`${storePath("locks", "k", storage.home)}.recover`, { mode: 0o700 });
    await assert.rejects(withStoreLock("k", async () => assert.fail("concurrent holder"), storage), { code: "RECORD_BUSY" });
    assert.equal(JSON.parse(await readFile(storePath("locks", "k", storage.home), "utf8")).pid, process.pid);
  }, storage);
});

test("a live recovery owner blocks entry; SIGKILL leaves a recoverable atomic owner record", { timeout: 15000 }, async t => {
  const storage = await fixture(t);
  await deadHolder(storage);
  const worker = await recoverer(t, storage);
  assert.equal(JSON.parse(await readFile(worker.file, "utf8")).pid, worker.child.pid);
  await assert.rejects(withStoreLock("k", async () => assert.fail("live recoverer displaced"), storage), { code: "RECORD_BUSY" });
  const alias = `${storage.home}-alias`;
  await symlink(storage.home, alias);
  t.after(() => rm(alias));
  await assert.rejects(withStoreLock("k", async () => assert.fail("recovery bypassed through home alias"), { home: alias }), { code: "RECORD_BUSY" });
  await worker.crash();
  assert.equal(await withStoreLock("k", async () => "recovered", storage), "recovered");
  assert.equal((await readdir(storePath("lock-recovery", null, storage.home))).filter(x => x.endsWith(".json")).length, 0);
});

test("three crashed recovery owners are recovered recursively without manual cleanup", { timeout: 20000 }, async t => {
  const storage = await fixture(t);
  await deadHolder(storage);
  const paths = new Set();
  for (let i = 0; i < 3; i++) {
    const worker = await recoverer(t, storage);
    paths.add(worker.file);
    await worker.crash();
  }
  assert.equal(paths.size, 3);
  let entered = 0, completed = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    try { await withStoreLock("k", async () => { assert.equal(entered++, 0); await new Promise(resolve => setTimeout(resolve, 10)); entered--; }, storage); completed++; }
    catch (error) { assert.equal(error.code, "RECORD_BUSY"); }
  }));
  assert.equal(entered, 0);
  assert.ok(completed > 0);
  assert.equal(await withStoreLock("k", async () => 42, storage), 42);
});
