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

const activeStatus = new Set(["active", "inProgress", "in_progress", "pending", "queued", "running"]), terminalStatus = new Set(["completed", "failed", "cancelled"]);

// What the thread status alone says about execution.
export const statusExecution = status => activeStatus.has(status) ? "active" : ["idle", "notLoaded"].includes(status) ? "idle" : terminalStatus.has(status) ? "terminal" : "unknown";

// A Desktop Cloud thread can stay active long after its last turn ended, and
// only a turn's own status says whether it runs. So there the turns decide
// when they disagree with the thread status. Unproven turns leave the status
// in charge. Other connections report execution by their status.
export function turnExecution(observation, connection) {
  const coarse = statusExecution(observation?.status ?? "unknown"), turns = connection === "desktop-cloud" ? turnEvidence(observation) : "unknown";
  return turns === "running" ? "active" : turns === "none" && coarse === "active" ? "idle" : coarse;
}

// Any sign of a running turn, even one the rest of the evidence contradicts.
export const turnRuns = observation => observation?.active_turn_count > 0 || running.has(observation?.latest_turn_status);

export const RUNNING_TURN_UNOBSERVED = "running_turn_unobserved";

// A Desktop Cloud turn shows only its opening message until it ends: questions,
// approval requests and progress made during it are not readable. The mark is
// set unless the turns prove that none is running, or the one running turn,
// the newest, was read live.
export function attentionCoverage(observation, connection) {
  const live = turnEvidence(observation) === "running" && observation.active_turn_count === 1
    && typeof observation.live_turn_id === "string" && observation.live_turn_id === observation.latest_turn_id;
  return connection === "desktop-cloud" && observation && turnEvidence(observation) !== "none" && !live ? RUNNING_TURN_UNOBSERVED : undefined;
}

export function withAttentionCoverage(observation, connection) {
  const coverage = attentionCoverage(observation, connection);
  return coverage ? { ...observation, attention_coverage: coverage } : observation;
}

// What a Desktop Cloud read, status or watch adds to the thread status: the
// execution its project row shows, and its basis when the turns overrode the
// status. The status itself is returned as the service gave it.
export function observedExecution(observation, connection) {
  if (connection !== "desktop-cloud" || !observation) return {};
  const execution = turnExecution(observation, connection);
  return { execution, ...(execution === statusExecution(observation.status ?? "unknown") ? {} : { execution_basis: "turn_status" }) };
}

// The members of a sync result whose rows carry the mark, for the top level of
// a sync page and of a wait return.
export const unobservedAttention = works => works.flatMap(work => unobservedMember(work.thread_id, work.attention_coverage, work));

// One member of that list. `source` is the row or the read that may say why
// the running turn was not read live.
export const unobservedMember = (thread_id, attention_coverage, source) => attention_coverage
  ? [{ thread_id, attention_coverage, ...(source?.live_fallback ? { live_fallback: source.live_fallback } : {}) }] : [];
