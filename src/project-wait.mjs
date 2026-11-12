import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { syncProject, projectWaitSignal, changedSinceBaseline } from "./project-sync.mjs";
import { listManagedThreads } from "./project-index.mjs";
import { getSupervisor } from "./supervision.mjs";
import { readRecord, listRecords, writeRecord, removeRecord, withStoreLock } from "./store.mjs";
import { shellArgument } from "./prompt-command.mjs";
import path from "node:path";

const exec = promisify(execFile);
const failure = (message, code = "PROJECT_WAIT_INVALID") => Object.assign(new Error(message), { code });

// Include boot identity/start ticks on Linux. On macOS ps supplies the process
// start date and a per-wait nonce in its process title, so even PID reuse within
// one second cannot match. Hash command text before returning an identity: an
// agent's argv can contain the entire private orchestration prompt. Equality
// still includes the command/nonce without copying it into local records.
// Stopped/zombie processes cannot count as observing.
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
      return !match || /[ZXT]/.test(match[2]) ? null
        : `${match[1].replace(/\s+/g, " ")}:sha256:${createHash("sha256").update(match[3]).digest("hex")}`;
    }
    throw failure("Project wait process identity is supported on macOS and Linux.", "PROJECT_WAIT_IDENTITY_UNAVAILABLE");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || error.code === 1) return null;
    throw error;
  }
}

// Use the nearest agent ancestor, never a shared terminal/shell or project ID.
// comm identifies native CLIs; the first script argument covers Node installs.
// Official native install layout: https://code.claude.com/docs/en/setup#auto-updates
const nativeClaude = executable => /(?:^|\/)\.local\/share\/claude\/versions\/\d+\.\d+\.\d+$/.test(executable);
function agentProcess({ executable, command }) {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const args = words.map(word => word.replace(/^["']|["']$/g, ""));
  // A shared App Server hosts multiple threads; it is not one CLI session.
  const beforePrompt = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  if (path.basename(executable) === "codex" && beforePrompt.includes("app-server")) return false;
  if (["claude", "codex"].includes(path.basename(executable)) || nativeClaude(executable)) return true;
  if (!/^node(?:js)?$/.test(path.basename(executable))) return false;
  const script = words[1]?.replace(/^["']|["']$/g, "") ?? "";
  if (/(?:^|\/)codex(?:\.m?js)?$/.test(script)) return !beforePrompt.includes("app-server");
  return /(?:^|\/)claude(?:\.m?js)?$/.test(script) || /\/@anthropic-ai\/claude-code\/cli\.js$/.test(script);
}

export async function processAncestors() {
  const ancestors = [], visited = new Set();
  let pid = process.ppid;
  while (pid > 1 && !visited.has(pid) && ancestors.length < 64) {
    visited.add(pid);
    let ppid, executable, command;
    if (process.platform === "linux") {
      try {
        const [stat, cmdline, comm] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/comm`, "utf8")]);
        ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        executable = comm.trim(); command = cmdline.split("\0").filter(Boolean).map(word => JSON.stringify(word)).join(" ");
        // Linux comm holds only the basename of a version-named native binary.
        if (/^\d+\.\d+\.\d+$/.test(executable)) executable = await readlink(`/proc/${pid}/exe`);
      } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) break; throw error; }
    } else if (process.platform === "darwin") {
      // Keep comm last: macOS truncates non-final ps columns, including paths.
      const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "ppid=", "-o", "comm="], { timeout: 2000 });
      const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      ppid = Number(match[1]); executable = match[2]; command = "";
      if (/^(?:node(?:js)?|codex)$/.test(path.basename(executable))) {
        command = (await exec("/bin/ps", ["-p", String(pid), "-o", "args="], { timeout: 2000 })).stdout.trim();
      }
    } else throw failure("Orchestrator process inspection requires macOS or Linux.", "PROJECT_WAIT_IDENTITY_UNAVAILABLE");
    ancestors.push({ pid, ppid, executable, command }); pid = ppid;
  }
  return ancestors;
}

export async function orchestratorIdentity(dependencies = {}) {
  const ancestors = await (dependencies.processAncestors ?? processAncestors)();
  const owner = ancestors.find(agentProcess);
  if (!owner) return null;
  const start = await (dependencies.processIdentity ?? processIdentity)(owner.pid);
  return start ? { pid: owner.pid, process_start: start } : null;
}

export async function projectGuardStatus(projectId, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId.trim()) throw failure("Use project guard --project ID --status.");
  try {
    let marker;
    try { marker = JSON.parse((dependencies.env ?? process.env).CODEXTEER_STOP_GUARD ?? "null"); } catch { /* Unverified inherited value. */ }
    if (marker?.project_id !== projectId || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
      || typeof marker.process_start !== "string" || !marker.process_start) return { project_id: projectId, stop_hook: "unverified" };
    const ancestors = await (dependencies.processAncestors ?? processAncestors)();
    const launcherIndex = ancestors.findIndex(p => p.pid === marker?.pid);
    // A marker inherited by a nested or unrelated agent is not its hook setting.
    const agents = launcherIndex > 0 ? ancestors.slice(0, launcherIndex).filter(agentProcess) : [];
    const configured = agents.length === 1
      && await (dependencies.processIdentity ?? processIdentity)(marker.pid) === marker.process_start;
    return { project_id: projectId, stop_hook: configured ? "configured" : "unverified" };
  } catch (error) {
    return { project_id: projectId, stop_hook: "unverified", error: error.code ?? "PROCESS_INSPECTION_FAILED" };
  }
}

// Outside the paged sync envelope: output_bytes and the byte budget measure that alone.
export async function withStopHook(data) {
  return Object.assign(data, { stop_hook: (await projectGuardStatus(data.project_id)).stop_hook });
}

// The publication that last wrote a member's baseline entry; a 0.23.0 entry was
// written with its whole baseline.
const entryWriter = (baseline, id) => baseline.works[id] && (baseline.works[id].sync_token ?? baseline.sync_token);

const UNREAD_GRACE_MS = 60000;
const setStreaks = (observedAttention, unread) => { if (Object.keys(unread).length) observedAttention.unread = unread; else delete observedAttention.unread; };

// A failed read says nothing about its member, and the next full read returns
// everything since the cursor. So a failure is reported only once it has lasted
// two polls and the grace. A wait publication keeps as reported the members it
// reported before that still fail, and adds those whose streak has lasted. A
// member that merely fails in a publication is listed there, not reported. Its
// streak runs on: only a full read or being reported ends one, so returns closer
// together than the grace cannot keep a member from being reported. A reported
// member keeps no streak, so a quiet wait stops writing and a member shown
// readable since starts from one poll.
function unreadStreaks(previous, observedAttention, failures, graceMs) {
  const reported = previous?.wait_reported_failures ?? {}, now = Date.now(), unread = {};
  const report = new Set(Object.keys(failures).filter(id => Object.hasOwn(reported, id)));
  let lasting = false;
  for (const id of Object.keys(failures)) {
    if (report.has(id)) continue;
    const streak = observedAttention.unread?.[id];
    // A wall clock that moved backwards restarts the grace, never the streak.
    unread[id] = streak ? { since: Math.min(streak.since, now), polls: Math.min(streak.polls + 1, 2) } : { since: now, polls: 1 };
    if (unread[id].polls >= 2 && now - unread[id].since >= graceMs) { report.add(id); lasting = true; }
  }
  setStreaks(observedAttention, unread);
  return { lasting, report };
}

function probeReason({ previous, membershipDigest, states }, observedAttention, lasting) {
  const baseline = previous?.wait_baseline;
  if (!baseline) return "initial_sync";
  if (baseline.membership_digest !== membershipDigest) return "membership_changed";
  // Observed flags hold only while the entry they were compared with stands. A
  // member left unread by a newer publication keeps its entry, so a clear seen
  // before it still makes a reappearance new.
  const entries = observedAttention.entries ?? {};
  for (const id of Object.keys(observedAttention.flags)) {
    if ((entries[id] ?? observedAttention.baseline) === entryWriter(baseline, id)) entries[id] = entryWriter(baseline, id);
    else { delete observedAttention.flags[id]; delete entries[id]; }
  }
  Object.assign(observedAttention, { baseline: baseline.sync_token, entries });
  for (const [id, state] of states) {
    if (!state.complete) continue;
    // A member never read in full before is new to the orchestrator once it is.
    const entry = baseline.works[id];
    if (!entry || changedSinceBaseline(state, entry, observedAttention.flags[id] ?? entry.signal.attention ?? [])) return "work_changed";
    observedAttention.flags[id] = projectWaitSignal(state.latest).attention; entries[id] = entryWriter(baseline, id);
  }
  return lasting ? "observation_failed" : null;
}

export async function waitProject(projectId, { timeoutMs } = {}, dependencies = {}) {
  if (typeof projectId !== "string" || !projectId.trim() || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0))) {
    throw failure("Use project wait --project ID [--timeout-ms N], with a nonnegative integer timeout.");
  }
  const storage = dependencies.storage ?? {}, identity = dependencies.processIdentity ?? processIdentity;
  // Nobody is told the result once the command that started this wait is gone.
  // A killed shell sends its child no signal and closes nothing the child can
  // see: the child only gets another parent. A wait that starts already
  // detached (nohup as its shell's last command) has no launcher to lose.
  const parentPid = dependencies.parentPid ?? (() => process.ppid), launcher = parentPid();
  const launcherExited = () => launcher > 1 && parentPid() !== launcher;
  // A second waiter must not consume a change that the first is about to return.
  const key = createHash("sha256").update(projectId).digest("hex").slice(0, 40);
  let owned = false;
  return withStoreLock(`project-wait-${key}`, async () => {
    owned = true;
    const id = randomUUID(), originalTitle = process.title;
    process.title = `codexteer-wait-${id}`;
    try {
      const start = await identity(process.pid);
      if (!start) throw failure("Cannot verify this wait process's start identity.", "PROJECT_WAIT_IDENTITY_UNAVAILABLE");
      const owner = await (dependencies.orchestratorIdentity ?? (() => orchestratorIdentity(dependencies)))();
      const record = { schema: 1, project_id: projectId, pid: process.pid, process_start: start, owner, created_at: new Date().toISOString() };
      await writeRecord("project-waits", key, record, storage);
      try {
        // Separate from reviewed cursors: retain observed clear/reappearance
        // edges across bounded waits, keyed to each member's baseline entry.
        const observedAttention = await readRecord("project-wait-attention", key, storage)
          ?? { schema: 1, project_id: projectId, baseline: null, flags: {} };
        const isMap = (value, valid) => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(valid);
        if (observedAttention.schema !== 1 || observedAttention.project_id !== projectId
          || !(observedAttention.baseline === null || typeof observedAttention.baseline === "string")
          || !isMap(observedAttention.flags, flags => Array.isArray(flags) && flags.every(flag => typeof flag === "string"))
          || (observedAttention.entries !== undefined && !isMap(observedAttention.entries, token => typeof token === "string"))
          || (observedAttention.unread !== undefined && !isMap(observedAttention.unread, streak => !!streak && typeof streak === "object"
            && Number.isFinite(streak.since) && Number.isSafeInteger(streak.polls) && streak.polls > 0))) {
          throw failure("Invalid project wait attention observations. Inspect local state before restarting wait.");
        }
        let savedAttention = JSON.stringify(observedAttention), failures = {}, reported = new Set();
        // A recovery that an earlier version recorded is no longer used.
        delete observedAttention.recovered;
        const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
        const members = await listManagedThreads(projectId, storage);
        const pollMs = dependencies.pollMs ?? (members.some(m => ["cloud", "desktop-cloud"].includes(m.connection)) ? 15000 : 1000);
        const graceMs = dependencies.unreadGraceMs ?? UNREAD_GRACE_MS;
        // Outside the paged sync envelope, on every return: the members the last read
        // could not complete, and whether the head holds each as reported.
        const unreadable = () => Object.entries(failures).map(([thread_id, error]) => ({ thread_id, error, reported: reported.has(thread_id) }));
        // A wait that outlives its session would hold the project lock forever and
        // publish changes nobody reads. An inspection error is not proof of exit.
        const ownerExited = async () => !!owner && await identity(owner.pid).then(start => start !== owner.process_start, () => false);
        for (;;) {
          const abandoned = launcherExited() ? "launcher_exited" : await ownerExited() ? "owner_exited" : null;
          if (abandoned) return { project_id: projectId, changed: false, timed_out: false, reason: abandoned, unreadable: unreadable(), sync: null };
          let reason;
          const sync = await syncProject(projectId, {}, { ...dependencies, waitProbe: snapshot => {
            // The launcher went during this read: leave the change to the next wait.
            if (launcherExited()) return null;
            failures = Object.fromEntries([...snapshot.states].flatMap(([id, state]) => state.complete ? [] : [[id, state.error]]));
            const { lasting, report } = unreadStreaks(snapshot.previous, observedAttention, failures, graceMs);
            // A quiet poll adds no member, so this is also what the head holds.
            reported = report;
            return (reason = probeReason(snapshot, observedAttention, lasting)) ? report : null;
          } });
          // A newer sync won the head: nothing this wait read was published or reviewed.
          if (sync?.publication_conflict) {
            reason = "observation_failed";
            reported = new Set(Object.keys((await readRecord("project-sync-heads", key, storage))?.wait_reported_failures ?? {}));
          // The publication reported these members, which ends their streaks.
          } else if (sync) setStreaks(observedAttention, Object.fromEntries(Object.entries(observedAttention.unread ?? {}).filter(([id]) => !reported.has(id))));
          // Also before a return, so the saved streaks always describe the last poll.
          const observed = JSON.stringify(observedAttention);
          if (observed !== savedAttention) {
            await writeRecord("project-wait-attention", key, observedAttention, storage); savedAttention = observed;
          }
          if (sync) return { project_id: projectId, changed: reason !== "observation_failed", timed_out: false, reason, unreadable: unreadable(), sync };
          if (performance.now() >= deadline) return { project_id: projectId, changed: false, timed_out: true, reason: "timeout", unreadable: unreadable(), sync: null };
          const next = Math.min(deadline, performance.now() + pollMs);
          while (performance.now() < next && !launcherExited()) await delay(Math.min(1000, next - performance.now()));
        }
      } finally { await removeRecord("project-waits", key, storage); }
    } finally { process.title = originalTitle; }
  }, storage).catch(error => {
    // A record busy inside a running wait is not another session's wait.
    if (error.code === "RECORD_BUSY" && !owned) error.message = "Project wait is already owned by another operation. Use one orchestrator per CODEX_HOME, host and project. Do not adopt another session's wait or remove its lock; have the owning session finish/cancel its wait and hand off before retrying. A wait whose session has exited ends by itself at its next poll, and one whose launching command was stopped ends within a second; after either, retry shortly.";
    throw error;
  });
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
    const waits = (await listRecords("project-waits", storage)).filter(wait => wait?.schema === 1
      && wait.project_id === projectId && typeof wait.process_start === "string" && wait.process_start);
    const owner = await (dependencies.orchestratorIdentity ?? (() => orchestratorIdentity(dependencies)))();
    if (!owner) return { systemMessage: "Project guard cannot identify the calling orchestrator session (PROJECT_GUARD_OWNER_UNVERIFIED); stop is allowed. Monitoring is unverified. Run the hook and project wait from the same supported Claude/Codex CLI session and inspect its parent process chain before relying on monitoring. No other session's wait has been accepted." };
    for (const wait of waits) {
      if (owner && wait.owner?.pid === owner.pid && wait.owner.process_start === owner.process_start
        && await identity(wait.pid) === wait.process_start) return {};
    }
    return { decision: "block", reason: `Managed work remains unfinished (${unfinished.length}, including paused work). This session has no verified live wait. Use one orchestrator per CODEX_HOME, host and project; another session's wait cannot notify you. On RECORD_BUSY, arrange handoff with the owning session instead of adopting its wait or deleting its lock. Using the same saved CLI or PATH command, CODEX_HOME and host/connection route that invoked this hook, run project wait --project ${shellArgument(projectId)} --json from this agent session as a background task with completion notification; read its result and rearm it after every exit, including after relaying questions, approvals or URLs. After acceptance, use project control stop --project ${shellArgument(projectId)} --work THREAD (or --all when all work is accepted). To end orchestration at the user's request, stop its managed controls explicitly.` };
  } catch (error) {
    // Hook failures must be visible but must not trap the user behind corrupt
    // local state. No backend connection or project sync is needed by guard.
    return { systemMessage: `Project guard could not verify local state (${error.code ?? "PROJECT_GUARD_FAILED"}); stop is allowed. Repair local state and restart project wait before relying on monitoring.` };
  }
}
