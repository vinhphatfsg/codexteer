import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createCheckpoint, runCheckpoint, verifyCheckpoint, attachArtifacts, getCheckpoint } from "../src/checkpoint.mjs";
import { prepareDirective } from "../src/directive.mjs";
import { runCommand } from "../src/runner.mjs";

const ID = "01a04373-3770-71e0-a2e3-a3c196f5f5b1";
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/cs-checkpoint-"); t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(`${home}/project`); await mkdir(`${home}/project/src`); await writeFile(`${home}/project/src/input.txt`, "original");
  const options = { home, cwd: `${home}/project`, paths: ["src"] };
  const cp = await createCheckpoint(ID, "tests", options); return { ...options, id: cp.id };
}

test("checkpoint binds a real command, inputs and artifact; later input/artifact changes invalidate it", async t => {
  const f = await fixture(t);
  const r = await runCheckpoint(ID, f.id, [process.execPath, "-e", "require('fs').writeFileSync('result.xml','passed')"], f);
  assert.equal(r.valid, true);
  await attachArtifacts(ID, f.id, [`${f.cwd}/result.xml`], f);
  assert.equal((await verifyCheckpoint(ID, f.id, f)).valid, true);
  const directive = await prepareDirective(ID, "go", { checkpoint: f.id }, "id", f);
  await directive.beforeSend({});
  await writeFile(`${f.cwd}/result.xml`, "changed");
  assert.equal((await verifyCheckpoint(ID, f.id, f)).valid, false);
  await assert.rejects(directive.beforeSend({}), { code: "STALE_CHECKPOINT" });
  await writeFile(`${f.cwd}/src/new.txt`, "added");
  const v = await verifyCheckpoint(ID, f.id, f);
  assert.equal(v.inputs_current, false); assert.ok(v.differences.added.includes(`${f.cwd}/src/new.txt`));
  await assert.rejects(runCheckpoint(ID, f.id, [process.execPath, "-e", "process.exit(0)"], f), /Inputs changed/);
});

test("editing inputs during a successful test invalidates the run, including edit then restore", async t => {
  const f = await fixture(t);
  const script = "const fs=require('fs'); fs.writeFileSync('src/input.txt','edited'); setTimeout(()=>{fs.writeFileSync('src/input.txt','original')},100);";
  const result = await runCheckpoint(ID, f.id, [process.execPath, "-e", script], f);
  assert.equal(result.exit_code, 0); assert.equal(result.valid, false);
  // macOS may deliver fs.watch events after this short command has exited.
  // A snapshot metadata change also proves that edit-and-restore was detected.
  const input = `${f.cwd}/src/input.txt`;
  assert.ok(result.touched_paths.includes(input) || result.differences.changed.includes(input));
  assert.equal((await verifyCheckpoint(ID, f.id, f)).valid, false);
});

test("failed commands, missing executables and timeouts never validate or attach artifacts", async t => {
  const f = await fixture(t);
  assert.equal((await runCheckpoint(ID, f.id, [process.execPath, "-e", "process.exit(2)"], f)).valid, false);
  await assert.rejects(attachArtifacts(ID, f.id, [`${f.cwd}/src/input.txt`], f), /successful run/);
  const missing = await runCheckpoint(ID, f.id, ["/definitely/missing/codexteer-command"], f);
  assert.equal(missing.valid, false); assert.match(missing.error, /ENOENT/);
  const timed = await runCheckpoint(ID, f.id, [process.execPath, "-e", "setTimeout(()=>{},10000)"], { ...f, timeoutMs: 100 });
  assert.equal(timed.timed_out, true); assert.equal(timed.valid, false);
  await assert.rejects(getCheckpoint("01a04373-3770-71e0-a2e3-a3c196f5f5b2", f.id, f), /not found/);
});

test("runner preserves literal arguments without shell expansion and bounds captured output", async t => {
  const f = await fixture(t);
  const result = await runCommand([process.execPath, "-e", "console.log(process.argv[1]);", "$(touch not-created)"], f);
  assert.equal(result.output_tail.trim(), "$(touch not-created)");
  const large = await runCommand([process.execPath, "-e", "console.log('a'.repeat(40000))"], f);
  assert.equal(large.output_truncated, true); assert.equal(large.output_tail.length, 32768);
});

test("explicit exclusions do not invalidate inputs when output files change", async t => {
  const f = await fixture(t); await mkdir(`${f.cwd}/src/generated`);
  const cp = await createCheckpoint(ID, "excluded", { ...f, excludes: ["src/generated"] });
  const result = await runCheckpoint(ID, cp.id, [process.execPath, "-e", "require('fs').writeFileSync('src/generated/out','output')"], f);
  assert.equal(result.valid, true, JSON.stringify(result));
});
