import { randomUUID } from "node:crypto";
import { discoverRuntime } from "./runtime.mjs";
import { RpcClient } from "./rpc.mjs";
import { authIdentity, controlFailure } from "./remote-control-auth.mjs";
import { RemoteControlSocket } from "./remote-control-socket.mjs";
import { deviceKey, dedicatedConnectionProof } from "./remote-device-key.mjs";
import { readDevice, saveDevice, withDeviceLock, dedicatedEnrollment, keySelection } from "./remote-device-store.mjs";
import { prepareKeychainRuntime, keychainOperation } from "./remote-keychain.mjs";
import { ENROLL_START, ENROLL_FINISH, PAIR_PATH, deviceIdentity, enrollmentPayload, validateRegistration, verifyEnrollmentProof, officialDeviceRequest } from "./remote-device-protocol.mjs";
import { stepUpLogin, validateStepUpToken } from "./remote-device-login.mjs";
import { REMOTE_CLIENT_INFO } from "./remote-client-info.mjs";

export async function withDeviceAccount(operation, { discover = discoverRuntime, connect = RpcClient.connect, request = officialDeviceRequest } = {}) {
  const runtime = await discover(), local = await connect(runtime.paths.socket);
  try {
    const identity = authIdentity(await local.request("getAuthStatus", { includeToken: true, refreshToken: false }));
    const current = async () => {
      const latest = await discover(runtime.paths.home), status = await local.request("getAuthStatus", { includeToken: true, refreshToken: false });
      if (latest.state.instance !== runtime.state.instance || latest.paths.socket !== runtime.paths.socket || JSON.stringify(authIdentity(status)) !== JSON.stringify(identity)) {
        throw controlFailure("The selected account or runtime changed. No device operation was sent to another account.", "REMOTE_IDENTITY_CHANGED");
      }
      return { identity, token: status.authToken };
    };
    return await operation({ home: runtime.paths.home, identity, current,
      request: async (route, options) => request(await current(), route, options) });
  } finally { local.close(); }
}

export function deviceStatus(record) {
  return { credential_source: "codexteer-dedicated", registration_status: record?.phase ?? "not_enrolled", client_id: record?.clientId ?? null,
    controller_name: REMOTE_CLIENT_INFO.controller_name,
    key_protection: record?.key?.protectionClass ?? null, key_provider: record?.key_provider ?? "openai-native", paired_host_ids: record?.pairings.map(pair => pair.host_id) ?? [],
    pairing_unknown: record?.pairing_unknown ?? false, instruction_sent: false };
}

// Read only our registered public metadata; never expose other controllers,
// account identities or last-seen location from the account-wide response.
export async function deviceIdentityInfo(context) {
  const record = await readDevice(context.home, context.identity);
  dedicatedEnrollment(record, context.identity);
  const seen = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await context.request(`/wham/remote/control/clients?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { method: "GET" });
    if (!Array.isArray(result?.items)) throw controlFailure("Invalid controller metadata response.", "REMOTE_DEVICE_METADATA_INVALID");
    const own = result.items.find(item => item?.client_id === record.clientId);
    if (own) {
      const text = key => typeof own[key] === "string" && own[key].length <= 512 ? own[key] : null;
      const display = text("display_name");
      return { ...deviceStatus(record), server_display_name: display, server_platform: text("platform"), server_device_model: text("device_model"),
        name_matches: display === REMOTE_CLIENT_INFO.controller_name, custom_name_update: "unsupported" };
    }
    if (result.cursor == null) throw controlFailure("Dedicated controller was not present in the account list.", "REMOTE_DEVICE_METADATA_NOT_FOUND");
    if (typeof result.cursor !== "string" || !result.cursor || result.cursor.length > 4096 || seen.has(result.cursor)) throw controlFailure("Invalid controller metadata pagination.", "REMOTE_DEVICE_METADATA_INVALID");
    seen.add(result.cursor); cursor = result.cursor;
  }
  throw controlFailure("Controller metadata exceeded its pagination limit.", "REMOTE_DEVICE_METADATA_INVALID");
}

export async function readPairingCode(input = process.stdin) {
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) { text += chunk.toString("utf8"); if (text.length > 256) throw controlFailure("Invalid pairing code input.", "REMOTE_PAIR_INPUT_INVALID"); }
    return text.trim();
  }
  return new Promise((resolve, reject) => {
    let text = "";
    const finish = (error, result) => { input.removeListener("data", data); input.removeListener("end", ended); input.removeListener("error", failed); input.setRawMode(false); input.pause(); error ? reject(error) : resolve(result); };
    const failed = () => finish(controlFailure("Pairing code input was cancelled.", "REMOTE_PAIR_INPUT_INVALID"));
    const ended = () => finish(null, text.trim());
    const data = chunk => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") return failed();
        if (["\n", "\r", "\u0004"].includes(char)) return ended();
        if (["\u007f", "\b"].includes(char)) text = text.slice(0, -1);
        else if (/^[A-Za-z0-9-]$/.test(char)) text += char;
        else return failed();
        if (text.length > 128) return failed();
      }
    };
    input.setRawMode(true); input.on("data", data); input.once("end", ended); input.once("error", failed); input.resume();
  });
}

export async function prepareDevice(context, { key = deviceKey, provider = "openai-native", prepare = prepareKeychainRuntime } = {}) {
  const { home, identity } = context;
  if (!["openai-native", "keychain"].includes(provider)) throw controlFailure("--key-provider must be openai-native or keychain.", "REMOTE_KEY_PROVIDER_INVALID");
  return withDeviceLock(home, identity, async () => {
    const existing = await readDevice(home, identity);
    if (existing && !(existing.phase === "key-failed" && !existing.key && !existing.clientId && existing.key_provider !== provider)) {
      if (!["prepared", "enrolled"].includes(existing.phase)) throw controlFailure("A dedicated key operation is unresolved. Inspect the saved phase before creating another key.", "REMOTE_ENROLLMENT_PENDING");
      if ((existing.key_provider ?? "openai-native") !== provider) throw controlFailure("The dedicated key already uses another provider. It was not replaced.", "REMOTE_KEY_PROVIDER_MISMATCH");
      await key("inspect", { enrollment: { ...existing.key, ...keySelection(existing) }, home, identity }); return deviceStatus(existing);
    }
    await context.current();
    const record = { schema: 1, accountId: identity.accountId, accountUserId: identity.accountUserId, phase: "creating-key",
      operation_id: randomUUID(), pairings: [], key_provider: provider, created_at: new Date().toISOString() };
    if (provider === "keychain") { record.key_runtime = await prepare(home, identity); record.candidate_key_id = `codexteer_${randomUUID()}`; }
    await saveDevice(home, identity, record);
    try { record.key = await key("create", { provider, home, identity, runtime: record.key_runtime, keyId: record.candidate_key_id }); }
    catch (error) { if (error.key_creation_rejected) { record.phase = "key-failed"; record.key_error = "MISSING_ENTITLEMENT"; await saveDevice(home, identity, record); } throw error; }
    record.phase = "prepared"; await saveDevice(home, identity, record);
    return deviceStatus(record);
  });
}

export async function recoverDeviceKey(context) {
  const { home, identity } = context;
  return withDeviceLock(home, identity, async () => {
    const record = await readDevice(home, identity);
    if (record?.phase !== "creating-key" || record.key_provider !== "keychain" || !record.candidate_key_id || record.clientId) throw controlFailure("No recoverable key-only preparation exists.", "REMOTE_ENROLLMENT_PENDING");
    record.key = await keychainOperation("recover", { home, identity, runtime: record.key_runtime, keyId: record.candidate_key_id });
    record.phase = "prepared"; await saveDevice(home, identity, record); return deviceStatus(record);
  });
}

export async function enrollDevice(context, { login = stepUpLogin, key = deviceKey, progress } = {}) {
  const { home, identity } = context;
  return withDeviceLock(home, identity, async () => {
    const existing = await readDevice(home, identity);
    if (existing?.phase === "enrolled") return deviceStatus(existing);
    if (existing && existing.phase !== "prepared") throw controlFailure("An unresolved registration already exists. Use remote verify; do not create another device automatically.", "REMOTE_ENROLLMENT_PENDING");
    // Authenticate before any key or server registration exists. Only the
    // official fresh enrollment token stays in this process's memory.
    const stepUp = validateStepUpToken(await login(identity, { progress }), identity);
    await context.current();
    let record = existing ? { ...existing, phase: "starting" } : { schema: 1, accountId: identity.accountId, accountUserId: identity.accountUserId, phase: "starting",
      operation_id: randomUUID(), pairings: [], created_at: new Date().toISOString() };
    await saveDevice(home, identity, record);
    const start = await context.request(ENROLL_START, { body: {} });
    if (typeof start?.client_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(start.client_id)
      || ![identity.accountUserId, identity.authUserId].includes(start.account_user_id)) {
      throw controlFailure("Registration start was not confirmed for the current account. Inspect before retrying.", "REMOTE_ENROLLMENT_UNKNOWN");
    }
    record = { ...record, clientId: start.client_id, serverAccountUserId: start.account_user_id, phase: "creating-key" };
    await saveDevice(home, identity, record);
    record.key ??= await key("create"); record.phase = "key-created";
    await saveDevice(home, identity, record);
    const enrolled = { ...record.key, clientId: record.clientId, accountUserId: record.serverAccountUserId, ...keySelection(record) };
    enrollmentPayload(start.device_key_challenge, enrolled, ENROLL_FINISH);
    const proof = verifyEnrollmentProof(await key("enrollment-proof", { home, identity, enrollment: enrolled, challenge: start.device_key_challenge, path: ENROLL_FINISH }), start.device_key_challenge, enrolled);
    record.phase = "finish-unknown"; await saveDevice(home, identity, record);
    const result = await context.request(ENROLL_FINISH, { body: { client_id: enrolled.clientId, step_up_token: stepUp,
      device_identity: deviceIdentity(enrolled), device_key_proof: proof } });
    validateRegistration(result, enrolled);
    record.phase = "enrolled"; await saveDevice(home, identity, record);
    return deviceStatus(record);
  });
}

export async function pairDevice(context, hostId, code) {
  if (!/^remote-control:env_[A-Za-z0-9_-]+$/.test(hostId) || typeof code !== "string" || !/^[A-Za-z0-9-]{6,128}$/.test(code)) {
    throw controlFailure("Pairing requires an explicit Remote Control host and its fresh code via stdin.", "REMOTE_PAIR_INPUT_INVALID");
  }
  const { home, identity } = context;
  return withDeviceLock(home, identity, async () => {
    const record = await readDevice(home, identity), enrollment = dedicatedEnrollment(record, identity);
    if (record.pairing_unknown) throw controlFailure("The last pairing has unknown outcome. Use remote verify before another attempt.", "REMOTE_PAIR_UNKNOWN");
    if (record.pairings.some(pair => pair.host_id === hostId)) return deviceStatus(record);
    record.pairing_unknown = true; await saveDevice(home, identity, record);
    let result;
    try { result = await context.request(PAIR_PATH, { body: { client_id: enrollment.clientId, manual_pairing_code: code } }); }
    catch (error) { if (error.code === "REMOTE_ENROLLMENT_REJECTED") { record.pairing_unknown = false; await saveDevice(home, identity, record); } throw error; }
    if (!/^env_[A-Za-z0-9_-]+$/.test(result?.environment_id ?? "")) throw controlFailure("Pairing acknowledgement was invalid. Use remote verify.", "REMOTE_PAIR_UNKNOWN");
    const actualHost = `remote-control:${result.environment_id}`;
    record.pairings = [...record.pairings.filter(pair => pair.host_id !== actualHost), { host_id: actualHost, verified_at: new Date().toISOString() }];
    record.pairing_unknown = false; await saveDevice(home, identity, record);
    if (actualHost !== hostId) throw controlFailure(`The supplied pairing code belongs to ${actualHost}, not the selected host. No task was opened or sent an instruction.`, "REMOTE_PAIR_HOST_MISMATCH");
    return deviceStatus(record);
  });
}

export async function verifyDevice(context, { key = deviceKey, open = RemoteControlSocket.connect } = {}) {
  const { home, identity } = context;
  return withDeviceLock(home, identity, async () => {
    const record = await readDevice(home, identity);
    if (!record?.key || !record.clientId || !["enrolled", "finish-unknown"].includes(record.phase)
      || ![identity.accountUserId, identity.authUserId].includes(record.serverAccountUserId)) throw controlFailure("No completed or possibly completed dedicated registration can be verified. Inspect its saved phase before creating another.", "REMOTE_ENROLLMENT_PENDING");
    const enrollment = { ...record.key, clientId: record.clientId, accountUserId: record.serverAccountUserId, ...keySelection(record) };
    await key("inspect", { enrollment, home, identity });
    const auth = await context.current();
    const socket = await open({ ...auth, enrollment, environmentId: "env_registration_probe", sign: async challenge => {
      await context.current(); return dedicatedConnectionProof(enrollment, challenge, { home, identity });
    } });
    // Authentication only: do not initialize a stream, open a task or send RPC.
    socket.terminate();
    record.phase = "enrolled"; await saveDevice(home, identity, record);
    const hosts = [], seen = new Set(); let cursor;
    for (let page = 0; page < 100; page++) {
      const route = `/codex/remote/control/clients/${encodeURIComponent(enrollment.clientId)}/environments?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await context.request(route, { method: "GET" });
      if (!Array.isArray(response?.items) || response.items.some(item => !/^env_[A-Za-z0-9_-]+$/.test(item?.env_id ?? ""))) throw controlFailure("Invalid paired-host list.", "REMOTE_PAIR_UNKNOWN");
      hosts.push(...response.items.map(item => `remote-control:${item.env_id}`));
      if (response.cursor == null) {
        record.pairings = [...new Set(hosts)].map(host_id => ({ host_id, verified_at: new Date().toISOString() }));
        record.pairing_unknown = false; await saveDevice(home, identity, record); return deviceStatus(record);
      }
      if (typeof response.cursor !== "string" || !response.cursor || seen.has(response.cursor) || response.cursor.length > 4096) throw controlFailure("Invalid paired-host pagination.", "REMOTE_PAIR_UNKNOWN");
      seen.add(response.cursor); cursor = response.cursor;
    }
    throw controlFailure("Paired-host history exceeded its limit.", "REMOTE_PAIR_UNKNOWN");
  });
}
