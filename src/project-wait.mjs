import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { syncProject, projectWaitSignal } from "./project-sync.mjs";
import { listManagedThreads } from "./project-index.mjs";
import { getSupervisor } from "./supervision.mjs";
import { readRecord, listRecords, writeRecord, removeRecord, withStoreLock } from "./store.mjs";
import { shellArgument } from "./prompt-command.mjs";

const exec = promisify(execFile);
const failure = (message, code = "PROJECT_WAIT_INVALID") => Object.assign(new Error(message), { code });
const ended = new Set(["completed", "failed", "cancelled", "interrupted", "error"]);
const failed = new Set(["failed", "systemError"]);

// Include boot identity/start ticks on Linux. On macOS ps supplies the process
// start date and a per-wait nonce in its process title, so even PID reuse within
// one second cannot match. Stopped/zombie processes cannot count as observing.
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return /[ZXTt]/.test(fields[0]) ? null : `${boot.trim()}:${fields[19]}`;
    }
    if (process.platform === "darwin") {
      const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat=", "-o", "command="], { timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
      const match = stdout.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.+)$/);
      return !match || /[ZXT]/.test(match[2]) ? null : `${match[1].replace(/\s+/g, " ")}:${match[3]}`;
    }
    throw failure("Project wait process identity is supported on macOS and Linux.", "PROJECT_WAIT_IDENTITY_UNAVAILABLE");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || error.code === 1) return null;
    throw error;
  }
}

function probeReason({ previous, membershipDigest, states, complete }, observedAttention) {
  if (!complete) return "observation_failed";
  const baseline = previous?.wait_baseline;
  if (!baseline) return "initial_sync";
  if (baseline.membership_digest !== membershipDigest) return "membership_changed";
  const generation = baseline.sync_token ?? createHash("sha256").update(JSON.stringify(baseline)).digest("hex");
  if (observedAttention.baseline !== generation) {
    observedAttention.baseline = generation; observedAttention.flags = {};
  }
  for (const [id, state] of states) {
    const before = baseline.works[id]?.signal, after = projectWaitSignal(state.latest);
    if (!before) return "membership_changed";
    // Web Cloud adapts each user-history node into a completed turn too. Its
    // typed backend IDs distinguish input from assistant execution without
    // changing public events/hashes and invalidating existing read cursors.
    const executionTurn = turnId => state.member.connection !== "cloud"
      || (typeof turnId === "string" && turnId.startsWith(`${id}~assttrn_`));
    if (state.events.some(event => (event.type === "turn" && executionTurn(event.id) && ended.has(event.status))
      || (event.questions?.length && !["answered", "resolved"].includes(event.status)))) return "work_changed";
    if ((executionTurn(after.turn_id) && ended.has(after.turn_status) && (after.turn_id !== before.turn_id || after.turn_status !== before.turn_status))
      || (failed.has(after.status) && after.status !== before.status)
      || after.attention.some(flag => !(observedAttention.flags[id] ?? before.attention ?? []).includes(flag))) return "work_changed";
    observedAttention.flags[id] = after.attention;
  }
  return null;
}

export async function waitProject(projectId, { timeoutMs } = {}, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId.trim() || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0))) {
    throw failure("Use project wait --project ID [--timeout-ms N], with a nonnegative integer timeout.");
  }
  const storage = dependencies.storage ?? {}, identity = dependencies.processIdentity ?? processIdentity;
  // A second waiter must not consume a change that the first is about to return.
  const key = createHash("sha256").update(projectId).digest("hex").slice(0, 40);
  return withStoreLock(`project-wait-${key}`, async () => {
    const id = randomUUID(), originalTitle = process.title;
    process.title = `codexteer-wait-${id}`;
    try {
      const start = await identity(process.pid);
      if (!start) throw failure("Cannot verify this wait process's start identity.", "PROJECT_WAIT_IDENTITY_UNAVAILABLE");
      const record = { schema: 1, project_id: projectId, pid: process.pid, process_start: start, created_at: new Date().toISOString() };
      await writeRecord("project-waits", key, record, storage);
      try {
        // Separate from reviewed cursors: retain observed clear/reappearance
        // edges across bounded waits, keyed to the exact complete baseline.
        const observedAttention = await readRecord("project-wait-attention", key, storage)
          ?? { schema: 1, project_id: projectId, baseline: null, flags: {} };
        if (observedAttention.schema !== 1 || observedAttention.project_id !== projectId
          || !(observedAttention.baseline === null || typeof observedAttention.baseline === "string")
          || !observedAttention.flags || typeof observedAttention.flags !== "object" || Array.isArray(observedAttention.flags)
          || Object.values(observedAttention.flags).some(flags => !Array.isArray(flags) || flags.some(flag => typeof flag !== "string"))) {
          throw failure("Invalid project wait attention observations. Inspect local state before restarting wait.");
        }
        let savedAttention = JSON.stringify(observedAttention);
        const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
        const members = await listManagedThreads(projectId, storage);
        const pollMs = dependencies.pollMs ?? (members.some(m => ["cloud", "desktop-cloud"].includes(m.connection)) ? 15000 : 1000);
        for (;;) {
          let reason;
          const sync = await syncProject(projectId, {}, { ...dependencies, waitProbe: snapshot => !!(reason = probeReason(snapshot, observedAttention)) });
          if (sync) return { project_id: projectId, changed: reason !== "observation_failed" && sync.complete, timed_out: false,
            reason: sync.complete ? reason : "observation_failed", sync };
          const observed = JSON.stringify(observedAttention);
          if (observed !== savedAttention) {
            await writeRecord("project-wait-attention", key, observedAttention, storage); savedAttention = observed;
          }
          if (performance.now() >= deadline) return { project_id: projectId, changed: false, timed_out: true, reason: "timeout", sync: null };
          await delay(Math.max(0, Math.min(pollMs, deadline - performance.now())));
        }
      } finally { await removeRecord("project-waits", key, storage); }
    } finally { process.title = originalTitle; }
  }, storage);
}

export async function guardProject(projectId, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId.trim()) throw failure("Use project guard --project ID.");
  const storage = dependencies.storage ?? {}, identity = dependencies.processIdentity ?? processIdentity;
  try {
    const members = await listManagedThreads(projectId, storage);
    // Missing bindings are unfinished work, not implicit acceptance.
    const unfinished = [];
    for (const member of members) if ((await getSupervisor(member.thread_id, storage))?.state !== "stopped") unfinished.push(member.thread_id);
    if (!unfinished.length) return {};
    for (const wait of await listRecords("project-waits", storage)) {
      if (wait?.schema === 1 && wait.project_id === projectId && typeof wait.process_start === "string"
        && wait.process_start && await identity(wait.pid) === wait.process_start) return {};
    }
    return { decision: "block", reason: `Managed work remains unfinished (${unfinished.length}, including paused work). Using the same saved CLI or PATH command, CODEX_HOME and host/connection route that invoked this hook, run project wait --project ${shellArgument(projectId)} --json as a background task with completion notification; read its result and rearm it after every exit, including after relaying questions, approvals or URLs. After acceptance, use project control stop --project ${shellArgument(projectId)} --work THREAD (or --all when all work is accepted). To end orchestration at the user's request, stop its managed controls explicitly.` };
  } catch (error) {
    // Hook failures must be visible but must not trap the user behind corrupt
    // local state. No backend connection or project sync is needed by guard.
    return { systemMessage: `Project guard could not verify local state (${error.code ?? "PROJECT_GUARD_FAILED"}); stop is allowed. Repair local state and restart project wait before relying on monitoring.` };
  }
}
