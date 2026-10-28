import { cloudTaskId } from "./cloud-id.mjs";
import { readCloudTask } from "./cloud-observe.mjs";
import { codexHome } from "./runtime.mjs";

const status = value => ["in_progress", "pending", "running", "queued"].includes(value) ? "inProgress"
  : value === "cancelled" ? "interrupted" : value === "failed" || value === "error" ? "failed" : value === "completed" ? "completed" : "unknown";

// Adapt public cloud history into the same observation model used by the local
// monitor, freshness checks and directive journal. Keep backend IDs unchanged.
export function cloudThread(snapshot) {
  const taskId = cloudTaskId(snapshot.task_id);
  const turns = snapshot.turns.map(turn => ({ id: turn.turn_id, status: turn.role === "user" ? "completed" : status(turn.status), items: [
    ...turn.commands.map(command => ({ id: command.id, type: "commandExecution", command: command.command, cwd: null,
      status: status(command.status === "inProgress" ? "in_progress" : command.status), exitCode: command.exit_code, aggregatedOutput: command.output ?? "" })),
    ...(turn.progress ?? []).map((message, index) => ({ id: `${turn.turn_id}:progress:${message.id === undefined ? `index:${index}` : `id:${message.id}`}`, type: "agentMessage",
      phase: "commentary", status: status(turn.status), text: message.text })),
    ...turn.messages.map((message, index) => turn.role === "user"
      ? { id: `${turn.turn_id}:message:${index}`, type: "userMessage", clientId: null, cloudParentTurnId: turn.parent_turn_id,
        content: [{ type: "text", text: message.text }] }
      : { id: `${turn.turn_id}:message:${index}`, type: "agentMessage", phase: "final_answer", status: status(turn.status), text: message.text }),
  ] }));
  const active = turns.filter(turn => turn.status === "inProgress");
  return { id: taskId, name: snapshot.title ?? null, cwd: null, historyMode: "aggregate", canAcceptDirectInput: true,
    status: { type: active.length ? "active" : status(snapshot.status) === "unknown" ? "systemError" : "idle", activeFlags: [] },
    turns, cloud_snapshot: snapshot };
}

export class CloudReadClient {
  constructor({ read = readCloudTask, timeoutMs = 30000, signal } = {}) {
    this.read = read; this.timeoutMs = timeoutMs; this.controller = new AbortController();
    this.cancel = () => this.close(); signal?.addEventListener("abort", this.cancel, { once: true });
    this.signal = signal; if (signal?.aborted) this.close();
  }
  async request(method, params = {}, options = {}) {
    if (this.controller.signal.aborted) throw Object.assign(new Error("Cloud observation was cancelled."), { code: "CANCELLED" });
    if (method !== "thread/read" || options.mutation) throw Object.assign(new Error("Unsupported cloud observation method."), { code: "CAPABILITY_UNSUPPORTED" });
    const id = cloudTaskId(params.threadId);
    try {
      if (!params.includeTurns || this.cached?.task_id !== id) this.cached = await this.read(id, { timeoutMs: this.timeoutMs, signal: this.controller.signal });
      const thread = cloudThread(this.cached);
      if (params.includeTurns) this.cached = null;
      return { thread };
    } catch (error) {
      const mapped = { CLOUD_CONNECTION_FAILED: "CONNECTION_FAILED", CLOUD_RATE_LIMITED: "CONNECTION_FAILED", CLOUD_TIMEOUT: "TIMEOUT", CLOUD_AUTH_TIMEOUT: "TIMEOUT", CLOUD_STATE_CHANGED: "OBSERVATION_CHANGED", CLOUD_CANCELLED: "CANCELLED" }[error.code];
      if (mapped) throw Object.assign(new Error(error.message), { code: mapped, cause_code: error.code,
        ...(error.retry_after_ms === undefined ? {} : { retry_after_ms: error.retry_after_ms }) });
      throw error;
    }
  }
  close() { this.controller.abort(); this.signal?.removeEventListener("abort", this.cancel); this.cached = null; }
}

export function cloudConnection(dependencies = {}) {
  return {
    async discover(home = codexHome()) {
      return { paths: { home, socket: "codex-cloud" }, state: { codex_home: home, cloud_connection: true,
        codex_steer_protocol: 1, codex_steer_capabilities: { thread_read: [1], history_pagination: [], turn_steer: [], turn_start: [], desktop_subscribe: [] } } };
    },
    async connect(endpoint, options = {}) {
      if (endpoint !== "codex-cloud") throw Object.assign(new Error("Invalid cloud observation endpoint."), { code: "CLOUD_TARGET_CONFLICT" });
      return new CloudReadClient({ ...dependencies, ...options });
    },
  };
}
