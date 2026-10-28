import { RpcClient } from "./rpc.mjs";
import { discoverRuntime } from "./runtime.mjs";
import { assertRuntimeOperation } from "./compatibility.mjs";
import { inspectNativeCommandProtocol } from "./native-command.mjs";
import { targetHost, remoteTransport } from "./target.mjs";
import { VERSION } from "./version.mjs";
import { authIdentity, readEnrollment, enrollmentHash, signConnectionChallenge, inspectConnectionKey, controlFailure } from "./remote-control-auth.mjs";
import { RemoteControlSocket, MAX_CONTROL_REQUEST } from "./remote-control-socket.mjs";
import { inspectKeychainIdentities } from "./remote-key-access.mjs";
import { readDevice, dedicatedEnrollment } from "./remote-device-store.mjs";
import { deviceKey, dedicatedConnectionProof } from "./remote-device-key.mjs";

const methods = new Set(["thread/read", "thread/loaded/list", "thread/turns/list", "thread/items/list", "turn/steer"]);
const managementReads = new Set(["thread/list", "project/list", "project/read", "fs/readFile", "fs/getMetadata", "fs/readDirectory", "fs/watch", "fs/unwatch"]);
const managementWrites = new Set(["turn/start", "thread/metadata/update", "command/exec", "command/exec/terminate", "thread/shellCommand"]);
const capabilities = { thread_read: [1], history_pagination: [1], turn_steer: [1], turn_start: [], desktop_subscribe: [] };
export const remoteNewTurnUnsupported = () => Object.assign(controlFailure("Remote Control supports steering an existing active turn only. --new-turn remains unavailable because this route does not establish Desktop approval ownership.", "REMOTE_NEW_TURN_UNSUPPORTED"), { sent: false, delivery_status: "not_sent" });

export function validateControlRequest(method, params, options = {}) {
  if (Buffer.byteLength(JSON.stringify({ id: "0".repeat(36), method, params })) > MAX_CONTROL_REQUEST) throw controlFailure("Remote Control requests are limited to 64 KiB before dispatch.", "REMOTE_REQUEST_TOO_LARGE");
  if ((method === "turn/start" && !options.management) || method === "thread/resume") throw remoteNewTurnUnsupported();
  if (!methods.has(method) && !(options.management && (managementReads.has(method) || managementWrites.has(method)))
    || (options.mutation && method !== "turn/steer" && !(options.management && managementWrites.has(method)))) throw controlFailure("Unsupported Remote Control operation.", "REMOTE_METHOD_UNSUPPORTED");
  if (method === "turn/start" && (typeof params.threadId !== "string" || !params.threadId || typeof params.clientUserMessageId !== "string" || !params.clientUserMessageId
    || !Array.isArray(params.input) || !params.input.length || params.input.some(item => item.type !== "text" || typeof item.text !== "string")
    || Object.keys(params).some(key => !["threadId", "input", "clientUserMessageId"].includes(key)))) throw controlFailure("Remote new-turn requires a task, text input and client message ID.", "REMOTE_STEER_INVALID");
  if (method === "thread/metadata/update" && (typeof params.threadId !== "string" || !params.threadId || typeof params.projectId !== "string" || !params.projectId
    || Object.keys(params).some(key => !["threadId", "projectId"].includes(key)))) throw controlFailure("Remote project assignment requires an exact task and project.", "REMOTE_PROJECT_INVALID");
  if (method === "command/exec" && (!Array.isArray(params.command) || !params.command.length || params.command.some(arg => typeof arg !== "string")
    || Object.keys(params).some(key => !["command", "cwd", "timeoutMs", "outputBytesCap", "processId"].includes(key)))) throw controlFailure("Remote command execution preserves the host's configured permissions; overrides are unsupported.", "REMOTE_COMMAND_INVALID");
  if (method === "thread/shellCommand" && (typeof params.threadId !== "string" || !params.threadId || typeof params.command !== "string" || !params.command.trim()
    || Object.keys(params).some(key => !["threadId", "command", "timeoutMs"].includes(key)))) throw controlFailure("Remote shell commands require an exact task and explicit command.", "REMOTE_COMMAND_INVALID");
  if (method === "turn/steer" && (typeof params.threadId !== "string" || typeof params.expectedTurnId !== "string" || !params.expectedTurnId
    || !Array.isArray(params.input) || !params.input.length || params.input.some(input => input.type !== "text" || typeof input.text !== "string")
    || typeof params.clientUserMessageId !== "string" || !params.clientUserMessageId
    || Object.keys(params).some(key => !["threadId", "expectedTurnId", "input", "clientUserMessageId"].includes(key)))) {
    throw controlFailure("Remote steering requires the exact thread, expectedTurnId, text input and client message ID.", "REMOTE_STEER_INVALID");
  }
}

export function remoteControlConnection({ hostId = targetHost(), transport = remoteTransport() === "paired" ? "paired" : "control" } = {}, dependencies = {}) {
  const paired = transport === "paired";
  const loadDedicated = async (home, identity) => {
    const record = await readDevice(home, identity), enrollment = dedicatedEnrollment(record, identity);
    if (record.pairing_unknown || !record.pairings.some(pair => pair.host_id === hostId)) throw controlFailure("Pair this dedicated client with the selected host using remote pair, then remote verify.", "REMOTE_PAIR_REQUIRED");
    return enrollment;
  };
  const { discover = discoverRuntime, connect = RpcClient.connect, inspectCommand = inspectNativeCommandProtocol,
    enrollment = paired ? loadDedicated : readEnrollment,
    sign = paired ? async (_local, home, identity, enrolled, challenge) => dedicatedConnectionProof(enrolled, challenge, { home, identity }) : signConnectionChallenge,
    open = RemoteControlSocket.connect,
    inspectKey = paired ? async (_local, home, identity, enrolled) => deviceKey("inspect", { enrollment: enrolled, home, identity }) : inspectConnectionKey,
    inspectIdentities = inspectKeychainIdentities } = dependencies;
  if (!/^remote-control:env_[A-Za-z0-9_-]+$/.test(hostId)) throw controlFailure("The control transport requires a remote-control:env_... host ID; SSH and cloud hosts are not reinterpreted.", "REMOTE_HOST_UNSUPPORTED");
  let selected;
  return {
    async discover(home) {
      const runtime = await discover(home);
      assertRuntimeOperation(runtime.state, "read");
      if (selected && (selected.paths.socket !== runtime.paths.socket || selected.state.instance !== runtime.state.instance)) throw controlFailure("Shared runtime changed during Remote Control operation.", "RUNTIME_CHANGED");
      selected = runtime;
      return { paths: runtime.paths, state: { codex_steer_protocol: 1, codex_steer_capabilities: paired ? { ...capabilities, turn_start: [1], desktop_subscribe: [1] } : capabilities,
        remote_host_id: hostId, remote_transport: transport, cli_version: runtime.state.cli_version,
        instance: runtime.state.instance, node_path: runtime.state.node_path, node_version: runtime.state.node_version } };
    },
    async connect(socket, options = {}) {
      if (!selected || selected.paths.socket !== socket) throw controlFailure("Discover the selected shared runtime first.");
      const local = await connect(socket, { ...options, timeoutMs: 15000 });
      let remote, wire, cancelled = false;
      const close = () => { if (cancelled) return; cancelled = true; options.signal?.removeEventListener("abort", close); remote?.close(); if (!remote) wire?.terminate(); local.close(); };
      options.signal?.addEventListener("abort", close, { once: true });
      try {
        if (options.signal?.aborted) throw controlFailure("Remote Control cancelled.", "CANCELLED");
        const protocol = await inspectCommand(selected.state, { remoteControl: true });
        const status = await local.request("getAuthStatus", { includeToken: true, refreshToken: false }), identity = authIdentity(status);
        let registered;
        try { registered = await enrollment(selected.paths.home, identity); }
        catch (error) {
          if (paired && ["REMOTE_PAIR_REQUIRED", "REMOTE_DEDICATED_ENROLLMENT_REQUIRED"].includes(error.code)) error.remote_control_auth = {
            stage: error.code === "REMOTE_PAIR_REQUIRED" ? "host-pairing" : "dedicated-registration", credential_source: "codexteer-dedicated", gateway_attempted: false, proof_created: false };
          throw error;
        }
        const pinned = enrollmentHash(registered);
        // Verify public-key access before transmitting the token to a gateway.
        // This does not sign, enroll, resume, or borrow Desktop's credentials.
        try { await inspectKey(local, selected.paths.home, identity, registered); }
        catch (error) {
          if (!["REMOTE_AUTH_SIGNING_FAILED", "REMOTE_DEDICATED_KEY_UNAVAILABLE"].includes(error.code)) throw error;
          const diagnosis = { stage: "public-key-preflight", credential_source: paired ? "codexteer-dedicated" : "desktop", gateway_attempted: false, proof_created: false,
            key_access: { status: "unavailable", stage: error.key_stage ?? "worker", reason: error.key_error ?? "UNVERIFIED" },
            keychain_identity: await inspectIdentities(),
            app_server_delegation: { status: "unverified", source: protocol.source ?? "unverified", methods: protocol.remote_control_methods ?? [] } };
          throw Object.assign(controlFailure("The selected enrolled key is unavailable to its signing helper. No gateway connection or device-key proof was attempted. Inspect doctor.remote_control_auth; native read-only observation remains a separately selected route.", "REMOTE_DEVICE_KEY_UNAVAILABLE"),
            { remote_control_auth: diagnosis });
        }
        const check = async () => {
          if (cancelled) throw controlFailure("Remote Control connection closed.", "CONNECTION_FAILED");
          const current = await discover(selected.paths.home);
          if (current.paths.socket !== selected.paths.socket || current.state.instance !== selected.state.instance) throw controlFailure("Runtime changed before Remote Control request.", "RUNTIME_CHANGED");
          const now = authIdentity(await local.request("getAuthStatus", { includeToken: true, refreshToken: false }));
          if (now.accountId !== identity.accountId || now.accountUserId !== identity.accountUserId || now.authUserId !== identity.authUserId
            || enrollmentHash(await enrollment(selected.paths.home, now)) !== pinned) throw controlFailure("Account or enrolled device changed. No request was sent to another account.", "REMOTE_IDENTITY_CHANGED");
        };
        wire = await open({ identity, token: status.authToken, enrollment: registered, environmentId: hostId.slice("remote-control:".length), signal: options.signal,
          timeoutMs: Math.min(options.timeoutMs ?? 10000, 15000), sign: async challenge => { await check(); return sign(local, selected.paths.home, identity, registered, challenge); } });
        await check();
        remote = new RpcClient(wire, options);
        remote.initialization = await remote.request("initialize", { clientInfo: { name: "codexteer", title: "Codexteer", version: VERSION }, capabilities: { experimentalApi: true } });
        if (!remote.initialization || typeof remote.initialization !== "object" || Array.isArray(remote.initialization)) throw controlFailure("Invalid remote App Server initialization.", "REMOTE_CONTROL_PROTOCOL_ERROR");
        remote.notify("initialized", {});
        return {
          close,
          on: (event, listener) => remote.on(event, listener),
          off: (event, listener) => remote.off(event, listener),
          isOpen: () => wire.readyState === 1,
          async request(method, params = {}, requestOptions = {}) {
            validateControlRequest(method, params, { ...requestOptions, management: paired });
            await check();
            // The server, not a Desktop view or a fresh inferred turn, performs
            // the atomic expectedTurnId comparison. Never resume or retry here.
            return remote.request(method, params, { ...requestOptions, mutation: method === "turn/steer" || managementWrites.has(method) });
          },
        };
      } catch (error) { close(); throw error; }
    },
  };
}
