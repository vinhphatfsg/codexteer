import net from "node:net";
import { chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { normalizeThreadId } from "./thread-id.mjs";

// This is our own owner-only socket, not Desktop's private/authenticated MCP pipe.
// It exposes only thread subscription, never generic RPC or approval decisions.
export class DesktopSubscriptions {
  constructor(socket, { timeoutMs = 8000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.prefix = `codex-steer-subscribe-${randomUUID()}-`;
    this.ready = false;
  }

  consume(message) {
    if (message.method || typeof message.id !== "string" || !message.id.startsWith(this.prefix)) return true;
    // Late replies to timed-out helper calls also belong to the helper.
    if (!this.pending.has(message.id)) return false;
    const request = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result?.thread?.id !== request.threadId) {
      request.reject(new Error("Desktop could not subscribe to the target task."));
    } else request.resolve();
    return false;
  }

  ensure(threadId) {
    normalizeThreadId(threadId);
    if (!this.ready) return Promise.reject(new Error("Desktop has not initialized its App Server connection."));
    const id = this.prefix + randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Desktop subscription timed out. No message was sent."));
      }, this.timeoutMs);
      this.pending.set(id, { threadId, timer, resolve, reject });
      this.socket.send(JSON.stringify({ id, method: "thread/resume", params: { threadId, excludeTurns: true } }), error => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(new Error("Desktop subscription connection failed.")); }
      });
    });
  }

  close() {
    this.ready = false;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Desktop connection closed before subscribing."));
    }
    this.pending.clear();
  }
}

export async function serveSubscriptions(socketPath, subscriptions) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10000, () => socket.destroy());
    let text = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (handled) return;
      text += chunk;
      if (Buffer.byteLength(text) > 1024) { socket.destroy(); return; }
      if (!text.includes("\n")) return;
      handled = true;
      Promise.resolve().then(async () => {
        const request = JSON.parse(text.trim());
        if (request.method !== "subscribe" || Object.keys(request).some(key => !["method", "thread_id"].includes(key))) throw new Error();
        const threadId = normalizeThreadId(request.thread_id);
        await subscriptions.ensure(threadId);
        socket.end(JSON.stringify({ ok: true, thread_id: threadId }) + "\n");
      }).catch(() => socket.end(JSON.stringify({ ok: false, error: "Desktop subscription failed. No message was sent." }) + "\n"));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return async () => {
    subscriptions.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
}

export async function ensureDesktopSubscription(socketPath, threadId, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let text = "";
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(new Error("Could not establish the Desktop task subscription. No message was sent."));
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.on("error", () => finish(true));
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ method: "subscribe", thread_id: threadId }) + "\n"));
    socket.on("data", chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 2048) { finish(true); return; }
      if (!text.includes("\n")) return;
      try {
        const response = JSON.parse(text.trim());
        finish(!(response.ok === true && response.thread_id === threadId));
      } catch { finish(true); }
    });
  });
}
