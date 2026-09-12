import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const entrypoint = fileURLToPath(new URL("../bin/codexteer.mjs", import.meta.url));
async function fixture(t) {
  const home = await mkdtemp("/private/tmp/cs-assistance-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = `${home}/project`; await mkdir(cwd); await mkdir(`${cwd}/src`); await writeFile(`${cwd}/src/input.txt`, "original");
  return { cwd, cli(args, expectedStatus = 0) {
    const result = spawnSync(process.execPath, [entrypoint, "--json", ...args], { cwd, env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } };
}

test("CLI checkpoint workflow binds command argv and cwd, hides every run log, and detects stale inputs", async t => {
  const { cwd, cli } = await fixture(t);
  const a = cli(["checkpoint", "capture", ID, "first", "--path", "src"]).data;
  const b = cli(["checkpoint", "capture", ID, "second", "--path", "src"]).data;
  assert.equal(a.snapshot.file_count, 1); assert.equal(a.snapshot.directory_count, 1);
  const command = "const fs=require('fs'); fs.writeFileSync('report.txt',fs.readFileSync('src/input.txt')); console.log('private-log',process.argv[1]);";
  for (const cp of [a, b]) {
    const run = cli(["checkpoint", "run", ID, cp.id, "--", process.execPath, "-e", command, "--", "--json"]).data;
    assert.equal(run.valid, true); assert.equal(run.output_tail, undefined);
  }
  assert.equal(await readFile(`${cwd}/report.txt`, "utf8"), "original");
  const list = cli(["checkpoint", "list", ID]).data;
  assert.equal(list.length, 2);
  assert.ok(list.every(cp => cp.runs.every(run => run.output_tail === undefined)));
  assert.ok(!JSON.stringify(list).includes('"output_tail"'));
  const detail = cli(["checkpoint", "show", ID, b.id, "--include-output"]).data;
  assert.equal(detail.runs[0].output_tail.trim(), "private-log --json");
  cli(["checkpoint", "attach", ID, b.id, "--artifact", "report.txt"]);
  assert.equal(cli(["checkpoint", "verify", ID, b.id]).data.valid, true);
  await writeFile(`${cwd}/src/input.txt`, "changed");
  const stale = cli(["checkpoint", "verify", ID, b.id], 1);
  assert.equal(stale.ok, true); assert.equal(stale.data.valid, false);
  assert.ok(stale.data.differences.changed.includes(`${cwd}/src/input.txt`));
});

test("CLI resource workflow excludes another AI, preserves a literal command, and releases after failure", async t => {
  const { cwd, cli } = await fixture(t);
  const lease = cli(["resource", "acquire", "screen", "--owner", "claude-code", "--condition", "agreed use"]).data;
  assert.equal(cli(["resource", "status", "screen"]).data.lease.token, lease.token);
  const failed = cli(["resource", "run", "screen", "--owner", "codex", "--", process.execPath, "-e", "require('fs').writeFileSync('unexpected','bad')"], 1);
  assert.equal(failed.error.code, "RESOURCE_BUSY");
  await assert.rejects(readFile(`${cwd}/unexpected`), { code: "ENOENT" });
  cli(["resource", "release", "screen", "--token", lease.token]);
  const run = cli(["resource", "run", "screen", "--owner", "codex", "--include-output", "--", process.execPath, "-e", "console.log(process.argv[1]);process.exit(3)", "--", "--json"], 1).data;
  assert.equal(run.output_tail.trim(), "--json"); assert.equal(run.exit_code, 3);
  assert.equal(run.valid, false); assert.equal(run.released, true);
  assert.equal(cli(["resource", "status", "screen"]).data.state, "released");
});
