import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, lstat, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { RemoteControlSocket } from "../src/remote-control-socket.mjs";
import { REMOTE_CLIENT_INFO } from "../src/remote-client-info.mjs";
import { CONTROL_URL, CONTROL_SCOPE, authIdentity, connectionPayload, readEnrollment, verifyDeviceProof, signConnectionChallenge, inspectConnectionKey } from "../src/remote-control-auth.mjs";
import { remoteControlConnection, validateControlRequest } from "../src/remote-control.mjs";
import { withTarget } from "../src/target.mjs";
import { readSnapshot, observeThread, decodeCursor } from "../src/observe.mjs";
import { sendAppServerMessage } from "../src/app-server.mjs";
import { appServerDoctor } from "../src/launcher.mjs";
import { BUNDLED_NODE } from "../src/wrapper.mjs";
import { registerSupervisor, controlSupervisor, assertSupervisor } from "../src/supervision.mjs";
import { createFinding } from "../src/findings.mjs";
import { sendTrackedMessage, reconcileMessages } from "../src/journal.mjs";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", HOST = "remote-control:env_fixture", SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const LINK = `codex://threads/${ID}?hostId=${encodeURIComponent(HOST)}`;
const identity = { accountId: "account-fixture", accountUserId: "user-fixture" };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const enrollment = { ...identity, clientId: "enrolled-client", keyId: "device-key", algorithm: "ecdsa_p256_sha256", protectionClass: "hardware_secure_enclave", publicKeySpkiDerBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
const challenge = () => ({ type: "device_key_challenge", purpose: "remote_control_client_websocket", audience: "remote_control_client_websocket", targetOrigin: "https://chatgpt.com", targetPath: new URL(CONTROL_URL).pathname,
  accountUserId: identity.accountUserId, clientId: enrollment.clientId, nonce: Buffer.alloc(32, 1).toString("base64url"), tokenSha256Base64url: Buffer.alloc(32, 2).toString("base64url"),
  sessionId: "socket-session", tokenExpiresAt: Math.floor(Date.now() / 1000) + 300, scopes: [CONTROL_SCOPE] });
function proof(value) { const bytes = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: connectionPayload(value, enrollment) })); return {
  type: "device_key_proof", keyId: enrollment.keyId, algorithm: enrollment.algorithm, signedPayloadBase64: bytes.toString("base64"), signatureDerBase64: cryptoSign("sha256", bytes, privateKey).toString("base64"),
}; }
const token = () => `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId, chatgpt_account_user_id: identity.accountUserId } })).toString("base64url")}.fixture`;
const scope = fn => withTarget(HOST, undefined, fn, { transport: "control" });
const task = () => ({ id: ID, status: { type: "active", activeFlags: [] }, turns: [{ id: "turn-one", status: "inProgress", items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "fixture goal" }] }] }] });
async function temp(t) { const home = await mkdtemp("/private/tmp/ct-control-"); t.after(() => rm(home, { recursive: true, force: true })); return home; }

class Wire extends EventEmitter {
  constructor(handle, authChallenge = challenge()) { super(); this.handle = handle; this.sent = []; this.closed = false; this.serverSeq = 0; setImmediate(() => this.inject(authChallenge)); }
  inject(value) { if (!this.closed) this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  send(text, callback) {
    const value = JSON.parse(text); this.sent.push(value); callback?.();
    if (value.type === "device_key_proof") return setImmediate(() => this.inject({ type: "device_key_authenticated", clientId: enrollment.clientId }));
    if (value.type === "client_message") this.handle(value, this);
  }
  response(envelope, message) { this.inject({ type: "server_message", client_id: enrollment.clientId, env_id: "env_fixture", stream_id: envelope.stream_id, seq_id: this.serverSeq++, message }); }
  terminate() { if (this.closed) return; this.closed = true; this.emit("close"); }
  close() { this.terminate(); }
  pause() {}
  resume() {}
}

async function fixture(t, options = {}) {
  const home = await temp(t), thread = task(), methods = [], wires = [], auth = { authMethod: "chatgpt", authToken: token() };
  const paths = { socket: "fixture", lease: home, home }, state = { instance: "runtime", node_path: BUNDLED_NODE, node_version: "v24.22.1", cli_version: "fixture" };
  const route = remoteControlConnection({ hostId: HOST, transport: options.transport ?? "control" }, {
    discover: async () => ({ paths, state }), inspectCommand: async () => ({ source: "fixture-schema", remote_control_methods: ["remoteControl/status/read"] }), enrollment: async () => enrollment, sign: async (_local, _home, _identity, _enrolled, value) => proof(value),
    inspectKey: async () => { if (options.keyFailure) throw options.keyFailure; },
    inspectIdentities: async () => ({ source: "fixture", different_keychain_identity: true }),
    connect: async () => ({ request: async method => { assert.equal(method, "getAuthStatus"); return auth; }, close() {} }),
    open: async params => RemoteControlSocket.connect({ ...params, createWire(url, wsOptions) {
      assert.equal(url, CONTROL_URL); assert.equal(wsOptions.followRedirects, false); assert.equal(wsOptions.headers["x-codex-protocol-version"], "3");
      assert.equal(wsOptions.headers["User-Agent"], REMOTE_CLIENT_INFO.user_agent);
      const wire = new Wire((envelope, wire) => {
        const { method, params, id } = envelope.message; methods.push({ method, params });
        if (method === "initialized") return;
        if (method === "initialize") return wire.response(envelope, { id, result: { userAgent: "codex-cli/fixture" } });
        if (method === "thread/read") return wire.response(envelope, { id, result: { thread: structuredClone(thread) } });
        if (method === "thread/loaded/list") return wire.response(envelope, { id, result: { data: [ID] } });
        if (method === "turn/steer") {
          options.beforeSteer?.(thread);
          if (params.expectedTurnId !== thread.turns.at(-1).id || thread.status.type !== "active") return wire.response(envelope, { id, error: { code: -32000, message: "turn mismatch" } });
          thread.turns.at(-1).items.push({ id: "delivered", clientId: params.clientUserMessageId, type: "userMessage", content: params.input });
          if (options.dropReceipt) {
            wire.inject({ type: "ack", client_id: enrollment.clientId, env_id: "env_fixture", stream_id: envelope.stream_id, seq_id: envelope.seq_id });
            return wire.terminate();
          }
          return wire.response(envelope, { id, result: { turnId: params.expectedTurnId } });
        }
        assert.fail(`unexpected method ${method}`);
      }); wires.push(wire); return wire;
    } }),
  });
  return { home, thread, methods, wires, auth, route };
}

function cli(args, home) { const p = spawnSync(process.execPath, ["bin/codexteer.mjs", "--json", ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: "" } }); return { status: p.status, ...JSON.parse(p.stdout) }; }

test("socket authentication validates account, target, scope, expiry and enrolled proof without creating a key", async () => {
  assert.deepEqual(authIdentity({ authMethod: "chatgpt", authToken: token() }), identity);
  assert.throws(() => authIdentity({ authMethod: "apiKey", authToken: "secret" }), { code: "REMOTE_AUTH_UNAVAILABLE" });
  for (const patch of [{ accountUserId: "another" }, { clientId: "another" }, { purpose: CONTROL_SCOPE }, { audience: CONTROL_SCOPE }, { targetOrigin: "https://other.invalid" }, { targetPath: "/other" }, { scopes: ["admin"] }, { tokenExpiresAt: 1 }, { nonce: "short" }]) {
    assert.throws(() => connectionPayload({ ...challenge(), ...patch }, enrollment), { code: "REMOTE_AUTH_CHALLENGE_MISMATCH" });
  }
  const value = challenge(); assert.equal(verifyDeviceProof(proof(value), value, enrollment).keyId, enrollment.keyId);
  assert.throws(() => verifyDeviceProof({ ...proof(value), signedPayloadBase64: "tampered" }, value, enrollment), { code: "REMOTE_AUTH_PROOF_INVALID" });
  const wire = new Wire(() => {}, { ...value, targetOrigin: "https://other.invalid" });
  await assert.rejects(RemoteControlSocket.connect({ identity, token: "fixture", enrollment, environmentId: "env_fixture", sign: () => assert.fail("must not sign"), createWire: () => wire }), { code: "REMOTE_AUTH_CHALLENGE_MISMATCH" });
  assert.equal(wire.sent.length, 0);
});

test("enrollment selection uses the exact existing Desktop account registration", async t => {
  const home = await temp(t), key = ["Codex Desktop", "http://localhost:8000/api", "https://chatgpt.com/backend-api", "after-first-unlock-device-key-v1", identity.accountUserId].join("\n");
  await writeFile(`${home}/.codex-global-state.json`, JSON.stringify({ "electron-remote-control-client-enrollments": { [key]: enrollment } }), { mode: 0o600 });
  const value = await readEnrollment(home, identity); assert.equal(value.keyId, enrollment.keyId);
  await assert.rejects(readEnrollment(home, { ...identity, accountUserId: "other" }), { code: "REMOTE_ENROLLMENT_REQUIRED" });
  const aliasIdentity = { ...identity, accountUserId: "account-user-alias", authUserId: identity.accountUserId };
  assert.equal((await readEnrollment(home, aliasIdentity)).clientId, enrollment.clientId);
  const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId,
    chatgpt_account_user_id: aliasIdentity.accountUserId, user_id: aliasIdentity.authUserId } })).toString("base64url")}.fixture`;
  assert.deepEqual(authIdentity({ authMethod: "chatgpt", authToken: jwt }), aliasIdentity);
  await assert.rejects(readEnrollment(home, { ...aliasIdentity, authUserId: "unrelated" }), { code: "REMOTE_ENROLLMENT_REQUIRED" });
});

test("device proof bytes use Desktop's canonical field order, not challenge construction order", () => {
  const value = challenge();
  const canonical = { accountUserId: value.accountUserId, audience: value.audience, clientId: value.clientId, nonce: value.nonce,
    scopes: ["remote_control_controller_websocket"], sessionId: value.sessionId, targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client", tokenExpiresAt: value.tokenExpiresAt,
    tokenSha256Base64url: value.tokenSha256Base64url, type: "remoteControlClientConnection" };
  assert.equal(JSON.stringify(connectionPayload(value, enrollment)), JSON.stringify(canonical));
  const bytes = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: canonical }));
  const signed = { type: "device_key_proof", keyId: enrollment.keyId, algorithm: enrollment.algorithm,
    signedPayloadBase64: bytes.toString("base64"), signatureDerBase64: cryptoSign("sha256", bytes, privateKey).toString("base64") };
  assert.equal(verifyDeviceProof(signed, value, enrollment), signed);
});

test("unavailable OS key stops before proof or RPC and helper input is private and token-free", async () => {
  let file, calls = 0;
  const value = challenge(), local = { async request(method, params) {
    calls++; assert.equal(method, "command/exec"); assert.equal(params.command[0], BUNDLED_NODE);
    assert.match(params.command[1], /\/remote-key-worker\.mjs$/);
    assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    file = params.command[2]; assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const input = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(input.challenge, value); assert.deepEqual(input.identity, identity);
    assert.equal(input.operation, "sign");
    assert.deepEqual(Object.keys(input).sort(), ["challenge", "enrollmentHash", "home", "identity", "operation"]);
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, stage: "public-key", native_code: "KEYCHAIN_UNAVAILABLE" }), stderr: "must not expose arbitrary native errors" };
  } };
  const wire = new Wire(() => assert.fail("no RPC before authentication"), value);
  await assert.rejects(RemoteControlSocket.connect({ identity, token: "fixture-token", enrollment, environmentId: "env_fixture",
    sign: ch => signConnectionChallenge(local, "/unused-fixture-home", identity, enrollment, ch), createWire: () => wire }),
  { code: "REMOTE_AUTH_SIGNING_FAILED", message: "Device-key signing failed at public-key (KEYCHAIN_UNAVAILABLE). No alternative key was used." });
  assert.equal(calls, 1); assert.equal(wire.sent.length, 0); assert.equal(wire.closed, true);
  await assert.rejects(access(file), { code: "ENOENT" });
});

test("public-key preflight never signs, accepts only an inspection receipt, and cleans its input", async () => {
  let file;
  const local = { async request(method, params) {
    assert.equal(method, "command/exec"); file = params.command[2];
    const input = JSON.parse(await readFile(file, "utf8"));
    assert.equal(input.operation, "inspect"); assert.equal(input.challenge, undefined);
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, operation: "inspect", device_key_access: "verified" }) };
  } };
  await inspectConnectionKey(local, "/unused", identity, enrollment);
  await assert.rejects(access(file), { code: "ENOENT" });
  await assert.rejects(inspectConnectionKey({ async request() {
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, operation: "inspect", device_key_access: "verified", proof: "unexpected" }) };
  } }, "/unused", identity, enrollment), { code: "REMOTE_AUTH_SIGNING_FAILED" });
});

test("unavailable enrolled key blocks before gateway token transmission and leaves uncalled RPCs unverified", async t => {
  const f = await fixture(t, { keyFailure: Object.assign(new Error("do not expose native error text"), { code: "REMOTE_AUTH_SIGNING_FAILED", key_stage: "public-key", key_error: "KEYCHAIN_UNAVAILABLE" }) });
  const report = await scope(() => appServerDoctor({ threadId: ID, versions: { desktop_version: "fixture", cli_version: "fixture" }, ...f.route }));
  assert.equal(report.ready, false); assert.equal(report.failure.code, "REMOTE_DEVICE_KEY_UNAVAILABLE");
  assert.equal(report.failure.method, "remote-control-auth");
  assert.equal(report.compatibility.api_checks.initialize, "unverified"); assert.equal(report.compatibility.api_checks["thread/read"], "unverified");
  assert.equal(report.remote_control_auth.gateway_attempted, false); assert.equal(report.remote_control_auth.proof_created, false);
  assert.equal(report.remote_control_auth.key_access.reason, "KEYCHAIN_UNAVAILABLE");
  assert.equal(report.remote_control_auth.keychain_identity.different_keychain_identity, true);
  assert.deepEqual(report.remote_control_auth.app_server_delegation.methods, ["remoteControl/status/read"]);
  assert.equal(f.wires.length, 0); assert.equal(f.methods.length, 0);
  assert.equal(JSON.stringify(report).includes("do not expose native"), false);
  await assert.rejects(scope(() => sendAppServerMessage(ID, "fixture only", f.route)), error => error.code === "REMOTE_DEVICE_KEY_UNAVAILABLE"
    && error.delivery_status === "not_sent" && error.sent === false && error.remote_control_auth.gateway_attempted === false);
  assert.equal(f.wires.length, 0); assert.equal(f.methods.length, 0);
});

test("local connection failure during preflight is not misreported as a missing device key", async t => {
  const f = await fixture(t, { keyFailure: Object.assign(new Error("local connection lost"), { code: "CONNECTION_FAILED" }) });
  const report = await scope(() => appServerDoctor({ threadId: ID, versions: { desktop_version: "fixture", cli_version: "fixture" }, ...f.route }));
  assert.equal(report.failure.code, "CONNECTION_FAILED"); assert.equal(report.remote_control_auth, undefined);
  assert.equal(f.wires.length, 0); assert.equal(f.methods.length, 0);
});

test("control route reads and strictly steers the existing server turn with one client message ID", async t => {
  const f = await fixture(t);
  await scope(async () => {
    const observation = await observeThread(ID, {}, f.route);
    assert.equal(decodeCursor(observation.cursor, ID).remote_transport, "control");
    const sent = await sendAppServerMessage(ID, "fixture instruction", { ...f.route, clientMessageId: "client-message" });
    assert.equal(sent.delivery_status, "accepted"); assert.equal(sent.turn_id, "turn-one");
    const sends = f.methods.filter(x => x.method === "turn/steer"); assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].params, { threadId: ID, expectedTurnId: "turn-one", input: [{ type: "text", text: "fixture instruction" }], clientUserMessageId: "client-message" });
    assert.equal(sent.host_id, HOST); assert.equal(sent.remote_transport, "control");
  });
  assert(!f.methods.some(x => ["thread/resume", "turn/start"].includes(x.method)));
});

test("paired transport preserves strict server steering while binding cursors separately from Desktop control", async t => {
  const f = await fixture(t, { transport: "paired" });
  const observed = await withTarget(HOST, undefined, () => observeThread(ID, {}, f.route), { transport: "paired" });
  await scope(() => assert.throws(() => decodeCursor(observed.cursor, ID), { code: "STALE_CURSOR" }));
  const sent = await withTarget(HOST, undefined, () => sendAppServerMessage(ID, "fixture only", f.route), { transport: "paired" });
  assert.equal(sent.remote_transport, "paired"); assert.equal(sent.delivery_status, "accepted");
  assert.equal(f.methods.filter(call => call.method === "turn/steer").length, 1);
  assert.equal(f.methods.find(call => call.method === "turn/steer").params.expectedTurnId, "turn-one");
});

test("server turn replacement rejects rather than steering the replacement or starting a turn", async t => {
  const f = await fixture(t, { beforeSteer(thread) { thread.turns.push({ id: "replacement", status: "inProgress", items: [] }); } });
  await scope(() => assert.rejects(sendAppServerMessage(ID, "fixture", f.route), error => error.code === "RPC_REJECTED" && error.delivery_status === "not_sent"));
  assert.equal(f.methods.filter(x => x.method === "turn/steer").length, 1);
  assert.equal(f.thread.turns.at(-1).items.length, 0);
  assert.equal(f.wires.length, 1);
});

test("control doctor verifies the target read and separates existing-turn steering from new turns", async t => {
  const f = await fixture(t);
  const report = await scope(() => appServerDoctor({ threadId: ID, versions: { desktop_version: "fixture", cli_version: "fixture" }, ...f.route }));
  assert.equal(report.checks.observation, true); assert.equal(report.compatibility.status, "verified");
  assert.equal(report.runtime_compatibility.operations.send.status, "supported");
  assert.equal(report.runtime_compatibility.operations.send_new_turn.status, "unsupported");
  assert(!f.methods.some(x => x.method === "turn/steer"));
});

test("new user input after the reviewed control cursor rejects before any steering", async t => {
  const f = await fixture(t);
  await scope(async () => {
    const read = await observeThread(ID, {}, f.route);
    f.thread.turns[0].items.push({ type: "userMessage", id: "new-human", content: [{ type: "text", text: "changed goal" }] });
    await assert.rejects(sendTrackedMessage(ID, "fixture", { ...f.route, basedOn: read.cursor }, { home: f.home }), { code: "STALE_OBSERVATION" });
  });
  assert(!f.methods.some(x => x.method === "turn/steer"));
});

test("idle and new-turn paths do not send or resume remotely", async t => {
  const f = await fixture(t); f.thread.status.type = "idle"; f.thread.turns[0].status = "completed";
  await scope(async () => {
    await assert.rejects(sendAppServerMessage(ID, "fixture", f.route), /eligible active turn/);
    await assert.rejects(sendAppServerMessage(ID, "fixture", { ...f.route, newTurn: true }), { code: "REMOTE_NEW_TURN_UNSUPPORTED" });
  });
  assert(!f.methods.some(x => x.method.startsWith("turn/")));
});

test("lost mutation receipt stays unknown with no reconnect or envelope replay", async t => {
  const f = await fixture(t, { dropReceipt: true });
  await scope(() => assert.rejects(sendAppServerMessage(ID, "fixture", f.route), error => error.delivery_status === "unknown" && error.sent === null));
  assert.equal(f.methods.filter(x => x.method === "turn/steer").length, 1);
  assert.equal(f.wires.length, 1); assert.equal(f.thread.turns[0].items.length, 2);
});

test("account changes before dispatch stop every further remote request", async t => {
  const f = await fixture(t);
  await scope(async () => {
    const { paths } = await f.route.discover(); const client = await f.route.connect(paths.socket);
    f.auth.authToken = `fixture.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: "other", chatgpt_account_user_id: "other" } })).toString("base64url")}.fixture`;
    await assert.rejects(client.request("thread/read", { threadId: ID }), { code: "REMOTE_IDENTITY_CHANGED" }); client.close();
  });
  assert(!f.methods.some(x => x.method === "thread/read"));
});

test("native and control cursors and supervisor routes cannot be interchanged", async t => {
  const home = await temp(t);
  const cursor = await withTarget(HOST, undefined, async () => { await registerSupervisor(ID, SESSION, { home }); return readSnapshot(task()).cursor; });
  await scope(async () => {
    assert.throws(() => decodeCursor(cursor, ID), { code: "STALE_CURSOR" });
    await assert.rejects(assertSupervisor(ID, SESSION, { home }), { code: "SUPERVISOR_MISMATCH" });
  });
});

test("supervised remote sends retain freshness, pause/stop, dedup and persisted client-ID reconciliation", async t => {
  const f = await fixture(t);
  await scope(async () => {
    await registerSupervisor(ID, SESSION, { home: f.home });
    const read = await observeThread(ID, {}, f.route);
    const finding = await createFinding(ID, { home: f.home, key: "fixture", title: "fixture", condition: "fixture resolved", basedOn: read.cursor });
    const options = { ...f.route, supervisor: SESSION, connection: "shared", finding: finding.id, basedOn: read.cursor };
    await controlSupervisor(ID, "pause", { home: f.home });
    await assert.rejects(sendTrackedMessage(ID, "fixture", options, { home: f.home }), { code: "SUPERVISOR_PAUSED" });
    await controlSupervisor(ID, "resume", { home: f.home });
    const receipt = await sendTrackedMessage(ID, "fixture", options, { home: f.home });
    assert.equal(receipt.delivery_status, "accepted");
    const history = await reconcileMessages(ID, receipt.message_id, { home: f.home }, f.route);
    assert.equal(history[0].verification.status, "stored");
    await assert.rejects(sendTrackedMessage(ID, "fixture", options, { home: f.home }), { code: "DUPLICATE_INTERVENTION" });
    await controlSupervisor(ID, "stop", { home: f.home });
    await assert.rejects(sendTrackedMessage(ID, "fixture", options, { home: f.home }), { code: "SUPERVISOR_STOPPED" });
    assert.equal(f.methods.filter(x => x.method === "turn/steer").length, 1);
  });
});

test("CLI requires explicit control transport and generates route-bound steering prompts in saved and PATH modes", async t => {
  const home = await temp(t);
  for (const mode of [[], ["--use-path-cli"]]) {
    const value = cli(["--remote-transport", "control", "supervise", "prompt", LINK, ...mode], home);
    assert.equal(value.ok, true, JSON.stringify(value.error)); assert.equal(value.data.observation_only, false);
    assert.equal(value.data.remote_transport, "control"); assert(value.data.prompt.includes(` send ${ID}`));
    assert(value.data.prompt.includes("--remote-transport control")); assert(!value.data.prompt.includes("--context-thread '"));
  }
  assert.equal(cli(["send", LINK, "fixture", "--dry-run"], home).error.code, "REMOTE_READ_ONLY");
  const dry = cli(["--remote-transport", "control", "send", LINK, "fixture", "--dry-run", "--no-sound"], home);
  assert.equal(dry.ok, true); assert.equal(dry.data.sent, false);
  assert.equal(cli(["--remote-transport", "control", LINK, "fixture", "--dry-run", "--no-sound"], home).ok, true);
  assert.equal(cli(["--remote-transport", "control", "send", LINK, "fixture", "--new-turn", "--dry-run"], home).error.code, "REMOTE_NEW_TURN_UNSUPPORTED");
  assert.equal(cli(["--remote-transport", "control", "send", LINK, "fixture", "--backend", "ui", "--dry-run"], home).error.code, "REMOTE_READ_ONLY");
  assert.equal(cli(["--remote-transport", "control", "send", ID, "fixture", "--dry-run"], home).error.code, "REMOTE_HOST_REQUIRED");
  assert.throws(() => validateControlRequest("turn/steer", { input: [{ type: "text", text: "x".repeat(65536) }] }), { code: "REMOTE_REQUEST_TOO_LARGE" });
});

test("remote envelope decoding is stream/host bound and handles bounded paged payload chunks", () => {
  const wire = new Wire(() => {}), socket = new RemoteControlSocket(wire, { enrollment, environmentId: "env_fixture", streamId: "stream" });
  const received = []; socket.on("message", data => received.push(JSON.parse(String(data))));
  const bytes = Buffer.from(JSON.stringify({ id: "request", result: { text: "あ".repeat(100) } }));
  for (let i = 0; i < 2; i++) wire.inject({ type: "server_message_chunk", client_id: enrollment.clientId, env_id: "env_fixture", stream_id: "stream", seq_id: 0,
    segment_id: i, segment_count: 2, message_size_bytes: bytes.length, message_chunk_base64: bytes.subarray(i ? 100 : 0, i ? bytes.length : 100).toString("base64") });
  assert.equal(received.length, 1); assert.equal(received[0].result.text.length, 100);
  let failure; socket.on("error", error => { failure = error; });
  wire.inject({ type: "server_message", client_id: enrollment.clientId, env_id: "another", stream_id: "stream", seq_id: 1, message: { id: "x", result: {} } });
  assert.equal(failure.code, "REMOTE_CONTROL_PROTOCOL_ERROR"); assert.equal(wire.closed, true);
});
