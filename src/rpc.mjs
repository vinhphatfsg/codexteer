import { EventEmitter } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { VERSION } from "./help.mjs";

export class RpcFailure extends Error {
  constructor(message, { code = "CONNECTION_FAILED", uncertain = false, rpcCode } = {}) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
    this.rpcCode = rpcCode;
  }
}

function connectionCode(error) {
  if (["EACCES", "EPERM"].includes(error?.code)) return "PERMISSION_DENIED";
  if (error?.code === "ETIMEDOUT") return "TIMEOUT";
  if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(error?.code)) return "CONNECTION_FAILED";
  return "PROTOCOL_ERROR";
}

export function connectSocket(socketPath, { timeoutMs = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RpcFailure("App Server connection cancelled.", { code: "CANCELLED" })); return; }
    const socket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => net.createConnection(socketPath),
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) { socket.terminate(); reject(error); }
      else resolve(socket);
    };
    const cancel = () => finish(new RpcFailure("App Server connection cancelled.", { code: "CANCELLED" }));
    const timer = setTimeout(() => finish(new RpcFailure("App Server connection timed out.", { code: "TIMEOUT" })), timeoutMs);
    // Keep an error listener even after connection so a peer reset never throws globally.
    socket.on("error", () => {});
    socket.once("error", error => finish(new RpcFailure("Could not connect to the shared App Server.", { code: connectionCode(error) })));
    socket.once("close", () => finish(new RpcFailure("App Server connection closed before initialization.")));
    socket.once("open", () => finish());
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export class RpcClient extends EventEmitter {
  constructor(socket, { timeoutMs = 8000 } = {}) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.failure = null;
    socket.on("message", (data, binary) => {
      let message;
      try {
        if (binary) throw new Error();
        message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        this.abort("App Server returned an invalid protocol message.");
        return;
      }
      this.emit("message", message);
      if (Object.hasOwn(message, "method")) {
        if (typeof message.method !== "string" || !message.method) {
          this.abort("App Server returned an invalid protocol method.");
          return;
        }
        this.emit(message.id == null ? "notification" : "serverRequest", message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error && typeof message.error === "object" && !Array.isArray(message.error)
        && Number.isSafeInteger(message.error.code) && !Object.hasOwn(message, "result")) {
        request.reject(new RpcFailure(`${request.method} was rejected by App Server.`, {
          code: "RPC_REJECTED", rpcCode: message.error.code,
        }));
      } else if (Object.hasOwn(message, "result") && message.error == null) request.resolve(message.result);
      else {
        request.reject(new RpcFailure("App Server returned an invalid response.", { code: "PROTOCOL_ERROR", uncertain: request.mutation }));
        this.abort("App Server returned an invalid response.");
      }
    });
    socket.on("close", () => this.rejectPending("App Server connection closed."));
    socket.on("error", error => this.abort("App Server connection failed.", connectionCode(error)));
  }

  static async connect(socketPath, options = {}) {
    const client = new RpcClient(await connectSocket(socketPath, options), options);
    const cancel = () => client.abort("App Server initialization cancelled.", "CANCELLED");
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (options.signal?.aborted) cancel();
      client.initialization = await client.request("initialize", {
        clientInfo: { name: "codexteer", title: "Codexteer", version: VERSION },
        capabilities: { experimentalApi: true },
      });
      if (!client.initialization || typeof client.initialization !== "object" || Array.isArray(client.initialization)) {
        throw new RpcFailure("App Server returned invalid initialization data.", { code: "PROTOCOL_ERROR" });
      }
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    } finally { options.signal?.removeEventListener("abort", cancel); }
  }

  request(method, params = {}, { mutation = false } = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RpcFailure(this.failure?.message ?? "App Server is not connected.", { code: this.failure?.code }));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure(`${method} timed out.`, { code: "TIMEOUT", uncertain: mutation }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, mutation });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.rejectPending("App Server connection failed.");
      });
    });
  }

  notify(method, params) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  rejectPending(message, code = "CONNECTION_FAILED") {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RpcFailure(this.failure?.message ?? message, { code: this.failure?.code ?? code, uncertain: request.mutation }));
    }
    this.pending.clear();
  }

  abort(message, code = "PROTOCOL_ERROR") {
    this.failure ??= { message, code };
    this.rejectPending(message, code);
    this.socket.terminate();
  }

  close() {
    this.rejectPending("App Server client closed.");
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
      const timer = setTimeout(() => this.socket.terminate(), 500);
      timer.unref();
      this.socket.once("close", () => clearTimeout(timer));
    } else if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}
