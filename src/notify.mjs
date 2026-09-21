const running = new Set(["inProgress", "running", "pending"]);
const failed = new Set(["failed", "error", "declined", "cancelled", "canceled"]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const key = event => JSON.stringify([event.turn_id, event.id]);
const commandState = ({ change, output, ...event }) => event;

export function notificationOptions({ notify = "digest", settleMs = 20000, maxHoldMs = 600000 } = {}) {
  if (!["all", "digest"].includes(notify)) throw new Error("--notify must be all or digest.");
  if (!Number.isInteger(settleMs) || settleMs < 1000 || settleMs > 120000) throw new Error("--settle-ms must be between 1000 and 120000.");
  if (!Number.isInteger(maxHoldMs) || maxHoldMs < 10000 || maxHoldMs > 1800000) throw new Error("--max-hold-ms must be between 10000 and 1800000.");
  return { notify, settleMs, maxHoldMs };
}

// A conservative syntax recognizer, not a shell interpreter or authorization
// check. Quoted separators stay in arguments; uncertain forms remain normal.
function tokens(command) {
  const result = []; let word = "", quote = null, started = false;
  const push = () => { if (started) result.push({ word }); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      if (++i === command.length) return null;
      word += command[i]; started = true;
    } else if (quote) {
      if (char === quote) quote = null; else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) push();
    else if (";|&".includes(char)) {
      push(); let op = char;
      if ((char === "|" || char === "&") && command[i + 1] === char) op += command[++i];
      if (op === "&") return null;
      result.push({ op });
    } else { word += char; started = true; }
  }
  if (quote) return null;
  push(); return result;
}

function allowed(words, depth) {
  const [executable, ...args] = words, name = executable?.split("/").at(-1);
  if (["sh", "bash", "zsh"].includes(name)) {
    return args.length === 2 && ["-c", "-lc", "-cl"].includes(args[0]) && isReadOnlyCommand(args[1], depth + 1);
  }
  if (["cat", "ls", "head", "tail", "wc", "pwd", "which", "stat", "file", "sleep", "echo", "grep"].includes(name)) {
    return name !== "file" || !args.some(arg => arg === "-C" || arg === "--compile");
  }
  if (name === "rg") return !args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (name === "command") return args[0] === "-v" && args.length > 1;
  if (name === "find") return !args.some(arg => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
  // sed -n alone is not read-only: its script can still write or execute.
  if (name === "sed") return args[0] === "-n" && /^(?:\d+|\$)?(?:,(?:\d+|\$))?p$/.test(args[1] ?? "") && !args.slice(2).some(arg => arg.startsWith("-"));
  if (name === "git") {
    const [operation, ...flags] = args;
    if (flags.some(arg => /^--(?:output|ext-diff|textconv|no-index)(?:=|$)/.test(arg))) return false;
    if (["status", "log", "diff", "show", "rev-parse"].includes(operation)) return true;
    return operation === "branch" && flags[0] === "--list" && flags.slice(1).every(arg => !arg.startsWith("-"));
  }
  return false;
}

export function isReadOnlyCommand(command, depth = 0) {
  if (typeof command !== "string" || !command.trim() || depth > 4 || /[<>`$\n\r\0]|\[truncated\]/.test(command)) return false;
  const parsed = tokens(command);
  if (!parsed?.length) return false;
  let words = [];
  for (const token of parsed) {
    if (token.op) {
      if (!words.length || !allowed(words, depth)) return false;
      words = [];
    } else words.push(token.word);
  }
  return words.length > 0 && allowed(words, depth);
}

function stateWake({ current, previous } = {}) {
  if (!current) return null;
  if (current.attention?.length || (previous && !same(current.attention, previous.attention))) return "attention";
  if (previous && current.status !== previous.status) return "status";
  return null;
}

export function classify(event, state = {}) {
  if (stateWake(state)) return "wake";
  if (!event) return "quiet";
  if (event.type === "userMessage" || event.type === "turn" || event.type === "plan") return "wake";
  if (event.type === "agentMessage") return event.phase === "final_answer" || event.questions != null ? "wake" : "normal";
  if (event.type === "fileChange") return failed.has(event.status) ? "wake" : "normal";
  if (event.type === "commandExecution") {
    if (isReadOnlyCommand(event.command)) return "quiet";
    if (failed.has(event.status) || (Number.isInteger(event.exit_code) && event.exit_code !== 0)) return "wake";
    if (running.has(event.status) && state.previousEvent) {
      if (same(commandState(state.previousEvent), commandState(event))) return "quiet";
    }
    return "normal";
  }
  return ["contextCompaction", "webSearch", "imageView"].includes(event.type) ? "quiet" : "normal";
}

function compact(event) {
  const copy = { ...event, compacted: true };
  delete copy.output; delete copy.diff;
  for (const field of ["command", "text"]) if (typeof copy[field] === "string") copy[field] = copy[field].slice(0, 200);
  return copy;
}

// The caller supplies time and acknowledges output only after its write succeeds.
// Limits trigger a flush at a complete read boundary, never invent a cursor.
export class NotificationBuffer {
  constructor(options = {}) {
    Object.assign(this, notificationOptions(options));
    this.entries = new Map(); this.latest = null; this.previous = null;
    this.startedAt = null; this.lastNormalAt = null; this.fromCursor = null; this.wakeReason = null;
  }

  baseline(data) { this.latest = data; this.previous = data; }

  add(data, fromCursor, time, initialStateChanged = false) {
    const previous = this.previous;
    // A supplied cursor contains a state hash, not the previous status/attention.
    const stateReason = data.changed ? stateWake({ current: data, previous }) ?? (!previous && fromCursor && (initialStateChanged || !data.events.length) ? "state" : null) : null;
    if (data.events.length || stateReason || (data.changed && !data.events.length)) {
      if (this.startedAt === null) { this.startedAt = time; this.fromCursor = fromCursor ?? null; }
      if (stateReason) this.wakeReason ??= `wake:${stateReason}`;
      else if (!data.events.length) this.lastNormalAt = time;
      for (const event of data.events) {
        const previousEvent = this.entries.get(key(event))?.comparison ?? previous?.running_commands?.find(e => key(e) === key(event));
        const level = classify(event, { previousEvent });
        this.entries.set(key(event), { event: level === "quiet" ? compact(event) : event, level, comparison: commandState(event) });
        if (level === "wake") this.wakeReason ??= `wake:${event.type}`;
        if (level === "normal") this.lastNormalAt = time;
      }
    }
    this.latest = data; this.previous = data;
  }

  reason(time) {
    if (this.startedAt === null || this.latest.has_more) return null;
    if (this.wakeReason) return this.wakeReason;
    if (this.entries.size >= 200 || Buffer.byteLength(JSON.stringify(this.observation("capacity", time))) >= 64 * 1024) return "capacity";
    if (time - this.startedAt >= this.maxHoldMs) return "max-hold";
    if (this.lastNormalAt !== null && time - this.lastNormalAt >= this.settleMs) return "settle";
    return null;
  }

  observation(reason, time) {
    if (this.startedAt === null) return null;
    const counts = { wake: 0, normal: 0, quiet: 0 };
    for (const { level } of this.entries.values()) counts[level]++;
    const runningCommands = this.latest.running_commands?.map(event => this.entries.get(key(event))?.level === "quiet" || isReadOnlyCommand(event.command) ? compact(event) : event);
    return { ...this.latest, ...(runningCommands ? { running_commands: runningCommands } : {}), events: [...this.entries.values()].map(entry => entry.event), changed: true,
      type: "observation", reason: "change", digest: { reason, held_ms: Math.max(0, time - this.startedAt), counts, from_cursor: this.fromCursor } };
  }

  clear() {
    this.entries.clear(); this.startedAt = null; this.lastNormalAt = null; this.fromCursor = null; this.wakeReason = null;
  }
}
