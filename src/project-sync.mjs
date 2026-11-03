import { createHash, randomUUID } from "node:crypto";
import { listManagedThreads, updateManagedThreadCursor } from "./project-index.mjs";
import { readRecord, writeRecord, withStoreLock } from "./store.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const failure = (message, code = "PROJECT_SYNC_INVALID") => Object.assign(new Error(message), { code });
const gapCodes = new Set(["STALE_CURSOR", "INVALID_CURSOR", "CURSOR_UPGRADE_REQUIRED", "OBSERVATION_CHANGED"]);
const terminal = new Set(["completed", "failed", "cancelled"]), active = new Set(["active", "inProgress", "in_progress", "pending", "queued", "running"]);

function classify(observation, complete, connection) {
  const status = observation?.status ?? "unknown", flags = observation?.attention;
  const events = observation?.events ?? [], questions = events.some(event => Array.isArray(event.questions) && event.questions.length);
  const failed = status === "systemError" || status === "failed" || events.some(event => event.status === "failed" || (event.type === "commandExecution" && Number.isInteger(event.exit_code) && event.exit_code !== 0));
  const human = questions || (Array.isArray(flags) && flags.length > 0);
  const execution = active.has(status) ? "active" : ["idle", "notLoaded"].includes(status) ? "idle" : terminal.has(status) ? "terminal" : "unknown";
  const attention = human ? "human" : failed ? "failure" : execution === "terminal" ? "review" : connection === "cloud" || flags === null || flags === undefined ? "unknown" : "none";
  const observationState = complete ? "current" : "incomplete";
  const group = observationState !== "current" ? "未確認" : ["human", "failure"].includes(attention) ? "対応が必要" : attention === "review" ? "検収待ち" : execution === "active" ? "動作中" : execution === "unknown" || attention === "unknown" ? "未確認" : "動作中";
  return { execution, attention, observation: observationState, group, reason: { backend_status: status, attention_flags: flags ?? null, question_event: questions, failure_event: failed } };
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
  if (!record) throw failure("Project sync event was not found.", "PROJECT_EVENT_NOT_FOUND");
  return record;
}

export async function continueProjectSync(token, options = {}, storage = {}) {
  const byteBudget = options.byteBudget ?? 16000, offset = options.offset ?? 0;
  const saved = await readRecord("project-sync-results", token, storage);
  if (!saved || !Number.isInteger(offset) || offset < 0) throw failure("Project sync continuation was not found.", "PROJECT_SYNC_CONTINUATION_NOT_FOUND");
  const result = { project_id: saved.project_id, sync_token: token, membership_digest: saved.membership_digest, complete: saved.complete,
    works: [], omitted_works: 0, omitted_events: 0, continuation_token: null, continuation_offset: offset, created_at: saved.created_at, output_bytes: 0, byte_budget: byteBudget };
  let next = offset;
  for (; next < saved.works.length; next++) {
    const work = saved.works[next], candidate = { ...work, events: work.events.map(event => ({ ...event, text: null })) };
    if (result.works.length && bytes({ ...result, works: [...result.works, candidate] }) > byteBudget) break;
    result.works.push(candidate);
  }
  result.omitted_works = saved.works.length - next;
  result.omitted_events = saved.works.slice(next).reduce((sum, work) => sum + work.events.length, 0);
  if (next < saved.works.length) { result.continuation_token = token; result.next_offset = next; }
  for (let previous = -1; result.output_bytes !== previous;) { previous = result.output_bytes; result.output_bytes = bytes(result); }
  return result;
}

export async function syncProject(projectId, options = {}, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId) throw failure("project sync requires --project.");
  const byteBudget = options.byteBudget ?? 16000, pageLimit = options.pageLimit ?? 1000, maxPagesPerWork = options.maxPagesPerWork ?? 100;
  if (!Number.isInteger(byteBudget) || byteBudget < 4096 || byteBudget > 1024 * 1024 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw failure("Invalid sync byte/page budget.");
  const storage = dependencies.storage ?? {}, read = dependencies.read;
  if (typeof read !== "function") throw failure("Project sync reader is unavailable.");
  const members = await listManagedThreads(projectId, storage), membershipDigest = hash(members.map(m => ({ thread_id: m.thread_id, connection: m.connection, registered_at: m.registered_at })));
  const previous = await readRecord("project-sync-heads", hash(projectId).slice(0, 40), storage), eventRecords = [], states = new Map();
  for (const member of members) states.set(member.thread_id, { member, cursor: member.sync_cursor, events: [], pages: 0, complete: false, history_gap: false, retry_after_ms: null, error: null });
  const readPage = async state => {
    try {
      const page = await read(state.member.thread_id, { connection: state.member.connection, since: state.cursor, limit: pageLimit });
      state.pages++; state.cursor = page.cursor; state.events.push(...(page.events ?? [])); state.latest = page; state.complete = !page.has_more; return page.has_more;
    } catch (error) {
      state.complete = false; state.error = error.code ?? "OBSERVATION_FAILED"; state.history_gap = gapCodes.has(error.code);
      if (error.code === "CLOUD_RATE_LIMITED" || error.http_status === 429) state.retry_after_ms = error.retry_after_ms ?? 15000;
      return false;
    }
  };
  // Fair first round: every member gets one page before any backlog is drained.
  for (const state of states.values()) await readPage(state);
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

  const works = [], unresolved = {};
  for (const state of states.values()) {
    const priorAttention = previous?.unresolved_attention?.[state.member.thread_id] ?? null;
    let axes;
    if (state.latest) axes = classify(state.latest, state.complete, state.member.connection);
    else axes = { execution: "unknown", attention: priorAttention?.attention ?? "unknown", observation: "unavailable", group: priorAttention ? "対応が必要" : "未確認", reason: { error: state.error } };
    const eventSummaries = state.events.map(event => summarizeEvent(event, state.member.thread_id, eventRecords));
    const currentAttention = ["human", "failure"].includes(axes.attention) ? { attention: axes.attention, reason: axes.reason, events: eventSummaries.filter(e => e.type === "agentMessage" || e.status === "failed") } : null;
    if (currentAttention) unresolved[state.member.thread_id] = currentAttention;
    else if (!state.complete && priorAttention) unresolved[state.member.thread_id] = priorAttention;
    works.push({ thread_id: state.member.thread_id, title: state.latest?.title ?? null, ...axes, history_gap: state.history_gap,
      retry_after_ms: state.retry_after_ms, complete: state.complete, cursor: state.complete ? state.cursor : null, events: eventSummaries,
      attention_repeated: !!priorAttention });
  }
  works.sort((a, b) => (a.group === "対応が必要" ? -1 : 0) - (b.group === "対応が必要" ? -1 : 0) || a.thread_id.localeCompare(b.thread_id));
  const syncComplete = works.every(work => work.complete), syncToken = randomUUID(), base = { project_id: projectId, sync_token: syncToken, membership_digest: membershipDigest,
    membership_count: members.length, complete: syncComplete, works: [], omitted_works: 0, omitted_events: 0, continuation_token: null, created_at: new Date().toISOString() };
  // Attention rows are mandatory, but their full text remains behind an event
  // token. Ordinary work rows are omitted whole rather than truncating JSON.
  for (const work of works) {
    const essential = work.group === "対応が必要" || work.history_gap || work.retry_after_ms;
    let candidate = work;
    if (essential && bytes({ ...base, works: [...base.works, candidate] }) > byteBudget) candidate = { ...work, events: work.events.map(event => ({ ...event, text: null })) };
    if (essential || bytes({ ...base, works: [...base.works, candidate] }) <= byteBudget) base.works.push(candidate);
    else { base.omitted_works++; base.omitted_events += work.events.length; }
  }
  if (base.omitted_works || !syncComplete) base.continuation_token = syncToken;
  await writeRecord("project-sync-results", syncToken, { schema: 1, project_id: projectId, membership_digest: membershipDigest, complete: syncComplete, works, created_at: base.created_at }, storage);
  for (const record of eventRecords) await writeRecord("project-sync-events", record.token, { schema: 1, sync_token: syncToken, ...record }, storage);
  for (const state of states.values()) if (state.complete) await updateManagedThreadCursor(state.member.thread_id, state.cursor, storage);
  const head = { schema: 1, project_id: projectId, sync_token: syncToken, membership_digest: membershipDigest, complete: syncComplete,
    complete_work_ids: works.filter(work => work.complete).map(work => work.thread_id), unresolved_attention: unresolved, created_at: base.created_at };
  await withStoreLock(`project-sync-${hash(projectId).slice(0, 40)}`, () => writeRecord("project-sync-heads", hash(projectId).slice(0, 40), head, storage), storage);
  const result = { ...base, output_bytes: 0, byte_budget: byteBudget };
  for (let previous = -1; result.output_bytes !== previous;) { previous = result.output_bytes; result.output_bytes = bytes(result); }
  return result;
}
