// The project-sync-heads record that codexteer 0.23.0 publishes for two idle
// works, the second with an unanswered question: every field and its shape as
// written, with synthetic tokens. The caller supplies the membership digest,
// because it covers registration times.
const first = "11111111-1111-4111-8111-000000000001", second = "11111111-1111-4111-8111-000000000002";
const syncToken = "33333333-3333-4333-8333-000000000001", eventToken = "33333333-3333-4333-8333-000000000002";
const question = { token: eventToken, thread_id: second, event_id: "q", type: "agentMessage", status: null,
  text: "Which?", full_bytes: 71, full_command: `codexteer project event ${eventToken} --json` };

export const legacyHead = membershipDigest => ({
  schema: 1, project_id: "legacy", sync_token: syncToken, membership_digest: membershipDigest,
  complete: true, complete_work_ids: [second, first],
  unresolved_attention: { [second]: { attention: "human", reason: { evidence: [{ question_event: true, failure_event: false }] }, events: [question],
    entries: [["q", { attention: "human", reason: { question_event: true, failure_event: false }, events: [question] }]] } },
  historical_attention: {}, created_at: "2026-11-10T08:42:16.290Z", wait_sync_token: null,
  wait_baseline: { sync_token: syncToken, membership_digest: membershipDigest, works: {
    [first]: { cursor: "c1", signal: { turn_id: "turn-1", turn_status: "completed", status: "idle", attention: [] } },
    [second]: { cursor: "c1", signal: { turn_id: "turn-2", turn_status: "completed", status: "idle", attention: [] } },
  } },
});
