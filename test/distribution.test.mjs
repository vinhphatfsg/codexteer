import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, lstat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describeDistribution, prepareDeployment } from "../src/distribution.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp("/private/tmp/cs-distribution-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), sourceRoot = path.join(root, "source");
  await mkdir(home, { mode: 0o700 }); await mkdir(sourceRoot, { mode: 0o700 });
  const distribution = await describeDistribution();
  for (const file of distribution.manifest.files) {
    const target = path.join(sourceRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, distribution.contents.get(file.path), { mode: file.mode });
  }
  return { root, home, sourceRoot, options: { sourceRoot }, distribution };
}

test("a complete deployment runs outside the repository after the source/cache is deleted", async t => {
  const { root, home, sourceRoot, options, distribution } = await fixture(t);
  const first = await prepareDeployment(home, options), again = await prepareDeployment(home, options);
  assert.equal(first.reused, false); assert.equal(again.reused, true);
  assert.equal(first.wrapper_path, again.wrapper_path);
  assert.equal((await lstat(first.wrapper_path)).mode & 0o777, 0o700);
  assert.equal((await lstat(first.directory)).mode & 0o777, 0o700);
  await rm(sourceRoot, { recursive: true });
  const { stdout } = await exec(process.execPath, [path.join(first.directory, "bin/codexteer.mjs"), "--version"], { cwd: root, env: { ...process.env, CODEX_HOME: home } });
  assert.equal(stdout.trim(), distribution.manifest.version);
});

test("concurrent installers reuse one complete deployment without replacing it", async t => {
  const { home, options } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => prepareDeployment(home, options)));
  assert.equal(new Set(results.map(r => r.directory)).size, 1);
  assert.equal(results.filter(r => !r.reused).length, 1);
});

test("same version with changed contents gets another deployment and preserves the old files", async t => {
  const { home, sourceRoot, options } = await fixture(t);
  const first = await prepareDeployment(home, options);
  const file = "src/prompt.mjs", old = await readFile(path.join(first.directory, file), "utf8");
  await writeFile(path.join(sourceRoot, file), old + "\n// Changed source fixture\n");
  const second = await prepareDeployment(home, options);
  assert.equal(first.version, second.version); assert.notEqual(first.directory, second.directory);
  assert.equal(await readFile(path.join(first.directory, file), "utf8"), old);
});

test("reusing a modified deployment never repairs or overwrites it", async t => {
  const { home, options } = await fixture(t);
  const first = await prepareDeployment(home, options), file = path.join(first.directory, "src/prompt.mjs");
  await writeFile(file, "tampered");
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_MODIFIED" });
  assert.equal(await readFile(file, "utf8"), "tampered");
});

test("an untrusted manifest cannot redirect verification or bless altered files", async t => {
  const { home, options } = await fixture(t);
  const first = await prepareDeployment(home, options);
  await writeFile(path.join(first.directory, ".codex-steer-runtime.json"), JSON.stringify({ manifest: { files: [{ path: "../../outside" }] }, sha256: first.sha256 }));
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_MODIFIED" });
});

test("deployment roots and destination symlinks are refused without touching their targets", async t => {
  const { root, home, options, distribution } = await fixture(t);
  const outside = path.join(root, "outside"); await mkdir(outside, { mode: 0o700 });
  const stateRoot = path.join(home, "codex-steer"); await symlink(outside, stateRoot);
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_UNSAFE" });
  await rm(stateRoot); await mkdir(stateRoot, { mode: 0o700 });
  const runtimeRoot = path.join(stateRoot, "runtimes"); await mkdir(runtimeRoot, { mode: 0o700 });
  await symlink(outside, path.join(runtimeRoot, distribution.id));
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_UNSAFE" });
  assert.equal((await lstat(outside)).isDirectory(), true);
});

test("unsafe modes, leaf symlinks and hardlinks are rejected on reuse", async t => {
  for (const attack of ["mode", "symlink", "hardlink"]) {
    const { root, home, options } = await fixture(t), first = await prepareDeployment(home, options);
    const file = path.join(first.directory, "src/prompt.mjs");
    if (attack === "mode") await chmod(file, 0o666);
    else {
      const outside = path.join(root, "outside"); await writeFile(outside, "do not touch", { mode: 0o600 });
      await rm(file); await (attack === "symlink" ? symlink : link)(outside, file);
    }
    await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_UNSAFE" });
  }
});

test("source symlinks and traversal in a source version cannot create a deployment", async t => {
  const { root, home, sourceRoot, options } = await fixture(t);
  const pkgPath = path.join(sourceRoot, "package.json"), pkg = JSON.parse(await readFile(pkgPath));
  await writeFile(pkgPath, JSON.stringify({ ...pkg, version: "../../escape" }));
  await assert.rejects(prepareDeployment(home, options), /Invalid distribution version/);
  await writeFile(pkgPath, JSON.stringify(pkg));
  const source = path.join(sourceRoot, "src/prompt.mjs"), outside = path.join(root, "outside");
  await writeFile(outside, "do not read"); await rm(source); await symlink(outside, source);
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_UNSAFE" });
});

test("a private CODEX_HOME beneath a writable non-sticky ancestor is refused", async t => {
  const { root, home, options } = await fixture(t);
  await chmod(root, 0o777);
  await assert.rejects(prepareDeployment(home, options), { code: "DEPLOYMENT_UNSAFE" });
  await chmod(root, 0o700);
});

test("a fresh nested CODEX_HOME is created privately and a configured home symlink is canonicalized", async t => {
  const { root, options } = await fixture(t), home = path.join(root, "new", "home");
  const first = await prepareDeployment(home, options);
  assert.equal((await lstat(home)).mode & 0o777, 0o700);
  const alias = path.join(root, "home-alias"); await symlink(home, alias);
  const second = await prepareDeployment(alias, options);
  assert.equal(first.directory, second.directory); assert.equal(second.reused, true);
});
