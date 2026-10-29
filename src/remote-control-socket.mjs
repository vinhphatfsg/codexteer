import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { CONTROL_URL, connectionPayload, controlFailure, verifyDeviceProof } from "./remote-control-auth.mjs";
import { REMOTE_CLIENT_INFO } from "./remote-client-info.mjs";

export const MAX_CONTROL_REQUEST = 65536;
const MAX_FRAME = 153600, MAX_MESSAGE = 64 * 1024 * 1024;

// Deliberately no reconnect, envelope replay or mutation retry. A new read/watch
// connection may be opened by the existing monitor after it reports an outage.
export class RemoteControlSocket extends EventEmitter {
  constructor(wire, { enrollment, environmentId, streamId = randomUUID(), signal }) {
    super();
    Object.assign(this, { wire, enrollment, environmentId, streamId, signal, readyState: WebSocket.OPEN, sequence: 0, lastServerSequence: null, assembly: null });
    this.on("error", () => {});
    this.cancel = () => this.terminate();
    signal?.addEventListener("abort", this.cancel, { once: true });
    wire.on("message", (data, binary) => {
      try { this.receive(data, binary); }
      catch { this.emit("error", controlFailure("Invalid, oversized or mismatched Remote Control envelope.", "REMOTE_CONTROL_PROTOCOL_ERROR")); this.terminate(); }
    });
    wire.on("error", () => this.emit("error", controlFailure("Remote Control connection failed.", "CONNECTION_FAILED")));
    wire.on("close", () => { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.cleanup(); this.emit("close"); } });
    this.ping = setInterval(() => {
      if (this.readyState === WebSocket.OPEN) this.envelope("ping", { state: "foreground", skip_history: true });
    }, 30000);
    this.ping.unref();
  }

  static async connect({ identity, token, enrollment, environmentId, sign, signal, timeoutMs = 10000, createWire = (url, options) => new WebSocket(url, options) }) {
    if (signal?.aborted) throw controlFailure("Remote Control connection cancelled.", "CANCELLED");
    const wire = createWire(CONTROL_URL, { headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": identity.accountId,
      originator: "codexteer", "User-Agent": REMOTE_CLIENT_INFO.user_agent, "x-codex-client-id": enrollment.clientId, "x-codex-protocol-version": "3", "x-codex-client-auth": "socket-refresh-v1" },
      perMessageDeflate: false, maxPayload: MAX_FRAME, followRedirects: false, handshakeTimeout: timeoutMs });
    wire.on("error", () => {});
    return new Promise((resolve, reject) => {
      let settled = false, challenged = false, proofSent = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); wire.off("message", message); wire.off("close", closed); wire.off("error", failed); };
      const stop = error => { if (settled) return; settled = true; cleanup(); wire.terminate(); reject(error); };
      const cancel = () => stop(controlFailure("Remote Control authentication cancelled.", "CANCELLED"));
      const failed = () => stop(controlFailure("Remote Control authentication connection failed.", "REMOTE_AUTH_CONNECTION_FAILED"));
      const closed = () => stop(controlFailure("Remote Control closed before authentication completed.", "REMOTE_AUTH_CONNECTION_FAILED"));
      const timer = setTimeout(() => stop(controlFailure("Remote Control authentication timed out.", "TIMEOUT")), timeoutMs);
      const message = async (bytes, binary) => {
        try {
          if (binary || bytes.length > MAX_FRAME) throw new Error();
          const value = JSON.parse(String(bytes));
          if (value.type === "device_key_authenticated") {
            if (!proofSent || value.clientId !== enrollment.clientId || settled) throw new Error();
            settled = true; cleanup();
            resolve(new RemoteControlSocket(wire, { enrollment, environmentId, signal }));
            return;
          }
          if (challenged || settled) throw new Error();
          challenged = true; connectionPayload(value, enrollment);
          const proof = verifyDeviceProof(await sign(value), value, enrollment);
          if (settled || signal?.aborted) return;
          proofSent = true; wire.send(JSON.stringify(proof), error => { if (error) failed(); });
        } catch (error) {
          const code = /^REMOTE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "REMOTE_AUTH_CHALLENGE_MISMATCH";
          const message = code === "REMOTE_AUTH_SIGNING_FAILED" && /^Device-key signing failed at (input|enrollment|addon|public-key|public-key-match|sign|verify|worker)( \([A-Z0-9_:-]+\))?\. No alternative key was used\.$/.test(error.message)
            ? error.message : "Remote Control device challenge or proof was rejected.";
          stop(controlFailure(message, code));
        }
      };
      wire.on("message", message); wire.once("close", closed); wire.once("error", failed);
      wire.once("unexpected-response", (_request, response) => {
        response.resume();
        stop(controlFailure(`Remote Control authentication HTTP ${response.statusCode}; no credential or connection fallback was attempted.`, response.statusCode === 400 ? "REMOTE_AUTH_UNSUPPORTED" : "REMOTE_AUTH_REJECTED"));
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  envelope(type, extra = {}, callback) {
    if (this.readyState !== WebSocket.OPEN) { callback?.(new Error("closed")); return; }
    this.wire.send(JSON.stringify({ type, client_id: this.enrollment.clientId, env_id: this.environmentId, stream_id: this.streamId,
      seq_id: this.sequence++, ...extra }), error => { if (error) this.terminate(); callback?.(error); });
  }

  send(text, callback) {
    if (Buffer.byteLength(text) > MAX_CONTROL_REQUEST) { callback?.(new Error("Remote Control request exceeds 64 KiB.")); return; }
    let message;
    try { message = JSON.parse(text); } catch { callback?.(new Error("invalid JSON")); return; }
    this.envelope("client_message", { skip_history: false, message }, callback);
  }

  receive(bytes, binary) {
    if (binary || bytes.length > MAX_FRAME) throw new Error();
    const value = JSON.parse(String(bytes));
    if (value.client_id !== this.enrollment.clientId) throw new Error();
    // Other streams of the same enrolled Desktop client are never exposed.
    if (value.stream_id !== this.streamId) return;
    if (value.env_id !== this.environmentId || !Number.isSafeInteger(value.seq_id) || value.seq_id < 0) throw new Error();
    if (value.type === "ack") return; // Transport acknowledgement is not RPC acceptance.
    if (!["server_message", "server_message_chunk", "pong"].includes(value.type)) throw new Error();
    if (this.lastServerSequence !== null && value.seq_id <= this.lastServerSequence) return;
    if (this.lastServerSequence !== null && value.seq_id !== this.lastServerSequence + 1) throw new Error();
    if (value.type === "pong") {
      if (value.status !== "active" || this.assembly) throw new Error();
      this.lastServerSequence = value.seq_id; return;
    }
    let message = value.message;
    if (value.type === "server_message_chunk") {
      if (!Number.isInteger(value.segment_count) || value.segment_count < 2 || value.segment_count > 1024
        || !Number.isInteger(value.segment_id) || !Number.isSafeInteger(value.message_size_bytes) || value.message_size_bytes < 1 || value.message_size_bytes > MAX_MESSAGE
        || typeof value.message_chunk_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.message_chunk_base64)) throw new Error();
      this.assembly ??= { sequence: value.seq_id, size: value.message_size_bytes, count: value.segment_count, chunks: [], bytes: 0 };
      const assembly = this.assembly;
      if (assembly.sequence !== value.seq_id || assembly.count !== value.segment_count || assembly.size !== value.message_size_bytes
        || value.segment_id !== assembly.chunks.length) throw new Error();
      const chunk = Buffer.from(value.message_chunk_base64, "base64");
      assembly.bytes += chunk.length;
      if (assembly.bytes > assembly.size) throw new Error();
      assembly.chunks.push(chunk);
      if (assembly.chunks.length !== assembly.count) return;
      if (assembly.bytes !== assembly.size) throw new Error();
      message = JSON.parse(Buffer.concat(assembly.chunks).toString("utf8")); this.assembly = null;
    } else if (this.assembly) throw new Error();
    if (!message || typeof message !== "object" || Array.isArray(message) || !["method", "result", "error"].some(field => Object.hasOwn(message, field))) throw new Error();
    this.lastServerSequence = value.seq_id;
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }

  pause() { this.wire.pause(); }
  resume() { this.wire.resume(); }
  cleanup() { clearInterval(this.ping); this.signal?.removeEventListener("abort", this.cancel); this.assembly = null; }
  close() {
    if (this.readyState !== WebSocket.OPEN) return;
    this.envelope("client_closed", {}, () => this.wire.close());
    if (this.readyState !== WebSocket.CLOSED) this.readyState = WebSocket.CLOSING;
    this.cleanup();
  }
  terminate() { this.cleanup(); this.wire.terminate(); }
}
