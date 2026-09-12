import { setTimeout as delay } from "node:timers/promises";
import { normalizeThreadId } from "./thread-id.mjs";
import { codexHome, discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { decodeCursor, readOnClient } from "./observe.mjs";
import { assertRuntimeOperation, compatibleClient } from "./compatibility.mjs";

const retryable = new Set(["CONNECTION_FAILED", "TIMEOUT", "RUNTIME_UNAVAILABLE", "RUNTIME_NOT_READY"]);
const needsReview = new Set(["STALE_CURSOR", "CURSOR_UPGRADE_REQUIRED", "OBSERVATION_CHANGED"]);

// The consumer owns the watch lifetime. A flushed cursor is a transport boundary,
// not an acknowledgement that a supervising AI has read or acted on the output.
export async function streamThread(threadInput, options, onChange, { discover = discoverRuntime, connect = RpcClient.connect, sleep = delay, now = () => performance.now() } = {}) {
  const threadId = normalizeThreadId(threadInput), { signal, pollMs = 1000, reconnectTimeoutMs = 60000 } = options;
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 10000) throw new Error("--poll-ms must be between 250 and 10000.");
  if (!Number.isInteger(reconnectTimeoutMs) || reconnectTimeoutMs < 1 || reconnectTimeoutMs > 60000) throw new Error("Invalid reconnect timeout.");
  if (signal?.aborted) return;
  let home = codexHome(), cursor = options.since, client, attempt;
  let established = false, lastObservedAt = null, outageStarted = null, attempts = 0, backoff = 1000, lastFailure;
  const connection = (state, extra = {}) => ({
    type: "connection", thread_id: threadId, state, resume_cursor: cursor ?? null,
    last_observed_at: lastObservedAt, observed_at: new Date().toISOString(), reconnect_attempts: attempts, ...extra,
  });
  const expired = () => Object.assign(new Error("Watch could not restore observation within the reconnect deadline. Check doctor before restarting from a reviewed cursor."), {
    code: "WATCH_RECONNECT_TIMEOUT", cause_code: lastFailure?.code,
  });
  const cancel = () => { attempt?.abort(new Error("Watch cancelled.")); client?.close(); };
  signal?.addEventListener("abort", cancel, { once: true });

  async function read() {
    const remaining = outageStarted === null ? null : reconnectTimeoutMs - (now() - outageStarted);
    if (remaining !== null && remaining <= 0) throw expired();
    const current = new AbortController(); attempt = current;
    // Bound the whole reconnect attempt, including initialize and multi-page reads.
    const timer = remaining === null ? null : setTimeout(() => { current.abort(expired()); client?.close(); }, remaining);
    try {
      if (signal?.aborted) cancel();
      if (!client && !current.signal.aborted) {
        const { paths, state } = await discover(home);
        assertRuntimeOperation(state, "monitor");
        home = paths.home ?? home;
        if (current.signal.aborted) throw current.signal.reason;
        client = compatibleClient(await connect(paths.socket, { signal: current.signal, timeoutMs: Math.min(8000, remaining ?? 8000) }), state);
      }
      if (current.signal.aborted) throw current.signal.reason;
      const data = await readOnClient(client, threadId, { ...options, since: cursor });
      if (current.signal.aborted) throw current.signal.reason;
      return data;
    } catch (error) { throw current.signal.aborted ? current.signal.reason : error; }
    finally { clearTimeout(timer); attempt = null; }
  }

  try {
    if (cursor) decodeCursor(cursor, threadId);
    while (!signal?.aborted) {
      let data;
      try { data = await read(); }
      catch (error) {
        if (signal?.aborted) break;
        client?.close(); client = null;
        if (outageStarted !== null && now() - outageStarted >= reconnectTimeoutMs) throw expired();
        if (!established || !retryable.has(error.code)) throw error;
        lastFailure = error;
        if (outageStarted === null) {
          outageStarted = now(); attempts = 0; backoff = 1000;
          await onChange(connection("reconnecting", { cause_code: error.code, retry_timeout_ms: reconnectTimeoutMs }));
        }
        await sleep(Math.max(0, Math.min(backoff, reconnectTimeoutMs - (now() - outageStarted))), undefined, { signal });
        if (now() - outageStarted >= reconnectTimeoutMs) throw expired();
        backoff = Math.min(backoff * 2, 10000); attempts++;
        continue;
      }
      if (signal?.aborted) break;
      lastObservedAt = data.observed_at;
      // Only network reads are retried. Consumer/output errors always stop here.
      if (cursor && data.changed) await onChange({ ...data, type: "observation", reason: "change" });
      if (signal?.aborted) break;
      cursor = data.cursor;
      if (!established || outageStarted !== null) {
        await onChange(connection(established ? "recovered" : "watching", { has_more: data.has_more }));
      }
      established = true; outageStarted = null;
      if (!data.has_more && !signal?.aborted) await sleep(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal?.aborted) {
      const failure = error instanceof Error ? error : new Error("Watch consumer failed.");
      failure.code ??= "WATCH_FAILED";
      failure.thread_id = threadId;
      failure.watch = connection(needsReview.has(failure.code) ? "needs_review" : "failed", { cause_code: failure.cause_code ?? failure.code });
      throw failure;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    client?.close();
  }
}

export function writeObservationLine(output, data) {
  return new Promise((resolve, reject) => {
    output.write(JSON.stringify({ ok: true, command: "watch", data }) + "\n", error => error ? reject(error) : resolve());
  });
}

export async function monitorCommand(threadId, options) {
  const controller = new AbortController(); let outputError;
  const cancel = () => controller.abort();
  const failedOutput = error => { outputError = error; cancel(); };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  process.stdout.on("error", failedOutput);
  try {
    await streamThread(threadId, { ...options, signal: controller.signal }, data => writeObservationLine(process.stdout, data));
  } catch (error) {
    if (!outputError) throw error;
  } finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    process.stdout.off("error", failedOutput);
  }
  if (outputError && outputError.code !== "EPIPE") {
    console.error(`codex-steer: Monitor output failed: ${outputError.message}`);
    process.exitCode = 1;
  }
}
