// The project-sync-heads record that codexteer 0.24.1 publishes for two idle
// works after the first was stopped and settled: every field and its shape as
// written, with a synthetic token. The settled row keeps the group 0.24.1 gave
// it. The caller supplies the membership digest, because it covers
// registration times.
const first = "11111111-1111-4111-8111-000000000001", second = "11111111-1111-4111-8111-000000000002";
const syncToken = "33333333-3333-4333-8333-000000000011";

export const settledHead = membershipDigest => ({
  schema: 1, project_id: "legacy", sync_token: syncToken, membership_digest: membershipDigest,
  complete: true, complete_work_ids: [second, first],
  unresolved_attention: {}, historical_attention: {}, created_at: "2026-11-10T08:42:16.290Z",
  settled: { [first]: { basis: "observed", settled_at: "2026-11-10T08:42:16.284Z", row: {
    title: "work 1", execution: "idle", attention: "review", group: "検収待ち",
    reason: { backend_status: "idle", attention_flags: [], question_event: false, failure_event: false,
      review_basis: "idle_after_completed_turn", latest_turn_id: "turn-1", latest_turn_status: "completed", active_turn_count: 0 },
    cursor: "c1", sync_revision: 2, turn_identity: "turn-1", history_notes: [], complete: true, history_gap: false } } },
  wait_baseline: { sync_token: syncToken, membership_digest: membershipDigest, works: {
    [second]: { cursor: "c1", signal: { turn_id: "turn-2", turn_status: "completed", status: "idle", attention: [] }, sync_token: syncToken },
  } },
  wait_sync_token: null,
});
