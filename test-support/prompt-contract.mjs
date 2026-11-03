import assert from "node:assert/strict";

// Shared by portable content tests and the packaged CLI integration fixture.
export function assertOrchestrationContent(prompt) {
  for (const operation of ["work start", "project sync", "work tell", "project control"]) assert.ok(prompt.includes(operation), operation);
  assert.match(prompt, /毎回、発注書に次の文を含めます。\n「依頼の前提や設計.*異論.*改善案.*根拠/);
  assert.match(prompt, /担当の反証は根拠で採否を決め、妥当なら計画と発注書を更新/);
  assert.match(prompt, /CODEXTEER\.md/);
  assert.match(prompt, /モデル名や製品名から能力・権限・役割を推測しません/);
  assert.doesNotMatch(prompt, /--agent|supervise prompt|--connection cloud(?:\s|$)|Codex担当には|Claude|GPT|Gemini/);
}
