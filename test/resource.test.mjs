import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { acquireResource, releaseResource, renewResource, resourceStatus, runWithResource } from "../src/resource.mjs";

async function fixture(t) { const home = await mkdtemp("/private/tmp/cs-resource-"); t.after(() => rm(home, { recursive: true, force: true })); return { home }; }

test("leases exclude another owner and record conditions without interpreting them as permissions", async t => {
  const f = await fixture(t); let now = 100000;
  const a = await acquireResource("screen", { ...f, now: () => now, owner: "claude-code", condition: "user permission recorded", ttlMs: 1000 });
  await assert.rejects(acquireResource("screen", { ...f, now: () => now, owner: "codex" }), { code: "RESOURCE_BUSY" });
  assert.equal((await resourceStatus("screen", { ...f, now: () => now })).lease.condition, "user permission recorded");
  now += 1001;
  assert.equal((await resourceStatus("screen", { ...f, now: () => now })).state, "expired");
  const b = await acquireResource("screen", { ...f, now: () => now, owner: "codex" });
  await assert.rejects(releaseResource("screen", a.token, f), /does not match/);
  await assert.rejects(renewResource("screen", a.token, f), /no longer owned/);
  await releaseResource("screen", b.token, f);
  assert.equal((await resourceStatus("screen", f)).state, "released");
});

test("resource run holds and renews the lease, releases it on command failure", async t => {
  const f = await fixture(t);
  const running = runWithResource("unity", [process.execPath, "-e", "setTimeout(()=>process.exit(3),1500)"], { ...f, owner: "codex", ttlMs: 1000 });
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(acquireResource("unity", { ...f, owner: "claude-code" }), /held/);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await resourceStatus("unity", f)).state, "held");
  const result = await running;
  assert.equal(result.exit_code, 3); assert.equal(result.valid, false); assert.equal(result.released, true);
  assert.equal((await resourceStatus("unity", f)).state, "released");
});

test("loss of lease stops only the command started by resource run", async t => {
  const f = await fixture(t);
  const running = runWithResource("git", [process.execPath, "-e", "setTimeout(()=>{},20000)"], { ...f, owner: "codex", ttlMs: 1000 });
  await new Promise(r => setTimeout(r, 100));
  const old = (await resourceStatus("git", f)).lease;
  await releaseResource("git", old.token, f);
  const replacement = await acquireResource("git", { ...f, owner: "other" });
  const result = await running;
  assert.equal(result.valid, false); assert.ok(result.lease_error); assert.equal(result.signal, "SIGTERM");
  assert.equal((await resourceStatus("git", f)).lease.token, replacement.token);
});

test("concurrent claims have at most one winner and a busy run executes nothing", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([acquireResource("one", { ...f, owner: "a" }), acquireResource("one", { ...f, owner: "b" })]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const marker = `${f.home}/should-not-exist`;
  await assert.rejects(runWithResource("one", [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1],'bad')", marker], { ...f, owner: "c" }), /held/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
