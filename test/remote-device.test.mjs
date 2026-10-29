import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, lstat, symlink } from "node:fs/promises";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { prepareDevice, enrollDevice, pairDevice, verifyDevice, readPairingCode, deviceIdentityInfo } from "../src/remote-device.mjs";
import { remoteClientInfo, REMOTE_CLIENT_INFO } from "../src/remote-client-info.mjs";
import { PassThrough, Readable } from "node:stream";
import { readDevice, deviceStore, saveDevice, dedicatedEnrollment } from "../src/remote-device-store.mjs";
import { enrollmentPayload, deviceIdentityHash, verifyEnrollmentProof, officialDeviceRequest, ENROLL_START, ENROLL_FINISH, PAIR_PATH } from "../src/remote-device-protocol.mjs";
import { stepUpLogin, validateStepUpToken } from "../src/remote-device-login.mjs";
import { deviceKey } from "../src/remote-device-key.mjs";
import { withTarget } from "../src/target.mjs";
import { remoteControlConnection } from "../src/remote-control.mjs";

const identity = { accountId: "workspace", accountUserId: "primary-user", authUserId: "auth-user" }, host = "remote-control:env_fixture";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const key = { keyId: "dk_osn_fixture", algorithm: "ecdsa_p256_sha256", protectionClass: "os_protected_nonextractable", publicKeySpkiDerBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
const fresh = patch => `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), pwd_auth_time: Date.now(), scope: "codex.remote_control.enroll", "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId, chatgpt_account_user_id: identity.accountUserId }, ...patch })).toString("base64url")}.fixture`;
const challenge = () => ({ purpose: "remote_control_client_enrollment", audience: "remote_control_client_enrollment", account_user_id: identity.authUserId,
  client_id: "our-client", target_origin: "https://chatgpt.com", target_path: `/backend-api${ENROLL_FINISH}`, nonce: Buffer.alloc(32, 1).toString("base64url"),
  challenge_id: "challenge", challenge_token: "opaque-challenge-token", challenge_expires_at: new Date(Date.now() + 300000).toISOString() });
function proof(ch, enrolled) {
  const bytes = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: enrollmentPayload(ch, enrolled, ENROLL_FINISH) }));
  return { challenge_token: ch.challenge_token, key_id: key.keyId, algorithm: key.algorithm, signature_der_base64: sign("sha256", bytes, privateKey).toString("base64"), signed_payload_base64: bytes.toString("base64") };
}
async function fixture(t, options = {}) {
  const home = await mkdtemp("/private/tmp/codexteer-device-test-"); t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [], operations = [], ch = challenge();
  const context = { home, identity, current: async () => ({ identity, token: "bearer-secret" }), async request(route, params) {
    calls.push({ route, params });
    if (route === ENROLL_START) return { client_id: "our-client", account_user_id: identity.authUserId, device_key_challenge: ch };
    if (route === ENROLL_FINISH) {
      if (options.lostFinish) throw Object.assign(new Error("lost"), { code: "REMOTE_ENROLLMENT_UNKNOWN" });
      return { client_id: "our-client", account_user_id: identity.authUserId, remote_control_token: "remote-token-secret", expires_at: new Date(Date.now() + 600000).toISOString(), scopes: ["remote_control_controller_websocket"] };
    }
    if (route === PAIR_PATH) {
      if (options.lostPair) throw Object.assign(new Error("lost"), { code: "REMOTE_ENROLLMENT_UNKNOWN" });
      return { environment_id: options.wrongHost ? "env_wrong" : "env_fixture" };
    }
    if (params.method === "GET") return { items: [{ env_id: "env_fixture" }], cursor: null };
    assert.fail("unexpected endpoint");
  } };
  const keyOperation = async (operation, input) => { operations.push(operation); if (operation === "create") return key;
    if (operation === "enrollment-proof") return proof(input.challenge, input.enrollment); };
  return { context, calls, operations, keyOperation, login: async () => fresh() };
}

test("dedicated key preparation and official enrollment reuse one key and persist no bearer, OAuth or proof secrets", async t => {
  const f = await fixture(t); await prepareDevice(f.context, { key: f.keyOperation });
  await prepareDevice(f.context, { key: f.keyOperation });
  assert.equal(f.operations.filter(x => x === "create").length, 1); assert.equal(f.calls.length, 0);
  const result = await enrollDevice(f.context, { key: f.keyOperation, login: f.login });
  assert.equal(result.registration_status, "enrolled"); assert.equal(result.instruction_sent, false);
  assert.equal(f.operations.filter(x => x === "create").length, 1);
  assert.deepEqual(f.calls.map(c => c.route), [ENROLL_START, ENROLL_FINISH]);
  const record = await readDevice(f.context.home, identity), { file } = await deviceStore(f.context.home, identity);
  assert.equal(dedicatedEnrollment(record, identity).accountUserId, identity.authUserId);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const disk = await readFile(file, "utf8");
  for (const secret of ["bearer-secret", "remote-token-secret", "opaque-challenge-token", fresh(), "step_up_token", "signature_der_base64", "privateKey"]) assert(!disk.includes(secret));
  await enrollDevice(f.context, { key: () => assert.fail("do not create again"), login: () => assert.fail("do not authenticate again") });
});

test("fresh official enrollment scope, account and password time are mandatory before registration", async t => {
  for (const patch of [{ scope: "openid" }, { pwd_auth_time: Date.now() - 400000 }, { iat: 1 }, { exp: 1 }, { "https://api.openai.com/auth": { chatgpt_account_user_id: "other" } }]) {
    assert.throws(() => validateStepUpToken(fresh(patch), identity), { code: "REMOTE_STEP_UP_REQUIRED" });
  }
  const f = await fixture(t);
  await assert.rejects(enrollDevice(f.context, { key: f.keyOperation, login: async () => fresh({ scope: "openid" }) }), { code: "REMOTE_STEP_UP_REQUIRED" });
  assert.equal(f.calls.length, 0); assert.equal(f.operations.length, 0); assert.equal(await readDevice(f.context.home, identity), null);
});

test("enrollment signs canonical public identity and rejects substituted key, account, destination, scope and expiry", () => {
  const enrolled = { ...key, clientId: "our-client", accountUserId: identity.authUserId }, ch = challenge();
  assert.equal(enrollmentPayload(ch, enrolled, ENROLL_FINISH).deviceIdentitySha256Base64url, deviceIdentityHash(key));
  verifyEnrollmentProof(proof(ch, enrolled), ch, enrolled);
  for (const patch of [{ target_origin: "https://example.com" }, { target_path: "/backend-api/other" }, { client_id: "other" }, { account_user_id: "other" },
    { purpose: "remote_control_client_websocket" }, { device_identity_hash: "other" }, { challenge_expires_at: 1 }]) {
    assert.throws(() => enrollmentPayload({ ...ch, ...patch }, enrolled, ENROLL_FINISH), { code: "REMOTE_ENROLLMENT_CHALLENGE_INVALID" });
  }
  assert.throws(() => verifyEnrollmentProof({ ...proof(ch, enrolled), signed_payload_base64: "wrong" }, ch, enrolled), { code: "REMOTE_AUTH_PROOF_INVALID" });
});

test("lost enrollment acknowledgement preserves the same client and never re-registers", async t => {
  const f = await fixture(t, { lostFinish: true });
  await assert.rejects(enrollDevice(f.context, { key: f.keyOperation, login: f.login }), { code: "REMOTE_ENROLLMENT_UNKNOWN" });
  assert.equal((await readDevice(f.context.home, identity)).phase, "finish-unknown");
  await assert.rejects(enrollDevice(f.context, { key: f.keyOperation, login: f.login }), { code: "REMOTE_ENROLLMENT_PENDING" });
  assert.equal(f.calls.filter(c => c.route === ENROLL_START).length, 1); assert.equal(f.operations.filter(x => x === "create").length, 1);
  let authOnlyClosed = 0;
  await verifyDevice(f.context, { key: f.keyOperation, open: async () => ({ terminate() { authOnlyClosed++; } }) });
  assert.equal(authOnlyClosed, 1); assert.equal((await readDevice(f.context.home, identity)).phase, "enrolled");
});

test("pairing codes are transient, host acknowledgements are pinned and unknown attempts are reconciled", async t => {
  const f = await fixture(t, { lostPair: true }); await enrollDevice(f.context, { key: f.keyOperation, login: f.login });
  await assert.rejects(pairDevice(f.context, host, "ABCD-EFGH"), { code: "REMOTE_ENROLLMENT_UNKNOWN" });
  await assert.rejects(pairDevice(f.context, host, "ABCD-EFGH"), { code: "REMOTE_PAIR_UNKNOWN" });
  assert.equal(f.calls.filter(c => c.route === PAIR_PATH).length, 1);
  const { file } = await deviceStore(f.context.home, identity); assert(!(await readFile(file, "utf8")).includes("ABCD-EFGH"));
  const result = await verifyDevice(f.context, { key: f.keyOperation, open: async () => ({ terminate() {} }) });
  assert.deepEqual(result.paired_host_ids, [host]); assert.equal(result.pairing_unknown, false);
  const g = await fixture(t, { wrongHost: true }); await enrollDevice(g.context, { key: g.keyOperation, login: g.login });
  await assert.rejects(pairDevice(g.context, host, "ABCD-EFGH"), { code: "REMOTE_PAIR_HOST_MISMATCH" });
  assert(!(await readDevice(g.context.home, identity)).pairings.some(pair => pair.host_id === host));
});

test("dedicated profile selection does not adopt Desktop registrations or another account or host", async t => {
  const f = await fixture(t); await enrollDevice(f.context, { key: f.keyOperation, login: f.login });
  const record = await readDevice(f.context.home, identity); assert.equal(await readDevice(f.context.home, { ...identity, accountId: "other" }), null);
  const { file } = await deviceStore(f.context.home, identity); const saved = await readFile(file);
  await rm(file); await symlink("/private/tmp/not-a-device-record", file);
  await assert.rejects(readDevice(f.context.home, identity), { code: "REMOTE_DEVICE_STORE_UNSAFE" });
  await rm(file); await saveDevice(f.context.home, identity, record); assert(saved.length > 0);
  let sockets = 0;
  const adapter = remoteControlConnection({ hostId: host, transport: "paired" }, {
    discover: async () => ({ paths: { home: f.context.home, socket: "fixture" }, state: { instance: "fixture", codex_steer_protocol: 1, codex_steer_capabilities: { thread_read: [1] } } }),
    inspectCommand: async () => ({}), connect: async () => ({ request: async () => ({ authMethod: "chatgpt", authToken: fresh({ "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId, chatgpt_account_user_id: identity.accountUserId, user_id: identity.authUserId } }) }), close() {} }),
    open: async () => { sockets++; assert.fail("no socket before host pairing"); },
  });
  await adapter.discover(); await assert.rejects(adapter.connect("fixture"), { code: "REMOTE_PAIR_REQUIRED" }); assert.equal(sockets, 0);
});

test("fixed helper keeps key preparation input private and no bearer or private material leaves via argv", async () => {
  let file;
  const result = await deviceKey("create", {}, { run: async (exe, args, options) => {
    assert(exe.endsWith("/cua_node/bin/node")); assert(args[0].endsWith("/remote-device-worker.mjs")); file = args[1];
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { operation: "create" }); assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal(options.env.NODE_OPTIONS, ""); return { stdout: JSON.stringify({ ok: true, key }) };
  } });
  assert.deepEqual(result, key); await assert.rejects(lstat(file), { code: "ENOENT" });
});

test("official device HTTP requests pin TLS origin, reject redirects and never retry mutations", async () => {
  let calls = 0;
  const auth = { identity, token: "bearer-secret" };
  const response = await officialDeviceRequest(auth, ENROLL_START, { body: {}, fetch: async (url, options) => {
    calls++; assert.equal(url, `https://chatgpt.com/backend-api${ENROLL_START}`); assert.equal(options.redirect, "error");
    assert.equal(options.headers.originator, "codexteer"); assert.equal(options.headers.Authorization, "Bearer bearer-secret");
    assert.equal(options.headers["User-Agent"], REMOTE_CLIENT_INFO.user_agent); return new Response('{"client_id":"fixture"}');
  } }); assert.equal(response.client_id, "fixture");
  await assert.rejects(officialDeviceRequest(auth, "https://example.com", { fetch: () => assert.fail() }), { code: "REMOTE_DEVICE_ENDPOINT_INVALID" });
  await assert.rejects(officialDeviceRequest(auth, ENROLL_FINISH, { fetch: async () => { calls++; throw new Error("secret response"); } }), { code: "REMOTE_ENROLLMENT_UNKNOWN" });
  assert.equal(calls, 2);
});

test("controller metadata follows pages and exposes only the dedicated client, without claiming a server rename", async t => {
  const f = await fixture(t); await enrollDevice(f.context, { key: f.keyOperation, login: f.login });
  const routes = [];
  const context = { ...f.context, request: async (route, options) => {
    routes.push(route); assert.equal(options.method, "GET");
    return routes.length === 1 ? { items: [{ client_id: "unrelated-client", display_name: "private-other-name" }], cursor: "next page" }
      : { items: [{ client_id: "our-client", display_name: "Mac OS X", platform: "macos", device_model: "Mac", account_user_id: "private-account", last_seen_city: "private-location" }], cursor: null };
  } };
  const result = await deviceIdentityInfo(context), text = JSON.stringify(result);
  assert.equal(result.controller_name, REMOTE_CLIENT_INFO.controller_name);
  assert.equal(result.server_display_name, "Mac OS X"); assert.equal(result.name_matches, false);
  assert.equal(result.custom_name_update, "unsupported"); assert.equal(result.instruction_sent, false);
  assert.equal(routes[1], "/wham/remote/control/clients?limit=100&cursor=next%20page");
  for (const secret of ["private-other-name", "unrelated-client", "private-account", "private-location"]) assert(!text.includes(secret));
  await assert.rejects(deviceIdentityInfo({ ...f.context, request: async () => ({ items: [], cursor: "same" }) }), { code: "REMOTE_DEVICE_METADATA_INVALID" });
  await assert.rejects(deviceIdentityInfo({ ...f.context, request: async () => ({ items: [], cursor: null }) }), { code: "REMOTE_DEVICE_METADATA_NOT_FOUND" });
  for (const route of ["/wham/remote/control/clients?limit=100", "/wham/remote/control/clients?limit=100&cursor=next%20page"]) {
    await officialDeviceRequest({ identity, token: "fixture" }, route, { method: "GET", fetch: async () => new Response('{"items":[]}') });
    await assert.rejects(officialDeviceRequest({ identity, token: "fixture" }, route, { method: "PATCH", fetch: () => assert.fail("no guessed rename API") }), { code: "REMOTE_DEVICE_ENDPOINT_INVALID" });
  }
});

test("controller identity reports actual OS/architecture and tolerates unavailable OS version information", () => {
  const info = remoteClientInfo({ platform: "darwin", arch: "arm64", systemVersion: () => "26.5.2" });
  assert.equal(info.controller_name, "codexteer_mac_os_arm64"); assert.match(info.user_agent, /^codexteer\/[\d.]+ \(Macintosh; Mac OS X 26_5_2; arm64\)$/);
  assert(!info.user_agent.includes("Desktop"));
  for (const systemVersion of [() => "26.0\r\nInjected: header", () => { throw Error(); }]) {
    assert(!/[\r\n]/.test(remoteClientInfo({ platform: "darwin", arch: "arm64", systemVersion }).user_agent));
  }
  assert.equal(remoteClientInfo({ platform: "linux", arch: "x64", systemVersion: () => assert.fail() }).controller_name, "codexteer_linux_x64");
});

test("official browser OAuth uses PKCE, checks callback state and exchanges the code only in memory", { skip: process.platform !== "darwin" }, async () => {
  let tokenCalls = 0;
  const token = await stepUpLogin(identity, { ports: [0], timeoutMs: 3000, openBrowser: async address => {
    const url = new URL(address), redirect = new URL(url.searchParams.get("redirect_uri"));
    assert.equal(url.origin, "https://auth.openai.com"); assert.equal(url.searchParams.get("scope"), "codex.remote_control.enroll");
    const bad = new URL(redirect); bad.search = new URLSearchParams({ state: "wrong", code: "do-not-exchange" }); assert.equal((await fetch(bad)).status, 400);
    redirect.search = new URLSearchParams({ state: url.searchParams.get("state"), code: "authorization-code" }); assert.equal((await fetch(redirect)).status, 200);
  }, fetch: async (url, options) => {
    tokenCalls++; assert.equal(url, "https://auth.openai.com/oauth/token"); assert.equal(options.redirect, "error");
    const body = new URLSearchParams(options.body); assert.equal(body.get("code"), "authorization-code"); assert.equal(body.get("code_verifier").length, 43);
    return new Response(JSON.stringify({ access_token: fresh() }));
  } });
  assert.equal(tokenCalls, 1); validateStepUpToken(token, identity);
});

test("pairing code input is bounded and terminal input restores raw mode on completion and cancellation", async () => {
  assert.equal(await readPairingCode(Readable.from(["ABCD-EFGH\n"])), "ABCD-EFGH");
  await assert.rejects(readPairingCode(Readable.from(["x".repeat(257)])), { code: "REMOTE_PAIR_INPUT_INVALID" });
  for (const cancelled of [false, true]) {
    const input = new PassThrough(), modes = []; input.isTTY = true; input.setRawMode = value => modes.push(value);
    const result = readPairingCode(input);
    input.write(cancelled ? "\u0003" : "ABCD-EFGH\r");
    if (cancelled) await assert.rejects(result, { code: "REMOTE_PAIR_INPUT_INVALID" }); else assert.equal(await result, "ABCD-EFGH");
    assert.deepEqual(modes, [true, false]);
  }
});

test("browser timeout does not exchange a token and leaves callback ports reusable", async () => {
  await assert.rejects(stepUpLogin(identity, { ports: [0], timeoutMs: 20, openBrowser: async () => {}, fetch: () => assert.fail("no code was received") }), { code: "REMOTE_STEP_UP_REQUIRED" });
});

test("browser launch errors do not expose OAuth state or PKCE parameters", async () => {
  await assert.rejects(stepUpLogin(identity, { ports: [0], openBrowser: async url => { throw new Error(url); } }), error => error.code === "REMOTE_BROWSER_OPEN_FAILED" && !error.message.includes("state=") && !error.message.includes("code_challenge="));
});

test("keychain provider is explicit, pinned and cannot silently replace an already prepared key", async t => {
  const f = await fixture(t);
  const runtime = { source: "a".repeat(64), sha256: "b".repeat(64) };
  await prepareDevice(f.context, { provider: "keychain", prepare: async () => runtime, key: async (operation, input) => {
    assert.equal(operation, "create"); assert.equal(input.provider, "keychain"); assert.equal(input.runtime, runtime); assert.match(input.keyId, /^codexteer_[a-f0-9-]{36}$/); return key;
  } });
  const saved = await readDevice(f.context.home, identity); assert.equal(saved.key_provider, "keychain"); assert.deepEqual(saved.key_runtime, runtime);
  await assert.rejects(prepareDevice(f.context, { provider: "openai-native", key: () => assert.fail("must not switch") }), { code: "REMOTE_KEY_PROVIDER_MISMATCH" });
});

test("paired CLI prompts pin their distinct transport and cannot manage credentials from a supervisor", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", link = `codex://threads/${id}?hostId=${encodeURIComponent(host)}`;
  const run = args => JSON.parse(spawnSync(process.execPath, ["bin/codexteer.mjs", ...args, "--json"], { encoding: "utf8" }).stdout);
  const prompt = run(["--remote-transport", "paired", "supervise", "prompt", link, "--use-path-cli"]);
  assert.equal(prompt.ok, true); assert(prompt.data.prompt.includes("--remote-transport paired")); assert(!prompt.data.prompt.includes("--remote-transport control"));
  assert.equal(run(["--supervisor", id, "remote", "enroll"]).error.code, "SUPERVISOR_MISMATCH");
});
