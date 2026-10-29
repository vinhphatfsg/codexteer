import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const rules = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  githubCredential: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  apiCredential: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g,
  cloudCredential: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  literalJwt: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g,
  credentialUrl: /https?:\/\/[^\s/:]+:[^\s/@]+@/g,
  workstationName: /\bDESKTOP-[A-Z0-9]{6,}\b/g,
  accountHostId: /\benv_[A-Za-z0-9_-]{20,}\b/g,
  privateProjectId: /\bg-p-[a-f0-9]{32}\b/g,
};

test("tracked publication files contain no credential signatures or environment-specific identifiers", async () => {
  // Use the current checkout, including staged additions, without inspecting
  // live profiles. Never print a matched value in a failing test or CI log.
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  const failures = [];
  for (const file of files) {
    let bytes;
    try { bytes = await readFile(new URL(file, new URL("../", import.meta.url))); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const [name, pattern] of Object.entries(rules)) {
      if ([...text.matchAll(pattern)].length) failures.push({ file, rule: name });
    }
    for (const match of text.matchAll(/\/Users\/([^/\s"'`]+)/g)) {
      if (!["me", "example", "user"].includes(match[1])) failures.push({ file, rule: "personalHomePath" });
    }
    for (const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
      if (!/^(?:aaaaaaaa-aaaa-4aaa-8aaa-|11111111-1111-4111-8111-|22222222-2222-4222-8222-|33333333-3333-4333-8333-)/i.test(match[0])) {
        failures.push({ file, rule: "nonSyntheticUuid" });
      }
    }
  }
  assert.deepEqual(failures, [], "Publication review required (matched values are deliberately omitted)");
});

test("public package excludes investigation records and local credentials or reports", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert(pkg.files.every(file => !/investigation|\.codex-reports|auth\.json|\.env|\.npmrc/.test(file)));
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const entry of [".codex-reports/", "auth.json", ".codex-global-state.json", ".env", ".npmrc"]) assert(ignore.split("\n").includes(entry));
});
