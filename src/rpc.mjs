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

export function connectSocket(socketPath, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => net.createConnection(socketPath),
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    // Keep an error listener even after connection so a peer reset never throws globally.
    socket.on("error", () => {});
    socket.once("error", () => reject(new RpcFailure("Could not connect to the shared App Server.")));
    socket.once("open", () => resolve(socket));
  });
}

export class RpcClient extends EventEmitter {
  constructor(socket, { timeoutMs = 8000 } = {}) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
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
      if (message.method) {
        this.emit(message.id == null ? "notification" : "serverRequest", message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new RpcFailure(`${request.method} was rejected by App Server.`, {
          code: "RPC_REJECTED", rpcCode: message.error.code,
        }));
      } else if (Object.hasOwn(message, "result")) request.resolve(message.result);
      else request.reject(new RpcFailure("App Server returned an invalid response.", {
        code: "PROTOCOL_ERROR", uncertain: request.mutation,
      }));
    });
    socket.on("close", () => this.rejectPending("App Server connection closed."));
    socket.on("error", () => this.rejectPending("App Server connection failed."));
  }

  static async connect(socketPath, options = {}) {
    const client = new RpcClient(await connectSocket(socketPath, options), options);
    try {
      client.initialization = await client.request("initialize", {
        clientInfo: { name: "codex_steer", title: "Codex Steer", version: VERSION },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method, params = {}, { mutation = false } = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RpcFailure("App Server is not connected."));
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

  rejectPending(message) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RpcFailure(message, { uncertain: request.mutation }));
    }
    this.pending.clear();
  }

  abort(message) {
    this.rejectPending(message);
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
