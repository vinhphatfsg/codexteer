// Real bundled Rust App Server behind the Remote Control envelope adapter.
// Temporary profile + loopback fake model only; no account token or device key.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { RpcClient } from "../src/rpc.mjs";
import { BUNDLED_CLI } from "../src/wrapper.mjs";
import { RemoteControlSocket } from "../src/remote-control-socket.mjs";
import { sendAppServerMessage } from "../src/app-server.mjs";
import { readOnClient } from "../src/observe.mjs";
import { prepareDirective } from "../src/directive.mjs";
import { withTarget } from "../src/target.mjs";

const root = await mkdtemp("/private/tmp/ct-control-protocol-"), requests = new Map();
let child, client, turnId, threadId, nextId = 1, sequence = 0, diagnostic = "";
const provider = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Drain only the fake fixture request. */ }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "fixture-response" } })}\n\n`);
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Fixture RPC timeout: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
class Wire extends EventEmitter {
  send(text, callback) {
    callback?.(); const envelope = JSON.parse(text);
    if (envelope.type !== "client_message") return;
    const { id, method, params } = envelope.message;
    if (method === "initialized") return;
    const call = method === "initialize" ? Promise.resolve({ userAgent: "fixture-wrapper" }) : request(method, params);
    call.then(result => this.reply(envelope, { id, result }), error => this.reply(envelope, { id, error: { code: error.rpcCode ?? -32000, message: "fixture rejection" } }));
  }
  reply(envelope, message) { this.emit("message", Buffer.from(JSON.stringify({ type: "server_message", client_id: "fixture-client", env_id: "env_fixture", stream_id: envelope.stream_id, seq_id: sequence++, message })), false); }
  close() { this.emit("close"); }
  terminate() { this.close(); }
  pause() {}
  resume() {}
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await writeFile(`${root}/config.toml`, `model = "gpt-5.4"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = false\nplugins = false\nremote_plugin = false\napps = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  child = spawn(BUNDLED_CLI, ["app-server", "--listen", "stdio://"], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, RUST_LOG: "error" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes).slice(-2000); });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line), pending = requests.get(message.id);
    if (!pending || message.method) return;
    clearTimeout(pending.timer); requests.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error("Fixture server rejected request"), { rpcCode: message.error.code })); else pending.resolve(message.result);
  });
  await request("initialize", { clientInfo: { name: "codexteer_remote_probe", version: "0.16.0" }, capabilities: { experimentalApi: true } });
  const { thread } = await request("thread/start", { cwd: root, model: "gpt-5.4", approvalPolicy: "never", sandbox: "read-only" }); threadId = thread.id;
  const { turn } = await request("turn/start", { threadId, input: [{ type: "text", text: "fixture initial" }] }); turnId = turn.id;
  for (let retry = 0; retry < 100; retry++) {
    if ((await request("thread/read", { threadId, includeTurns: false })).thread.status.type === "active") break;
    await delay(50);
  }
  const wire = new Wire(), socket = new RemoteControlSocket(wire, { enrollment: { clientId: "fixture-client" }, environmentId: "env_fixture" });
  client = new RpcClient(socket);
  await client.request("initialize", { clientInfo: { name: "codexteer_remote_fixture", version: "0.16.0" }, capabilities: { experimentalApi: true } });
  const runtime = { paths: { home: root, lease: root, socket: "fixture" }, state: { codex_steer_protocol: 1, codex_steer_capabilities: { thread_read: [1], history_pagination: [1], turn_steer: [1], turn_start: [], desktop_subscribe: [] } } };
  await withTarget("remote-control:env_fixture", undefined, async () => {
    const read = await readOnClient(client, threadId);
    const directive = await prepareDirective(threadId, "fixture steering", { basedOn: read.cursor }, "fixture");
    const receipt = await sendAppServerMessage(threadId, directive.wireText, { discover: async () => runtime, connect: async () => client, beforeSend: directive.beforeSend });
    assert.equal(receipt.turn_id, turnId); assert.equal(receipt.delivery_status, "accepted");
  }, { transport: "control" });
  // sendAppServerMessage closes its own client; create a separate fresh adapter
  // for the stale-turn probe, never retrying a delivery or using another turn.
  const second = new RpcClient(new RemoteControlSocket(new Wire(), { enrollment: { clientId: "fixture-client" }, environmentId: "env_fixture" }));
  try {
    await second.request("initialize", { clientInfo: { name: "fixture" } });
    await assert.rejects(second.request("turn/steer", { threadId, expectedTurnId: "stale", input: [{ type: "text", text: "must reject" }], clientUserMessageId: randomUUID() }, { mutation: true }), { code: "RPC_REJECTED" });
  } finally { second.close(); }
  console.log(JSON.stringify({ suite: "remote-control-protocol", result: "PASS", real_bundled_app_server: true, server_expected_turn_rejection: true, active_turn_receipt: true, freshness_checks: true,
    remote_gateway_validated: false, account_credentials_used: false, device_keys_used: false }));
} catch (error) { console.error(error.message, diagnostic); process.exitCode = 1; }
finally {
  client?.close();
  if (child && child.exitCode === null) {
    if (threadId && turnId) await request("turn/interrupt", { threadId, turnId }).catch(() => {});
    const ended = once(child, "exit"); child.stdin.end(); const timer = setTimeout(() => child.kill("SIGTERM"), 1000); await ended; clearTimeout(timer);
  }
  for (const pending of requests.values()) clearTimeout(pending.timer);
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(root, { recursive: true, force: true });
}
