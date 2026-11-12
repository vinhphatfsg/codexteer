import { readOnClient, readSnapshot, observationAttention } from "./observe.mjs";
import { createHash } from "node:crypto";
import { getManagedThread, listManagedThreads, managedMembershipDigest } from "./project-index.mjs";
import { getSupervisor } from "./supervision.mjs";
import { createFinding } from "./findings.mjs";
import { sendWorkTellMessage, reconcileMessages } from "./journal.mjs";
import { readRecord, withStoreLock } from "./store.mjs";
import { readHistoryRecord, listHistoryRecords } from "./project-history.mjs";
import { validateSyncPage } from "./sync-page.mjs";
import { readRepositoryPolicy } from "./work-start.mjs";
import { attentionCoverage } from "./attention-coverage.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const fail = (message, code, details = {}) => Object.assign(new Error(message), { code, ...details });
const projectKey = projectId => sha(projectId).slice(0, 40);
const syncTokenPattern = /^[0-9a-f-]{36}$/i;
const turnIdentity = observation => observation?.latest_turn_id ?? observation?.current_turn_id ?? observation?.turn_id ?? observation?.active_turn_id ?? null;

async function policyStatus(threadId, member, storage, readPolicy) {
  const starts = (await listHistoryRecords("work-starts", member.project_id, storage)).filter(record => record?.thread_id === threadId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const start = starts[0];
  if (!start?.root || !member.policy_sha256) return { checked: false, changed: null, expected_sha256: member.policy_sha256 ?? null, current_sha256: null };
  const policy = await readPolicy(start.root);
  return { checked: true, changed: policy.sha256 !== member.policy_sha256, expected_sha256: member.policy_sha256, current_sha256: policy.sha256, present: policy.present, source: policy.file };
}

// The basis is decided for the target alone: another member that is unread, changed or newly
// registered must not block an instruction to a member whose own reviewed row is still current.
async function syncBasis(threadId, member, token, storage) {
  const head = await readRecord("project-sync-heads", projectKey(member.project_id), storage);
  if (!head) throw fail("A project sync is required before work tell.", "WORK_TELL_SYNC_INCOMPLETE", { sync_token: null });
  if (head.conflict_tokens?.length && !token) throw fail("Concurrent project syncs produced competing bases. Review the latest result and pass its token explicitly.", "WORK_TELL_SYNC_TOKEN_REQUIRED", { sync_tokens: head.conflict_tokens, current_sync_token: head.sync_token });
  const syncToken = token ?? head.sync_token, named = syncToken !== head.sync_token;
  const result = syncTokenPattern.test(syncToken) ? await readHistoryRecord("project-sync-results", syncToken, member.project_id, storage) : null;
  if (named && result?.project_id !== member.project_id) throw fail("The requested sync is not a readable result of this project. Use the current token after reviewing it.", "WORK_TELL_SYNC_CONFLICT", { current_sync_token: head.sync_token });
  const work = result?.works?.find(row => row.thread_id === threadId);
  if (!work || work.complete !== true || work.history_gap || !work.cursor) throw fail("The target is absent, incomplete, or has a history gap in the sync basis.", "WORK_TELL_SYNC_INCOMPLETE", { sync_token: syncToken });
  // Every complete read of a member bumps its revision, so equality proves the reviewed row is still its latest one.
  const current = await getManagedThread(threadId, storage);
  if (current?.sync_cursor !== work.cursor || (current?.sync_revision ?? 0) !== (work.sync_revision ?? 0)) throw fail("The target was read again after the reviewed basis. Review the latest sync before sending.", "WORK_TELL_SYNC_CONFLICT", { current_sync_token: head.sync_token });
  // A later incomplete read can add a question without bumping the revision, so attention comes from the head.
  if (head.unresolved_attention?.[threadId]?.attention === "human") throw fail("Unresolved questions or approvals remain in the sync basis.", "WORK_TELL_HUMAN_REQUIRED");
  return { head, result, work, sync_token: syncToken };
}

async function otherWork(threadId, member, head, storage) {
  // Settled members are no longer read and nobody answers one, so they are
  // neither unread nor waiting: their rows keep the attention in project sync.
  const members = await listManagedThreads(member.project_id, storage), complete = new Set([...head.complete_work_ids ?? [], ...Object.keys(head.settled ?? {})]);
  return { incomplete: members.filter(m => m.thread_id !== threadId && !complete.has(m.thread_id)).map(m => m.thread_id),
    human_attention: Object.entries(head.unresolved_attention ?? {}).filter(([id, entry]) => id !== threadId && entry?.attention === "human" && !head.settled?.[id]).map(([id]) => id).sort(),
    membership_changed: managedMembershipDigest(members) !== head.membership_digest };
}

function assertNoHumanAttention(observation) {
  const questions = (observation.events ?? []).some(event => Array.isArray(event.questions) && event.questions.length > 0);
  if (!Array.isArray(observation.attention)) throw fail("The backend cannot prove that no question or approval is pending.", "WORK_TELL_ATTENTION_UNKNOWN");
  if (observation.attention.length || questions) throw fail("The task is waiting for a human question or approval. work tell cannot answer it.", "WORK_TELL_HUMAN_REQUIRED", { attention: observation.attention, events: observation.events ?? [] });
}

// `liveTurn` scopes one live view of a running Desktop Cloud turn: the pages of
// one check share it, and each check of a tell takes its own.
async function freshObservation(threadId, member, basis, read, liveTurn) {
  let cursor = basis.work.cursor, latest, pages = 0; const seen = new Set([cursor]), events = [];
  do {
    latest = validateSyncPage(await read(threadId, { connection: member.connection, since: cursor, limit: 1000, liveTurn }), threadId, cursor, seen);
    if (member.environment_config_id && latest.environment_config_id !== member.environment_config_id) throw fail("The task environment differs from its managed route.", "WORK_TELL_ROUTE_MISMATCH");
    assertNoHumanAttention(latest);
    if (!latest?.cursor || ++pages > 1000 || (latest.has_more && seen.has(latest.cursor))) throw fail("Freshness read did not advance its cursor.", "WORK_TELL_FRESHNESS_INCOMPLETE");
    seen.add(latest.cursor); cursor = latest.cursor; events.push(...(latest.events ?? []));
  } while (latest.has_more);
  assertNoHumanAttention(latest);
  const changedTurn = turnIdentity(latest) !== basis.work.turn_identity;
  if (events.length || changedTurn) throw fail("The task changed after project sync. Review the returned delta and sync again; nothing was sent.", "WORK_TELL_STALE_SYNC", { events, turn_identity: turnIdentity(latest), sync_turn_identity: basis.work.turn_identity });
  return { cursor, latest };
}

export async function tellWork(threadInput, body, options = {}, dependencies = {}) {
  if (typeof body !== "string" || !body.trim()) throw fail("work tell requires a non-empty instruction.", "WORK_TELL_INVALID");
  const storage = dependencies.storage ?? {}, member = await getManagedThread(threadInput, storage);
  if (!member) throw fail("work tell requires a managed task.", "WORK_TELL_UNMANAGED");
  const read = dependencies.read;
  if (typeof read !== "function") throw fail("work tell reader is unavailable.", "WORK_TELL_INVALID");
  return withStoreLock(`work-tell-${sha(member.thread_id).slice(0, 40)}`, async () => {
    const basis = await syncBasis(member.thread_id, member, options.syncToken, storage);
    if (options.newTurn && !["idle", "terminal"].includes(basis.work.execution)) throw fail("A new turn requires an idle or terminal task and the same unfinished delegation.", "WORK_TELL_NEW_TURN_INVALID");
    const fresh = await freshObservation(member.thread_id, member, basis, read, new Map());
    const policy = await policyStatus(member.thread_id, member, storage, dependencies.readPolicy ?? readRepositoryPolicy);
    const other = await otherWork(member.thread_id, member, basis.head, storage);
    const supervisor = await getSupervisor(member.thread_id, storage);
    if (!supervisor) throw fail("The managed task has no supervisor binding.", "MANAGED_SUPERVISOR_REQUIRED");
    const key = `work-tell-${sha(JSON.stringify([member.thread_id, body.trim(), !!options.newTurn])).slice(0, 40)}`;
    const finding = await (dependencies.createFinding ?? createFinding)(member.thread_id, { key, title: `work tell: ${body.trim().slice(0, 120)}`,
      condition: `Deliver the reviewed instruction with sha256 ${sha(body)} exactly once and track its response.`, basedOn: fresh.cursor, ...storage });
    // The last read before the send decides what the receipt says was observed.
    let sentOn = fresh.latest;
    const guardBeforeSend = async (thread, client) => {
      if (thread) assertNoHumanAttention({ attention: observationAttention(thread.status), events: [] });
      ({ latest: sentOn } = await freshObservation(member.thread_id, member, { work: { ...basis.work, cursor: fresh.cursor } },
        (id, options) => client ? readOnClient(client, id, options) : Promise.resolve(readSnapshot(thread, options)), new Map()));
      await syncBasis(member.thread_id, member, basis.sync_token, storage);
    };
    try {
      const receipt = await (dependencies.sendTracked ?? sendWorkTellMessage)(member.thread_id, body, { supervisor: supervisor.session_id, connection: member.connection,
        basedOn: fresh.cursor, finding: finding.id, source: "codexteer", kind: "review", newTurn: !!options.newTurn, guardBeforeSend }, { ...storage, ...(dependencies.send ? { send: dependencies.send } : {}) });
      // The gate saw no question or approval, which a running Desktop Cloud turn
      // not read live would not have shown. The receipt says so; whether to send is unchanged.
      const coverage = attentionCoverage(sentOn, member.connection);
      return { ...receipt, thread_id: member.thread_id, sync_token: basis.sync_token, finding_id: finding.id, source: "codexteer", kind: "review", policy, other_work: other,
        ...(coverage ? { attention_coverage: coverage } : {}) };
    } catch (error) {
      if (error.delivery_status === "unknown" && error.message_id) {
        try { error.reconciliation = await (dependencies.reconcile ?? ((id) => reconcileMessages(member.thread_id, id, {}, dependencies.connectionDependencies ?? {})))(error.message_id); }
        catch (reconcileError) { error.reconciliation = { status: "unavailable", error_code: reconcileError.code ?? "RECONCILE_FAILED" }; }
      }
      error.policy = policy; error.sync_token = basis.sync_token; error.finding_id = finding.id; throw error;
    }
  }, storage);
}
