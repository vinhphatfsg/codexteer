import { parseCursor } from "./cursor.mjs";
import { withHistoryReservation, assertHistoryBatch } from "./project-history.mjs";
import { validateSyncPage } from "./sync-page.mjs";
export { validateSyncPage } from "./sync-page.mjs";
import { createHash, randomUUID } from "node:crypto";
import { listManagedThreads, updateManagedThreadCursor, managedMembershipDigest } from "./project-index.mjs";
import { getSupervisor } from "./supervision.mjs";
import { normalizeTaskId } from "./task-id.mjs";
import { readRecord, writeRecord, listRecords, withStoreLock } from "./store.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const failure = (message, code = "PROJECT_SYNC_INVALID") => Object.assign(new Error(message), { code });
const gapCodes = new Set(["STALE_CURSOR", "INVALID_CURSOR", "CURSOR_UPGRADE_REQUIRED", "OBSERVATION_CHANGED", "WORK_INITIAL_HISTORY_GAP"]);
const terminal = new Set(["completed", "failed", "cancelled"]), active = new Set(["active", "inProgress", "in_progress", "pending", "queued", "running"]);

// A command/tool outcome is scoped to that item, not to the delegated work.
const failedTurn = event => event.type === "turn" && event.status === "failed";
const failedWork = observation => ["failed", "systemError"].includes(observation?.status) || observation?.latest_turn_status === "failed" || (observation?.events ?? []).some(failedTurn);
const provenWorkFailure = entry => ["failed", "systemError"].includes(entry?.reason?.backend_status) || entry?.reason?.latest_turn_status === "failed"
  || (entry?.events ?? []).some(failedTurn);
const commandOnlyFailure = entry => entry?.attention === "failure" && entry.reason?.failure_event === true
  && !entry.reason.question_event && !entry.reason.backend_status && Array.isArray(entry.events) && entry.events.length > 0
  && entry.events.every(event => event.type === "commandExecution");

export function projectWaitSignal(page) {
  return { turn_id: page?.latest_turn_id ?? page?.current_turn_id ?? page?.turn_id ?? page?.active_turn_id ?? null,
    turn_status: page?.latest_turn_status ?? null, status: page?.status ?? null,
    attention: Array.isArray(page?.attention) ? [...page.attention].sort() : null };
}

function classify(observation, complete, connection) {
  const status = observation?.status ?? "unknown", flags = observation?.attention;
  const events = observation?.events ?? [], questions = events.some(event => Array.isArray(event.questions) && event.questions.length);
  const failed = failedWork(observation);
  const human = questions || (Array.isArray(flags) && flags.length > 0);
  const execution = active.has(status) ? "active" : ["idle", "notLoaded"].includes(status) ? "idle" : terminal.has(status) ? "terminal" : "unknown";
  const idleCompleted = status === "idle" && observation.latest_turn_status === "completed"
    && typeof observation.latest_turn_id === "string" && !!observation.latest_turn_id && observation.active_turn_count === 0;
  const attentionKnown = Array.isArray(flags);
  const attention = human ? "human" : failed ? "failure" : !complete || connection === "cloud" || !attentionKnown ? "unknown"
    : idleCompleted || execution === "terminal" ? "review" : execution === "idle" || execution === "unknown" ? "unknown" : "none";
  const observationState = complete ? "current" : "incomplete";
  const group = observationState !== "current" ? "未確認" : ["human", "failure"].includes(attention) ? "対応が必要" : attention === "review" ? "検収待ち" : execution === "unknown" || attention === "unknown" ? "未確認" : "動作中";
  return { execution, attention, observation: observationState, group, reason: { backend_status: status, attention_flags: flags ?? null, question_event: questions, failure_event: failed,
    ...(attention === "review" && idleCompleted ? { review_basis: "idle_after_completed_turn", latest_turn_id: observation.latest_turn_id,
      latest_turn_status: observation.latest_turn_status, active_turn_count: observation.active_turn_count } : {}) } };
}

function summarizeEvent(event, threadId, store) {
  const token = randomUUID(), text = event.text ?? event.output ?? null;
  const summary = { token, thread_id: threadId, event_id: event.id ?? null, type: event.type ?? "unknown", status: event.status ?? null,
    text: typeof text === "string" ? [...text].slice(0, 500).join("") + ([...text].length > 500 ? "…" : "") : null,
    full_bytes: bytes(event), full_command: `codexteer project event ${token} --json` };
  store.push({ token, thread_id: threadId, event }); return summary;
}

export async function projectEvent(token, storage = {}) {
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) throw failure("A project event token is required.");
  const record = await readRecord("project-sync-events", token, storage);
  if (!record) throw failure("Project sync event was not found or was removed by project prune.", "PROJECT_EVENT_NOT_FOUND");
  return record;
}

function validateBudget(value) {
  if (!Number.isInteger(value) || value < 4096 || value > 1024 * 1024) throw failure("Invalid sync byte budget.");
  return value;
}


function outputSize(result) {
  for (let old = -1; old !== result.output_bytes;) { old = result.output_bytes; result.output_bytes = bytes(result); }
  return result;
}

function compactWork(work) {
  return { thread_id: work.thread_id, group: work.group, execution: work.execution, attention: work.attention,
    observation: work.observation, complete: work.complete, history_gap: work.history_gap, retry_after_ms: work.retry_after_ms,
    error: work.error, attention_repeated: work.attention_repeated, resolution_unconfirmed: work.resolution_unconfirmed,
    detail_token: work.detail_token, details_omitted: true,
    // The operator's reason is unbounded; a compact row must always fit.
    ...(work.settled ? { settled: { basis: work.settled.basis, settled_at: work.settled.settled_at } } : {}) };
}

// Split inside a work as well as between works. Tokens always refer to the full
// durable record; compact envelopes never silently truncate that record.
function pageResult(saved, token, byteBudget, offset = 0, eventOffset = 0) {
  if (!Number.isInteger(offset) || offset < 0 || offset > saved.works.length || !Number.isInteger(eventOffset) || eventOffset < 0
    || (offset === saved.works.length ? eventOffset !== 0 : eventOffset > saved.works[offset].events.length)) throw failure("Invalid continuation offset.");
  const result = { project_id: saved.project_id, sync_token: token, wait_sync_token: saved.wait_sync_token ?? null, membership_digest: saved.membership_digest,
    membership_count: saved.works.length, complete: saved.complete, works: [], omitted_works: 0, omitted_events: 0,
    continuation_token: null, continuation_offset: offset, continuation_event_offset: eventOffset,
    created_at: saved.created_at, output_bytes: 0, byte_budget: byteBudget };
  let wi = offset, ei = eventOffset;
  const finish = () => {
    result.omitted_works = saved.works.length - wi;
    result.omitted_events = saved.works.slice(wi).reduce((n, w, i) => n + w.events.length - (i === 0 ? ei : 0), 0);
    result.continuation_token = wi < saved.works.length ? token : null;
    result.next_offset = wi; result.next_event_offset = ei;
    return outputSize(result);
  };
  if (bytes(finish()) > byteBudget) throw failure("The fixed sync envelope exceeds the byte budget.", "PROJECT_SYNC_BUDGET_TOO_SMALL");
  while (wi < saved.works.length) {
    const work = saved.works[wi], start = ei;
    let row = { ...work, events: [], event_offset: start, events_complete: false };
    result.works.push(row);
    if (bytes(finish()) > byteBudget) {
      // A carried settled row has no detail record to recover omitted fields
      // from, so it opens the next page in full instead of closing this one.
      if (work.observation === "settled" && result.works.length > 1) { result.works.pop(); break; }
      row = { ...compactWork(work), events: [], event_offset: start, events_complete: false }; result.works[result.works.length - 1] = row;
    }
    let rejected = false;
    while (ei < work.events.length) {
      const event = work.events[ei]; row.events.push(event);
      if (bytes(finish()) > byteBudget) {
        row.events[row.events.length - 1] = { token: event.token, thread_id: work.thread_id, details_omitted: true };
        if (bytes(finish()) > byteBudget) { row.events.pop(); rejected = true; break; }
      }
      ei++;
    }
    if (ei === work.events.length) { row.events_complete = true; wi++; ei = 0; }
    if (bytes(finish()) > byteBudget || (rejected && ei === start)) {
      result.works.pop(); wi = offset + result.works.filter(w => w.events_complete).length; ei = start;
      if (!result.works.length) throw failure("A minimal work envelope exceeds the byte budget.", "PROJECT_SYNC_BUDGET_TOO_SMALL");
      break;
    }
    if (rejected) break;
  }
  return finish();
}

export async function continueProjectSync(token, options = {}, storage = {}) {
  const byteBudget = validateBudget(options.byteBudget ?? 16000);
  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) throw failure("Invalid sync token.");
  const saved = await readRecord("project-sync-results", token, storage);
  if (!saved) throw failure("Project sync continuation was not found or was removed by project prune.", "PROJECT_SYNC_CONTINUATION_NOT_FOUND");
  return pageResult(saved, token, byteBudget, options.offset ?? 0, options.eventOffset ?? 0);
}

// Attention is a reducer over the entire delta, not a property of its last page.
// Current backend flags and durable question/failure evidence resolve separately.
function reduceAttention(state, prior, summaries) {
  // Reclassify only persisted evidence that proves the old command-level false
  // positive. Opaque legacy evidence, real turn failures and questions survive.
  const priorEntries = (prior?.entries ?? (prior ? [["legacy", prior]] : [])).filter(([, entry]) => !commandOnlyFailure(entry)).map(([id, entry]) => [id, entry.attention === "failure" && !provenWorkFailure(entry)
    ? { ...entry, attention: "unknown", reason: { unverified_prior_failure: entry.reason ?? null } } : entry]);
  const entries = new Map(priorEntries);
  const summaryById = new Map(state.events.map((event, i) => [event.id, summaries[i]]));
  for (const page of state.observations) {
    if (["failed", "systemError"].includes(page.status)) entries.set("backend:failure", { attention: "failure", reason: { backend_status: page.status }, events: [] });
    for (const flag of page.attention ?? []) entries.set(`flag:${flag}`, { attention: "human", reason: { attention_flags: [flag] }, events: [] });
    for (const event of page.events) {
      if (["answered", "resolved"].includes(event.status)) { if (state.complete) entries.delete(event.id); continue; }
      if (state.complete && event.type === "userMessage" && event.change !== "updated") {
        for (const [id, entry] of entries) if (entry.reason?.question_event) entries.delete(id);
      }
      if (state.complete && event.type === "turn" && ["completed", "cancelled", "interrupted"].includes(event.status)) entries.delete(event.id);
      const question = Array.isArray(event.questions) && event.questions.length;
      const failed = failedTurn(event);
      if (question || failed) entries.set(event.id, { attention: question ? "human" : "failure", reason: { question_event: !!question, failure_event: failed }, events: [summaryById.get(event.id)] });
    }
  }
  if (state.complete && Array.isArray(state.latest?.attention)) {
    const flags = new Set(state.latest.attention);
    for (const id of entries.keys()) if (id.startsWith("flag:") && !flags.has(id.slice(5))) entries.delete(id);
  }
  if (["failed", "systemError"].includes(state.latest?.status) || state.latest?.latest_turn_status === "failed") entries.set("backend:failure", { attention: "failure", reason: { backend_status: state.latest.status, latest_turn_status: state.latest.latest_turn_status }, events: [] });
  // Incomplete observations cannot erase any previous unresolved evidence.
  if (!state.complete && prior) for (const [id, entry] of priorEntries) if (!entries.has(id)) entries.set(id, entry);
  if (state.complete && state.latest?.latest_turn_status === "completed" && !["failed", "systemError"].includes(state.latest.status)) {
    entries.delete("backend:failure");
    for (const [id, entry] of entries) if (entry.attention === "failure" && entry.events?.every(e => e.type === "turn" && typeof e.event_id === "string" && e.event_id !== state.latest.latest_turn_id)) entries.delete(id);
  }
  // Unverifiable legacy information is historical caution, not current work state.
  if (state.complete && state.latest?.latest_turn_status === "completed" && state.latest.active_turn_count === 0
    && ["idle", "completed"].includes(state.latest.status) && Array.isArray(state.latest.attention) && state.latest.attention.length === 0) {
    state.historyNotes = [...entries.values()].filter(entry => entry.attention === "unknown");
    for (const [id, entry] of entries) if (entry.attention === "unknown") entries.delete(id);
  }
  if (!entries.size) return null;
  const values = [...entries.values()], attention = values.some(e => e.attention === "human") ? "human" : values.some(e => e.attention === "failure") ? "failure" : "unknown";
  return { attention, reason: { evidence: values.map(e => e.reason) }, events: [...new Map(values.flatMap(e => e.events ?? []).map(e => [e.token, e])).values()], entries: [...entries] };
}

function initialBoundaryProven(start, threadId) {
  if (start.initial_boundary_proven === true) return true;
  try {
    const claim = parseCursor(start.sync_cursor, threadId);
    const captured = new Set(start.initial_events.map(e => JSON.stringify([e.turn_id, e.id]))).size;
    return claim.v === 1 && claim.count === captured;
  } catch { return false; } // Opaque legacy boundaries remain unproven.
}

// The head keeps a settled member's last row; events and detail records stay
// prunable, so the row must not point at them.
const settledRow = work => ({ title: work.title, execution: work.execution, attention: work.attention, group: work.group, reason: work.reason,
  cursor: work.cursor, sync_revision: work.sync_revision, turn_identity: work.turn_identity, history_notes: work.history_notes,
  complete: work.complete, history_gap: work.history_gap });
const settledMarker = ({ row, ...marker }) => marker;

// Stop is irreversible, so a stopped member read completely and found quiet
// needs no further reads. An unreadable one settles only on the operator's word.
function settlement(decision, work, state, unresolvedAttention, settledAt) {
  if (!decision.stopped) return null;
  if (work.complete) return ["idle", "terminal"].includes(work.execution) && !unresolvedAttention ? { basis: "observed", settled_at: settledAt, row: settledRow(work) } : null;
  return decision.excludeReason && state.unreadable ? { basis: "excluded", reason: decision.excludeReason, error: state.error, settled_at: settledAt, row: settledRow(work) } : null;
}

export async function syncProject(projectId, options = {}, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId) throw failure("project sync requires --project.");
  const byteBudget = validateBudget(options.byteBudget ?? 16000), pageLimit = options.pageLimit ?? 1000, maxPagesPerWork = options.maxPagesPerWork ?? 100;
  if (!Number.isInteger(maxPagesPerWork) || maxPagesPerWork < 1 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw failure("Invalid sync byte/page budget.");
  // Reject an oversized fixed envelope before reading or committing state.
  pageResult({ project_id: projectId, membership_digest: "0".repeat(64), complete: false, works: [], created_at: new Date().toISOString() }, "0".repeat(36), byteBudget);
  const storage = dependencies.storage ?? {}, read = dependencies.read;
  if (typeof read !== "function") throw failure("Project sync reader is unavailable.");
  const members = await listManagedThreads(projectId, storage), membershipDigest = managedMembershipDigest(members);
  const previous = await readRecord("project-sync-heads", hash(projectId).slice(0, 40), storage), eventRecords = [], states = new Map();
  // One decision per member, made before any network read: evidence that a
  // stopped member is quiet must postdate the stop. An unreadable supervisor
  // record never hides a member, it is observed.
  const plan = new Map();
  for (const member of members) {
    const stopped = await getSupervisor(member.thread_id, storage).then(binding => binding?.state === "stopped", () => false);
    const entry = stopped ? previous?.settled?.[member.thread_id] : undefined;
    plan.set(member.thread_id, entry ? { action: "carry", member, entry } : { action: "observe", member, stopped });
  }
  if (options.excludeUnreadable === undefined ? options.reason !== undefined : dependencies.waitProbe || typeof options.reason !== "string" || !options.reason.trim()) {
    throw failure("Use project sync --project ID --exclude-unreadable THREAD --reason TEXT.");
  }
  const exclusion = options.excludeUnreadable === undefined ? null : plan.get(normalizeTaskId(options.excludeUnreadable));
  if (exclusion === undefined) throw failure("The work to exclude is not a member of this project.", "PROJECT_SYNC_EXCLUDE_UNMANAGED");
  if (exclusion?.action === "observe") {
    if (!exclusion.stopped) throw failure("Only stopped work can be excluded. Unreadable work that is still supervised stays incomplete; stop it only after acceptance.", "PROJECT_SYNC_EXCLUDE_NOT_STOPPED");
    exclusion.excludeReason = options.reason.trim();
  }
  for (const { action, member } of plan.values()) {
    if (action !== "observe") continue;
    // Wait probes start where each member was last reviewed, even if a later
    // partial sync advanced its membership cursor.
    const cursor = dependencies.waitProbe ? previous?.wait_baseline?.works?.[member.thread_id]?.cursor ?? member.sync_cursor : member.sync_cursor;
    states.set(member.thread_id, { member, cursor, events: [], observations: [], seen: new Set([cursor]), pages: 0, complete: false, history_gap: false, retry_after_ms: null, error: null, unreadable: false });
  }
  // A successful start observed these events but has not presented them yet.
  // Keep them until membership publication commits the first sync cursor.
  const starts = [...states.values()].some(state => !state.member.sync_cursor) ? await listRecords("work-starts", storage) : [];
  for (const state of states.values()) if (!state.member.sync_cursor) {
    const start = starts.find(record => record.thread_id === state.member.thread_id && Array.isArray(record.initial_events) && record.sync_cursor);
    if (start) {
      if (!initialBoundaryProven(start, state.member.thread_id)) { state.error = "WORK_INITIAL_HISTORY_GAP"; state.history_gap = true; state.unreadable = true; continue; }
      state.events.push(...start.initial_events); state.observations.push({ events: start.initial_events }); state.cursor = start.sync_cursor; state.seen.add(start.sync_cursor);
    }
  }
  const readPage = async state => {
    try {
      const page = validateSyncPage(await read(state.member.thread_id, { connection: state.member.connection, since: state.cursor, limit: pageLimit, fullEvents: true }), state.member.thread_id, state.cursor, state.seen);
      if (page.omitted_older_events > 0 || (!state.cursor && page.omitted_older_events !== 0)) throw failure("Initial history boundary is unproven.", "WORK_INITIAL_HISTORY_GAP");
      assertHistoryBatch(state.events, page.events);
      if (state.member.environment_config_id && page.environment_config_id !== state.member.environment_config_id) throw failure("The task environment differs from its managed route.", "PROJECT_ROUTE_MISMATCH");
      state.seen.add(page.cursor); state.observations.push(page);
      state.pages++; state.cursor = page.cursor; state.events.push(...(page.events ?? [])); state.latest = page; state.complete = !page.has_more; return page.has_more;
    } catch (error) {
      state.complete = false; state.error = error.code ?? "OBSERVATION_FAILED"; state.history_gap = gapCodes.has(error.code);
      if (error.code === "CLOUD_RATE_LIMITED" || error.http_status === 429) state.retry_after_ms = error.retry_after_ms ?? 15000;
      // A backend that asks for a retry has not shown the work to be unreadable.
      state.unreadable = state.retry_after_ms === null;
      return false;
    }
  };
  // Fair first round: every member gets one page before any backlog is drained.
  for (const state of states.values()) if (!state.error) await readPage(state);
  let pending = [...states.values()].filter(state => !state.complete && !state.error);
  while (pending.length) {
    const next = [];
    for (const state of pending) {
      if (state.pages >= maxPagesPerWork) { state.error = "PAGE_BUDGET_EXHAUSTED"; continue; }
      if (await readPage(state)) next.push(state);
    }
    pending = next;
  }
  // Verify completed heads once more so events arriving during backlog draining
  // are not reported as part of a falsely complete snapshot.
  for (const state of states.values()) if (state.complete && !state.error) {
    if (await readPage(state)) { state.complete = false; state.error = "SYNC_HEAD_ADVANCED"; }
  }

  // Wait cannot certify "no change" or move its reviewed baseline when the
  // backend has not established the current approval/question flag state.
  if (dependencies.waitProbe) for (const state of states.values()) if (state.complete && !Array.isArray(state.latest?.attention)) {
    state.complete = false; state.error = "PROJECT_WAIT_ATTENTION_UNKNOWN";
  }
  const works = [], unresolved = {}, historical = { ...previous?.historical_attention };
  for (const state of states.values()) {
    const priorAttention = previous?.unresolved_attention?.[state.member.thread_id] ?? null;
    let axes;
    if (state.latest) axes = classify({ ...state.latest, events: [] }, state.complete, state.member.connection);
    else axes = { execution: "unknown", attention: "unknown", observation: "unavailable", group: "未確認", reason: { error: state.error } };
    state.events = [...new Map(state.events.map(e => [JSON.stringify([e.turn_id ?? null, e.id]), e])).values()];
    const eventSummaries = state.events.map(event => summarizeEvent(event, state.member.thread_id, eventRecords));
    state.eventSummaries = eventSummaries;
    const currentAttention = reduceAttention(state, priorAttention, eventSummaries);
    if (state.historyNotes?.length) historical[state.member.thread_id] = [...new Map([...historical[state.member.thread_id] ?? [], ...state.historyNotes].map(entry => [JSON.stringify(entry), entry])).values()];
    if (currentAttention) {
      unresolved[state.member.thread_id] = currentAttention;
      axes.attention = currentAttention.attention; axes.reason = currentAttention.reason; axes.group = currentAttention.attention === "unknown" ? "未確認" : "対応が必要";
    }
    const repeatedEvents = currentAttention?.events.filter(e => !eventSummaries.some(s => s.token === e.token)) ?? [];
    works.push({ thread_id: state.member.thread_id, title: state.latest?.title ?? null, ...axes, history_gap: state.history_gap,
      retry_after_ms: state.retry_after_ms, complete: state.complete, cursor: state.complete ? state.cursor : null, events: [...repeatedEvents, ...eventSummaries], error: state.error,
      turn_identity: state.latest?.latest_turn_id ?? state.latest?.current_turn_id ?? state.latest?.turn_id ?? state.latest?.active_turn_id ?? null,
      history_notes: historical[state.member.thread_id] ?? [],
      resolution_unconfirmed: !!currentAttention, attention_repeated: !!priorAttention && !!currentAttention });
  }
  // Rows read in this run. Carried rows join the result but take no part in
  // completeness, cursors, detail records or conflict handling.
  const observed = [...works], carried = {};
  for (const { action, member, entry } of plan.values()) {
    if (action !== "carry") continue;
    // Attention is rebuilt from the members read above, so carry this one's.
    const attention = previous.unresolved_attention?.[member.thread_id];
    if (attention) unresolved[member.thread_id] = attention;
    carried[member.thread_id] = entry;
    works.push({ thread_id: member.thread_id, ...entry.row, observation: "settled", events: [], settled: settledMarker(entry),
      resolution_unconfirmed: !!attention, attention_repeated: !!attention });
  }
  const observedComplete = () => observed.every(w => w.settled || w.complete);
  works.sort((a, b) => (a.group === "対応が必要" ? -1 : 0) - (b.group === "対応が必要" ? -1 : 0)
    || (a.observation === "settled") - (b.observation === "settled") || a.thread_id.localeCompare(b.thread_id));
  const syncToken = randomUUID(), createdAt = new Date().toISOString();
  const head = { schema: 1, project_id: projectId, sync_token: syncToken, membership_digest: membershipDigest,
    complete: observedComplete(), complete_work_ids: works.filter(w => w.complete).map(w => w.thread_id),
    unresolved_attention: unresolved, historical_attention: historical, created_at: createdAt,
    ...(Object.keys(carried).length ? { settled: carried } : {}),
    ...(previous?.wait_baseline ? { wait_baseline: previous.wait_baseline } : {}),
    ...(previous?.wait_reported_failures ? { wait_reported_failures: previous.wait_reported_failures } : {}) };
  // A probe that sees only ordinary progress must not publish, consume events,
  // or replace the orchestrator's reviewed baseline.
  if (dependencies.waitProbe && !dependencies.waitProbe({ previous, members, membershipDigest, states })) return null;
  head.wait_sync_token = previous?.wait_sync_token ?? null;
  for (const work of observed) work.detail_token = randomUUID();
  // The existing project head lock protects only publication, never network I/O.
  // A stale reader must not replace a newer attention head, even after a CAS miss.
  let conflict = null;
  try {
    await withStoreLock(`project-sync-${hash(projectId).slice(0, 40)}`, async () => withHistoryReservation({ eventRecords, works, head, previous }, async (historyWrite) => {
      const current = await readRecord("project-sync-heads", hash(projectId).slice(0, 40), storage);
      if (hash(current ?? null) !== hash(previous ?? null)) throw failure("A newer project sync was published.", "SYNC_CURSOR_CONFLICT");
      // Persist attention evidence before advancing any cursor. A crash during
      // publication leaves an incomplete head that the next sync can recover.
      for (const record of eventRecords) await historyWrite("project-sync-events", record.token, { schema: 1, project_id: projectId, sync_token: syncToken, ...record }, storage);
      await writeRecord("project-sync-heads", hash(projectId).slice(0, 40), { ...head, complete: false, complete_work_ids: [], publication_pending: true }, storage);
      // CAS uses the snapshot revision even if an empty read returns the same cursor.
      for (const state of states.values()) if (state.complete) {
        const work = works.find(w => w.thread_id === state.member.thread_id);
        try {
          const updated = await updateManagedThreadCursor(state.member.thread_id, state.member.sync_cursor, state.cursor, storage, state.member.sync_revision ?? 0);
          work.sync_revision = updated.sync_revision;
        } catch (error) {
          work.complete = false; work.cursor = null; work.error = error.code; work.observation = "incomplete";
          state.complete = false;
          const retained = reduceAttention(state, previous?.unresolved_attention?.[work.thread_id], state.eventSummaries);
          if (retained) {
            unresolved[work.thread_id] = retained; work.attention = retained.attention; work.reason = retained.reason;
            work.group = retained.attention === "unknown" ? "未確認" : "対応が必要"; work.resolution_unconfirmed = true;
            work.attention_repeated = !!previous?.unresolved_attention?.[work.thread_id];
            work.events = [...new Map([...retained.events, ...work.events].map(e => [e.token, e])).values()];
          }
        }
      }
      // Settle only on what this publication commits. The pending head above
      // must not skip a member whose last delta was never presented.
      for (const work of observed) {
        const entry = settlement(plan.get(work.thread_id), work, states.get(work.thread_id), unresolved[work.thread_id], createdAt);
        if (entry) { head.settled = { ...head.settled, [work.thread_id]: entry }; work.settled = settledMarker(entry); }
      }
      head.complete = observedComplete();
      head.complete_work_ids = works.filter(w => w.complete).map(w => w.thread_id);
      // The orchestrator reviews what a wait returns and what a complete sync
      // shows; a partial sync is not a review. A member this publication could
      // not read keeps the entry it was last reviewed against, stamped with the
      // publication that wrote it. A settled member leaves both, even when a
      // partial sync settles it. Only wait reports failures: a member that fails
      // only the wait probe must not be returned again after every ordinary sync.
      let { wait_baseline: baseline, wait_reported_failures: failures = {} } = head;
      if (dependencies.waitProbe || head.complete) {
        const entries = {};
        if (dependencies.waitProbe) failures = {};
        for (const [id, state] of states) {
          if (state.complete) entries[id] = { cursor: state.cursor, signal: projectWaitSignal(state.latest), sync_token: syncToken };
          else {
            if (dependencies.waitProbe) failures[id] = works.find(work => work.thread_id === id).error;
            if (baseline?.works?.[id]) entries[id] = { sync_token: baseline.sync_token, ...baseline.works[id] };
          }
        }
        baseline = { sync_token: syncToken, membership_digest: membershipDigest, works: entries };
        if (dependencies.waitProbe) head.wait_sync_token = syncToken;
      }
      const unsettled = map => Object.fromEntries(Object.entries(map).filter(([id]) => !head.settled?.[id]));
      if (baseline) head.wait_baseline = { ...baseline, works: unsettled(baseline.works) };
      failures = Object.fromEntries(Object.entries(unsettled(failures)).filter(([id]) => plan.has(id)));
      if (Object.keys(failures).length) head.wait_reported_failures = failures; else delete head.wait_reported_failures;
      // Save detail records before publishing a head that work tell may consume.
      const detailStart = eventRecords.length;
      for (const work of observed) {
        eventRecords.push({ token: work.detail_token, thread_id: work.thread_id, event: { type: "workDetails", work: { ...work } } });
      }
      await historyWrite("project-sync-results", syncToken, { schema: 2, project_id: projectId, membership_digest: membershipDigest, wait_sync_token: head.wait_sync_token, complete: head.complete, works, created_at: createdAt }, storage);
      for (const record of eventRecords.slice(detailStart)) await historyWrite("project-sync-events", record.token, { schema: 1, project_id: projectId, sync_token: syncToken, ...record }, storage);
      await writeRecord("project-sync-heads", hash(projectId).slice(0, 40), head, storage);
    }, storage), storage);
  } catch (error) {
    if (!["SYNC_CURSOR_CONFLICT", "PROJECT_SYNC_CONFLICT", "RECORD_BUSY"].includes(error.code)) throw error;
    conflict = error.code; head.complete = false;
    for (const work of observed) { work.complete = false; work.cursor = null; work.error ??= error.code === "SYNC_CURSOR_CONFLICT" ? "SYNC_CURSOR_CONFLICT" : "PROJECT_SYNC_CONFLICT"; work.observation = "incomplete"; }
    for (const work of observed) eventRecords.push({ token: work.detail_token, thread_id: work.thread_id, event: { type: "workDetails", work: { ...work } } });
    await withHistoryReservation({ eventRecords, works, head, previous }, async (historyWrite) => {
      await historyWrite("project-sync-results", syncToken, { schema: 2, project_id: projectId, membership_digest: membershipDigest, complete: false, works, created_at: createdAt }, storage);
      for (const record of eventRecords) await historyWrite("project-sync-events", record.token, { schema: 1, project_id: projectId, sync_token: syncToken, ...record }, storage);
    }, storage);
  }
  const page = pageResult({ project_id: projectId, membership_digest: membershipDigest, wait_sync_token: head.wait_sync_token, complete: head.complete, works, created_at: createdAt }, syncToken, byteBudget);
  // Outside the paged envelope, whose byte count is already final. Only this
  // marker tells a result that was never published from one where every read failed.
  if (conflict) page.publication_conflict = conflict;
  if (!exclusion) return page;
  const id = exclusion.member.thread_id, row = works.find(w => w.thread_id === id);
  page.exclude_unreadable = { thread_id: id, ...(exclusion.action === "carry" ? { outcome: "already_settled" }
    : head.settled?.[id]?.basis === "excluded" ? { outcome: "excluded", error: head.settled[id].error }
    : row.complete ? { outcome: "unnecessary" } : { outcome: "not_applied", error: row.error }) };
  return page;
}
