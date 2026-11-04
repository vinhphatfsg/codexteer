import assert from "node:assert/strict";
import { orchestrationPrompt } from "../src/orchestrate-prompt.mjs";
import { assertOrchestrationContent } from "../test-support/prompt-contract.mjs";
import test from "node:test";
import { rm } from "node:fs/promises";
import { preparePackageContent } from "../test-support/package-content.mjs";

test("offline tarball, npx/installed prompt and help contracts execute on every OS without Desktop runtime", { timeout: 180000 }, async t => {
  const fixture = await preparePackageContent();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  t.diagnostic(`portable packaged content verified: ${fixture.artifact.files.length} files; shared Desktop runtime not used`);
});

test("shared packaged-prompt contract rejects missing dissent, improvements or evidence-based review", () => {
  const { prompt } = orchestrationPrompt("P", "goal", "codexteer --connection shared", { cloudCommand: "codexteer --connection desktop-cloud" });
  assert.doesNotThrow(() => assertOrchestrationContent(prompt));
  for (const missing of ["異論", "改善案", "担当の反証は根拠で採否を決め、妥当なら計画と発注書を更新"])
    assert.throws(() => assertOrchestrationContent(prompt.replace(missing, "")), missing);
});
