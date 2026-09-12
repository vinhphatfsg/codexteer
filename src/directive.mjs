import { collectEvidence, verifyEvidence } from "./evidence.mjs";
import { decodeCursor, threadSnapshot, fetchThread } from "./observe.mjs";
import { getCheckpoint, verifyCheckpoint } from "./checkpoint.mjs";
import { verifyPagedFreshness } from "./paged-read.mjs";

export const kindLabels = { decision: "ユーザー決定の伝達", review: "レビュー", hypothesis: "仮説（未確定）", suggestion: "任意提案" };

export async function prepareDirective(threadId, body, options, id, storage = {}) {
  const { source, kind, evidence = [], basedOn, supersedes, retracts, expiresAt, checkpoint } = options;
  if (!source && !kind && !evidence.length && !basedOn && !supersedes && !retracts && !expiresAt && !checkpoint) return { wireText: body, metadata: null };
  if (checkpoint) await getCheckpoint(threadId, checkpoint, storage);
  if (supersedes && retracts) throw new Error("Use either supersedes or retracts, not both.");
  if (expiresAt && (!/(Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error("--expires-at must be a future ISO timestamp with timezone.");
  if (kind && !Object.hasOwn(kindLabels, kind)) throw new Error("--kind must be decision, review, hypothesis, or suggestion.");
  if (source != null && (!source.trim() || source.length > 80 || /[\r\n\x00-\x1f]/.test(source))) throw new Error("--source must be a non-empty single line (up to 80 characters).");
  const observed = basedOn ? decodeCursor(basedOn, threadId) : null;
  const refs = await collectEvidence(evidence);
  const metadata = { source: source ?? "external", kind: kind ?? "review", evidence: refs, based_on: basedOn ?? null, supersedes: supersedes ?? null, retracts: retracts ?? null, expires_at: expiresAt ?? null, checkpoint_id: checkpoint ?? null };
  const lines = [`[codexteer ${id}]`, `送信者: ${metadata.source}`, `種類: ${kindLabels[metadata.kind]}`];
  for (const ref of refs) lines.push(`根拠: ${JSON.stringify(ref.ref)}${ref.sha256 ? ` (sha256:${ref.sha256})` : " (参照URL)"}`);
  if (observed) lines.push(`観測対象ターン: ${observed.active_turn_id ?? "停止中"}`);
  if (supersedes) lines.push(`置き換える指示: ${supersedes}。この指示を以後の方針として扱ってください。`);
  if (retracts) lines.push(`撤回する指示: ${retracts}。以後の方針から除外してください。`);
  if (expiresAt) lines.push(`有効期限: ${expiresAt}`);
  if (checkpoint) lines.push(`検証チェックポイント: ${checkpoint}`);
  return { metadata, wireText: lines.join("\n") + "\n\n" + body, async beforeSend(thread, client) {
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw Object.assign(new Error("Directive expired before sending."), { code: "EXPIRED_DIRECTIVE" });
    if (observed) {
      if (observed.v === 2) await verifyPagedFreshness(client, threadId, basedOn);
      else {
        if (thread.turns?.some(t => t.itemsView && t.itemsView !== "full") || !thread.turns?.length) thread = await fetchThread(client, threadId);
        const current = threadSnapshot(thread);
        if (current.user_revision !== observed.user_revision || current.state.active_turn_id !== observed.active_turn_id) throw Object.assign(new Error("New user input or a different turn was observed. Read the task again before sending."), { code: "STALE_OBSERVATION" });
      }
    }
    await verifyEvidence(refs);
    if (checkpoint && !(await verifyCheckpoint(threadId, checkpoint, storage)).valid) throw Object.assign(new Error("Checkpoint is no longer valid. Verify the inputs and results before sending."), { code: "STALE_CHECKPOINT" });
  } };
}
