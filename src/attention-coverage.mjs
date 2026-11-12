const running = new Set(["inProgress", "in_progress", "running", "pending", "queued"]);
const ended = new Set(["completed", "failed", "interrupted", "cancelled"]);

// Whether a turn runs is decided by the turns themselves, never by the coarse
// thread status. "none" means no turn runs; a missing count, an unknown status
// or a count that disagrees with the latest turn is "unknown".
export function turnEvidence(observation) {
  const count = observation?.active_turn_count, latest = observation?.latest_turn_status ?? null;
  if (!Number.isSafeInteger(count) || count < 0) return "unknown";
  if (count > 0) return running.has(latest) ? "running" : "unknown";
  return ended.has(latest) || (latest === null && (observation.latest_turn_id ?? null) === null) ? "none" : "unknown";
}

// Any sign of a running turn, even one the rest of the evidence contradicts.
export const turnRuns = observation => observation?.active_turn_count > 0 || running.has(observation?.latest_turn_status);

export const RUNNING_TURN_UNOBSERVED = "running_turn_unobserved";

// A Desktop Cloud turn shows only its opening message until it ends: questions,
// approval requests and progress made during it are not readable. The mark is
// set unless the turns prove that none is running.
export function attentionCoverage(observation, connection) {
  return connection === "desktop-cloud" && observation && turnEvidence(observation) !== "none" ? RUNNING_TURN_UNOBSERVED : undefined;
}

export function withAttentionCoverage(observation, connection) {
  const coverage = attentionCoverage(observation, connection);
  return coverage ? { ...observation, attention_coverage: coverage } : observation;
}

// The members of a sync result whose rows carry the mark, for the top level of
// a sync page and of a wait return.
export const unobservedAttention = works => works.filter(work => work.attention_coverage)
  .map(work => ({ thread_id: work.thread_id, attention_coverage: work.attention_coverage }));
