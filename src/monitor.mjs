import { setTimeout as delay } from "node:timers/promises";
import { normalizeThreadId } from "./thread-id.mjs";
import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { decodeCursor, readOnClient } from "./observe.mjs";

// The consumer owns the watch lifetime and decides whether an event needs action.
// Advancing only after onChange resolves keeps a slow consumer from losing pages.
export async function streamThread(threadInput, options, onChange, { discover = discoverRuntime, connect = RpcClient.connect, sleep = delay } = {}) {
  const threadId = normalizeThreadId(threadInput), { signal, pollMs = 1000 } = options;
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 10000) throw new Error("--poll-ms must be between 250 and 10000.");
  if (options.since) decodeCursor(options.since, threadId);
  if (signal?.aborted) return;
  const { paths } = await discover();
  if (signal?.aborted) return;
  const client = await connect(paths.socket), cancel = () => client.close();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    let cursor = options.since;
    while (!signal?.aborted) {
      const data = await readOnClient(client, threadId, { ...options, since: cursor });
      if (signal?.aborted) break;
      // Without --since the first read establishes a silent baseline.
      if (cursor && data.changed) await onChange({ ...data, reason: "change" });
      cursor = data.cursor;
      if (!data.has_more && !signal?.aborted) await sleep(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    client.close();
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
