import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const scriptName of ["accessibility.applescript", "send.applescript", "inspect.applescript"]) {
  test(`${scriptName} compiles`, { skip: process.platform !== "darwin" }, async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codex-steer-script-"));
    const source = fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url));
    const result = spawnSync("/usr/bin/osacompile", ["-o", path.join(output, "script.scpt"), source], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("send submits a deep-link-prefilled composer without global paste", () => {
  const source = fileURLToPath(new URL("../scripts/send.applescript", import.meta.url));
  const script = readFileSync(source, "utf8");
  assert.match(script, /key code 36/u);
  assert.match(script, /previousProcessId/u);
  assert.match(script, /restoreFocus/u);
  assert.doesNotMatch(script, /keystroke "v"|clipboard/u);
  assert.doesNotMatch(script, /AXTextArea|AXTextField/u);
});
