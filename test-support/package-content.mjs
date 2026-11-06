// Offline package/content checks: no shared Desktop socket or account is used.
import { tempPrefix } from "./temp.mjs";
import { assertOrchestrationContent } from "./prompt-contract.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile, readdir, lstat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeDistribution } from "../src/distribution.mjs";

const withoutSession = text => text.replaceAll(/--supervisor '[0-9a-f-]{36}'/g, "--supervisor '<SESSION>'").replaceAll(/codexteer-s-[0-9a-f]{12}/g, "codexteer-s-<SESSION>");
const exec = promisify(execFile), repo = fileURLToPath(new URL("../", import.meta.url));
export async function preparePackageContent() {
  const fixture = {};
  const root = await mkdtemp(tempPrefix("cs-package-"));
  const cache = path.join(root, "npm-cache"), workspace = path.join(root, "consumer"), home = path.join(root, "codex-home");
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, npm_config_cache: cache,
    npm_config_userconfig: path.join(root, "empty-npmrc"), npm_config_globalconfig: path.join(root, "empty-global-npmrc") };
  const ID = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222";
  try {
  await mkdir(home, { mode: 0o700 }); await mkdir(workspace);
  const cloudDocs = new Set(["docs/cloud.md", "docs/desktop-cloud.md", "docs/cloud-models-verification.md"]);
  const source = await describeDistribution(repo);
  const sourcePackage = JSON.parse(source.contents.get("package.json"));
  assert.equal(sourcePackage.name, "codexteer");
  // npm publish --dry-run skips libnpmpublish's EPRIVATE guard, so check the
  // release metadata explicitly as well as exercising npm's publish preparation.
  assert.equal(Object.hasOwn(sourcePackage, "private"), false, "Release package must not disable publication");
  assert.deepEqual(sourcePackage.bin, { "codexteer": "bin/codexteer.mjs" });
  assert.equal(sourcePackage.publishConfig.access, "public");
  assert.equal(sourcePackage.publishConfig.registry, "https://registry.npmjs.org/");
  const { stdout } = await exec("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, env });
  const [artifact] = JSON.parse(stdout);
  assert.equal(artifact.name, source.manifest.package);
  const required = new Set([...source.manifest.files.map(f => f.path), "README.md", "CHANGELOG.md", "docs/distribution.md", "docs/orchestration.md", "docs/remote-observation.md", "docs/remote-control.md", "docs/remote-device-enrollment.md", "docs/remote-operations.md", "docs/thread-create.md"]);
  for (const file of artifact.files) {
    assert.ok(required.delete(file.path) || cloudDocs.delete(file.path), `Unexpected or duplicate packed file: ${file.path}`);
    if (file.path.startsWith("bin/")) assert.ok(file.mode & 0o100, "packed executable lost its mode");
  }
  assert.deepEqual([...required], [], "Required files are absent from the real tarball");
  assert.deepEqual([...cloudDocs], [], "Cloud documentation is absent from the real tarball");
  const tarball = path.join(root, artifact.filename);
  // Scrubbed credentials, offline mode, dry-run and an explicit loopback registry
  // keep this check separate from real publication, even on a logged-in machine.
  const preview = await exec("npm", ["publish", "--dry-run", "--offline", "--ignore-scripts", "--json", "--access", "public", "--registry", "http://127.0.0.1:9/"], { cwd: repo, env, timeout: 20000 });
  assert.doesNotMatch(preview.stderr, /auto-corrected|errors corrected|invalid and removed/i, "Publish must not repair or remove release metadata");
  const publishPreview = JSON.parse(preview.stdout);
  const publishArtifact = publishPreview[sourcePackage.name] ?? publishPreview;
  assert.equal(publishArtifact.name, sourcePackage.name);
  assert.equal(publishArtifact.version, sourcePackage.version);
  assert.equal(publishArtifact.shasum, artifact.shasum, "Publish preparation must pack the tested artifact");
  const executed = await exec("npm", ["exec", "--offline", "--yes", "--package", tarball, "--", "codexteer", "desktop", "start", "--dry-run", "--json"], { cwd: root, env });
  assert.equal(JSON.parse(executed.stdout).data.started, false);

  // npx must pass a prompt bound to a saved copy of its tarball, even if another CLI
  // is on PATH. The fake agent executes only the prompt's read-only version check.
  const agentBin = path.join(root, "agent-bin"); await mkdir(agentBin);
  await symlink(process.execPath, path.join(agentBin, "node"));
  await writeFile(path.join(agentBin, "codexteer"), '#!/bin/sh\necho wrong-cli >&2\nexit 91\n', { mode: 0o755 });
  await writeFile(path.join(agentBin, "claude"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const prompt = process.argv.at(-1);
const command = prompt.split("\\n").find(line => line.endsWith(" --version"));
if (!command) throw new Error("Missing bound version check");
const commandEnv = command.startsWith("codexteer ") ? process.env : { ...process.env, PATH: "/no-supervisor-cli-on-path" };
const result = spawnSync("/bin/sh", ["-c", command], { env: commandEnv, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
console.log(JSON.stringify({ prompt, version: result.stdout.trim() }));
`, { mode: 0o755 });
  const npxEnv = { ...env, PATH: `${agentBin}:${env.PATH}` };
  await symlink(path.join(agentBin, "claude"), path.join(agentBin, "codex"));
  const npxArgs = ["--offline", "--yes", "--ignore-scripts", `file:${tarball}`];
  const orchestration = JSON.parse((await exec("npx", [...npxArgs, "orchestrate", "prompt", "--project", "Package test", "Verify the user outcome", "--agent", "codex", "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(orchestration.command, "orchestrate.prompt");
  assert.equal(orchestration.data.goal, "Verify the user outcome");
  assert.equal(orchestration.data.agent, "codex");
  assert.equal(orchestration.data.deployment.directory, path.join(home, "codex-steer/runtimes", source.id));
  assertOrchestrationContent(orchestration.data.prompt);
  const threadHelp = JSON.parse((await exec("npx", [...npxArgs, "help", "thread", "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.ok(threadHelp.data.usage.some(usage => usage.startsWith("thread verify <ATTEMPT-ID>")));
  const modelHelp = JSON.parse((await exec("npx", [...npxArgs, "help", "models", "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.ok(modelHelp.data.usage.includes("--connection desktop-cloud models select"));
  const modelDefaults = JSON.parse((await exec("npx", [...npxArgs, "--connection", "desktop-cloud", "models", "show", "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(modelDefaults.data.saved, null);
  for (const agent of ["claude", "codex"]) for (const pathMode of [false, true]) {
    const launched = JSON.parse((await exec("npx", [...npxArgs, "orchestrate", "--project", "Package test", "Verify the user outcome", "--agent", agent,
      ...(pathMode ? ["--use-path-cli"] : []), "--", "--model", "fixture-model", "--json"], { cwd: workspace, env: npxEnv, timeout: 20000 })).stdout);
    assert.equal(launched.version, sourcePackage.version);
    assertOrchestrationContent(launched.prompt);
    if (pathMode) assert.match(launched.prompt, /^codexteer --connection shared --version$/m);
    else assert.ok((await readFile(launched.prompt.split("\n").find(line => line.endsWith(" --version")).slice(0, -" --version".length), "utf8")).includes(`/codex-steer/runtimes/${source.id}/`), "The project launcher runs the content-addressed saved CLI");
  }
  assert.equal(await lstat(path.join(home, "codex-steer", "supervisors")).catch(error => { if (error.code !== "ENOENT") throw error; return null; }), null);
  const agent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, "--agent", "claude"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(agent.version, sourcePackage.version);
  const codexAgent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, "--agent", "codex"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  assert.equal(codexAgent.version, sourcePackage.version);
  assert.match(codexAgent.prompt, /--owner codex/);
  const agentCommand = agent.prompt.split("\n").find(line => line.endsWith(" --version")).slice(0, -" --version".length);
  assert.match(agentCommand, new RegExp(`^${home}/codex-steer/bin/codexteer-s-[0-9a-f]{12}$`), "The agent must receive one launcher word");
  assert.ok((await readFile(agentCommand, "utf8")).includes(`${home}/codex-steer/runtimes/${source.id}/`), "The launcher must run a content-addressed saved path");
  assert.equal(agent.prompt.includes(`${cache}/_npx/`), false, "The agent must not depend on the mutable npx cache");
  assert.equal(agent.prompt.includes(repo), false, "The packaged prompt must not bind to the development checkout");
  const copiedPrompt = JSON.parse((await exec("npx", [...npxArgs, "supervise", "prompt", ID, "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout).data.prompt;
  assert.equal(withoutSession(copiedPrompt), withoutSession(agent.prompt), "Direct launch and copy/paste must use the same invocation");
  const pathHome = path.join(root, "path-prompt-home");
  const pathPrompt = JSON.parse((await exec("npx", [...npxArgs, "supervise", "prompt", ID, "--use-path-cli", "--json"], { cwd: root, env: { ...npxEnv, CODEX_HOME: pathHome }, timeout: 20000 })).stdout).data;
  assert.equal(pathPrompt.cli_mode, "path");
  assert.equal(pathPrompt.deployment, null); assert.equal(pathPrompt.node, null);
  assert.match(pathPrompt.prompt, /^codexteer --supervisor '[0-9a-f-]{36}' --connection shared --version$/m);
  assert.doesNotMatch(pathPrompt.prompt, /CODEX_HOME=|--require-node-version|codex-steer\/runtimes/);
  assert.equal(await lstat(pathHome).catch(error => { if (error.code !== "ENOENT") throw error; return null; }), null);
  const policy = '  セキュリティの問題だけを報告し、Codexへは送信しないでください。\n"quotes" $(touch INJECTED) `touch INJECTED_TOO` {{threadId}}  ';
  const customAgent = JSON.parse((await exec("npx", [...npxArgs, "supervise", ID, policy], { cwd: root, env: npxEnv, timeout: 20000 })).stdout);
  const customPrompt = JSON.parse((await exec("npx", [...npxArgs, "supervise", "prompt", ID, policy, "--json"], { cwd: root, env: npxEnv, timeout: 20000 })).stdout).data;
  assert.equal(customAgent.version, sourcePackage.version);
  assert.equal(withoutSession(customAgent.prompt), withoutSession(customPrompt.prompt), "Both npx forms must compose the same custom policy, with Claude as the default agent");
  assert.ok(customPrompt.prompt.includes(`\n\n${policy}\n\n2. 必ず守ること\n`), "Custom text must be preserved as literal policy text ahead of the mechanics");
  assert.equal(withoutSession(customPrompt.prompt.split("\n\n2. 必ず守ること\n")[1]), withoutSession(copiedPrompt.split("\n\n2. 必ず守ること\n")[1]), "A custom policy must retain the mandatory template");
  assert.doesNotMatch(customPrompt.prompt, /不要な抽象化・汎用化|変化のない定期報告は控え/);
  assert.equal(customPrompt.deployment.sha256, source.sha256);
  assert.equal(customPrompt.deployment.reused, true);
  const consumerFiles = await readdir(root);
  assert.equal(consumerFiles.includes("INJECTED"), false);
  assert.equal(consumerFiles.includes("INJECTED_TOO"), false);
  const savedVersionCommand = copiedPrompt.split("\n").find(line => line.endsWith(" --version"));
  // Simulate a later npx run replacing the same cached package with another version.
  let updatedPackages = 0;
  for (const entry of await readdir(path.join(cache, "_npx"))) {
    const pkgPath = path.join(cache, "_npx", entry, "node_modules", sourcePackage.name, "package.json");
    const text = await readFile(pkgPath, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (text) {
      await writeFile(pkgPath, JSON.stringify({ ...JSON.parse(text), version: "99.0.0" }));
      updatedPackages++;
    }
  }
  assert.ok(updatedPackages > 0, "The fixture must replace the actual npx package before checking the saved CLI");
  const pasted = await exec("/bin/sh", ["-c", savedVersionCommand], { cwd: root, env: { ...env, PATH: agentBin }, timeout: 10000 });
  assert.equal(pasted.stdout.trim(), sourcePackage.version);
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", workspace, tarball], { cwd: root, env });
  const installed = path.join(workspace, "node_modules", source.manifest.package);
  const load = name => import(pathToFileURL(path.join(installed, "src", name)).href);
  const { prepareDeployment } = await load("distribution.mjs");
  const { claimRuntime } = await load("runtime.mjs");
  const { VERSION, PACKAGE_NAME } = await load("version.mjs");
  const { RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES } = await load("compatibility.mjs");
  const cliPath = path.join(installed, "bin/codexteer.mjs");
  fixture.cliPath = cliPath;
  async function cli(args, ok = true) {
    let result;
    try { result = await exec(process.execPath, [fixture.cliPath, ...args, "--json"], { cwd: root, env, timeout: 10000 }); }
    catch (error) { if (ok) throw error; result = error; }
    const parsed = JSON.parse(result.stdout); assert.equal(parsed.ok, ok); return parsed;
  }
  assert.equal((await cli(["--version"])).data.version, VERSION);
  await cli(["help"]);
  assert.equal((await cli(["desktop", "start", "--dry-run"])).data.started, false);
  assert.equal((await cli(["send", ID, "synthetic message", "--dry-run"])).data.sent, false);
  const localPrompt = (await cli(["supervise", "prompt", ID])).data;
  assert.equal(localPrompt.thread_id, ID);
  assert.equal(withoutSession(localPrompt.prompt), withoutSession(copiedPrompt), "Identical local and npx distributions must render the same saved invocation");
  assert.equal(localPrompt.deployment.sha256, source.sha256);
  assert.equal(localPrompt.prompt.includes(`${cache}/_npx/`), false);
  const localCustomPrompt = (await cli(["supervise", "prompt", ID, policy])).data;
  assert.equal(withoutSession(localCustomPrompt.prompt), withoutSession(customPrompt.prompt), "Custom policies must also agree across local and npx installations");
  assert.equal(localCustomPrompt.deployment.directory, localPrompt.deployment.directory);
  const deployment = await prepareDeployment(home);
  assert.equal((await lstat(deployment.wrapper_path)).mode & 0o777, 0o700);
  assert.equal(deployment.sha256, source.sha256, "packing changed executable distribution contents");

    return Object.assign(fixture, { root, cache, workspace, home, env, ID, TURN, source, sourcePackage, artifact,
      agentBin, copiedPrompt, customPrompt, policy, savedVersionCommand, deployment, cli, claimRuntime,
      VERSION, PACKAGE_NAME, RUNTIME_PROTOCOL, RUNTIME_CAPABILITIES });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
