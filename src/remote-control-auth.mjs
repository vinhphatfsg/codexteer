import { lstat, readFile, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { BUNDLED_NODE } from "./wrapper.mjs";

export const CONTROL_URL = "wss://chatgpt.com/backend-api/codex/remote/control/client";
export const CONTROL_SCOPE = "remote_control_controller_websocket";
export const CONTROL_AUDIENCE = "remote_control_client_websocket";
export const controlFailure = (message, code = "REMOTE_CONTROL_UNVERIFIED") => Object.assign(new Error(message), { code });

export function authIdentity(status) {
  try {
    if (!["chatgpt", "chatgptAuthTokens"].includes(status.authMethod) || typeof status.authToken !== "string") throw new Error();
    const jwt = JSON.parse(Buffer.from(status.authToken.split(".")[1], "base64url")), auth = jwt["https://api.openai.com/auth"];
    const accountId = auth.chatgpt_account_id ?? auth.account_id, accountUserId = auth.chatgpt_account_user_id ?? auth.account_user_id;
    if (typeof accountId !== "string" || !accountId || typeof accountUserId !== "string" || !accountUserId
      || !Number.isSafeInteger(jwt.exp) || jwt.exp <= Date.now() / 1000 || auth.is_fedramp === true) throw new Error();
    const authUserId = typeof auth.user_id === "string" && auth.user_id && auth.user_id !== accountUserId ? auth.user_id : undefined;
    return { accountId, accountUserId, ...(authUserId ? { authUserId } : {}) };
  } catch { throw controlFailure("A current standard ChatGPT account token is required for the explicitly selected Remote Control route.", "REMOTE_AUTH_UNAVAILABLE"); }
}

export async function readEnrollment(home, identity) {
  const canonical = await realpath(home), file = path.join(canonical, ".codex-global-state.json"), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022) || info.size > 32 * 1024 * 1024) throw controlFailure("Unsafe Desktop enrollment registry.", "REMOTE_ENROLLMENT_UNSAFE");
  const state = JSON.parse(await readFile(file, "utf8"));
  // Desktop also accepts the auth user alias from this same token when the
  // account header matches its account claim. Our header is pinned to accountId.
  const candidates = [...new Set([identity.accountUserId, identity.authUserId].filter(Boolean))];
  let record;
  for (const candidate of candidates) {
    const key = ["Codex Desktop", "http://localhost:8000/api", "https://chatgpt.com/backend-api", "after-first-unlock-device-key-v1", candidate].join("\n");
    const entry = state["electron-remote-control-client-enrollments"]?.[key];
    if (entry?.accountUserId === candidate) { record = entry; break; }
  }
  if (!record || record.algorithm !== "ecdsa_p256_sha256"
    || !["hardware_secure_enclave", "os_protected_nonextractable"].includes(record.protectionClass)
    || ![record.clientId, record.keyId, record.publicKeySpkiDerBase64].every(x => typeof x === "string" && x.length > 0 && x.length < 8192)) {
    throw controlFailure("No matching existing Desktop device-key enrollment. Enroll through Desktop settings; codexteer does not create keys or change authorization.", "REMOTE_ENROLLMENT_REQUIRED");
  }
  return { accountUserId: record.accountUserId, algorithm: record.algorithm, clientId: record.clientId, keyId: record.keyId,
    protectionClass: record.protectionClass, publicKeySpkiDerBase64: record.publicKeySpkiDerBase64 };
}

export const enrollmentHash = record => createHash("sha256").update(JSON.stringify(record)).digest("hex");

export function connectionPayload(challenge, enrollment, now = Date.now()) {
  const url = new URL(CONTROL_URL), hash = x => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x);
  if (challenge?.type !== "device_key_challenge" || challenge.purpose !== CONTROL_AUDIENCE || challenge.audience !== CONTROL_AUDIENCE
    || challenge.targetOrigin !== "https://chatgpt.com" || challenge.targetPath !== url.pathname
    || challenge.clientId !== enrollment.clientId || challenge.accountUserId !== enrollment.accountUserId
    || !Number.isSafeInteger(challenge.tokenExpiresAt) || challenge.tokenExpiresAt <= Math.floor(now / 1000)
    || !Array.isArray(challenge.scopes) || challenge.scopes.length !== 1 || challenge.scopes[0] !== CONTROL_SCOPE
    || typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43,512}$/.test(challenge.nonce)
    || typeof challenge.sessionId !== "string" || !challenge.sessionId || challenge.sessionId.length > 512 || !hash(challenge.tokenSha256Base64url)) {
    throw controlFailure("Remote device-key challenge does not match the selected account, client, official destination or allowed scope.", "REMOTE_AUTH_CHALLENGE_MISMATCH");
  }
  // Desktop canonicalizes the payload before signing (Qdt), independently of
  // the order in which its WebSocket challenge handler constructs the object.
  return { accountUserId: challenge.accountUserId, audience: challenge.audience, clientId: challenge.clientId, nonce: challenge.nonce,
    scopes: challenge.scopes, sessionId: challenge.sessionId, targetOrigin: challenge.targetOrigin, targetPath: challenge.targetPath,
    tokenExpiresAt: challenge.tokenExpiresAt, tokenSha256Base64url: challenge.tokenSha256Base64url, type: "remoteControlClientConnection" };
}

export function verifyDeviceProof(proof, challenge, enrollment) {
  const payload = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: connectionPayload(challenge, enrollment) }));
  if (proof?.type !== "device_key_proof" || proof.keyId !== enrollment.keyId || proof.algorithm !== enrollment.algorithm
    || proof.signedPayloadBase64 !== payload.toString("base64") || typeof proof.signatureDerBase64 !== "string"
    || !verify("sha256", payload, { key: Buffer.from(enrollment.publicKeySpkiDerBase64, "base64"), format: "der", type: "spki" }, Buffer.from(proof.signatureDerBase64, "base64"))) {
    throw controlFailure("Device-key proof does not match the enrolled public key or validated connection challenge.", "REMOTE_AUTH_PROOF_INVALID");
  }
  return proof;
}

// Only the fixed signing worker runs on Desktop's signed Node. No bearer token
// is placed on disk, in argv, in command output, or in the worker's input.
export async function signConnectionChallenge(local, home, identity, enrollment, challenge) {
  connectionPayload(challenge, enrollment);
  const output = await keyWorker(local, home, identity, enrollment, { operation: "sign", challenge });
  return verifyDeviceProof(output.proof, challenge, enrollment);
}

export async function inspectConnectionKey(local, home, identity, enrollment) {
  const output = await keyWorker(local, home, identity, enrollment, { operation: "inspect" });
  if (output.operation !== "inspect" || output.device_key_access !== "verified" || output.proof !== undefined) {
    throw controlFailure("Device-key inspection did not confirm access without signing.", "REMOTE_AUTH_SIGNING_FAILED");
  }
}

async function keyWorker(local, home, identity, enrollment, operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexteer-device-proof-"));
  try {
    const file = path.join(directory, "challenge.json");
    await writeFile(file, JSON.stringify({ home, identity, enrollmentHash: enrollmentHash(enrollment), ...operation }), { mode: 0o600, flag: "wx" });
    const result = await local.request("command/exec", { command: [BUNDLED_NODE, fileURLToPath(new URL("./remote-key-worker.mjs", import.meta.url)), file],
      cwd: fileURLToPath(new URL("..", import.meta.url)), timeoutMs: 10000, outputBytesCap: 16384, sandboxPolicy: { type: "readOnly", networkAccess: false } });
    let output;
    try { output = JSON.parse(result.stdout); } catch { throw controlFailure("Device-key worker did not return a proof.", "REMOTE_AUTH_SIGNING_FAILED"); }
    if (result.exitCode !== 0 || output.ok !== true) {
      const stage = ["input", "enrollment", "addon", "public-key", "public-key-match", "sign", "verify"].includes(output.stage) ? output.stage : "worker";
      const code = typeof output.native_code === "number" || /^[A-Z][A-Z0-9_:-]{0,79}$/.test(output.native_code ?? "") ? output.native_code : null;
      throw Object.assign(controlFailure(`Device-key signing failed at ${stage}${code == null ? "" : ` (${code})`}. No alternative key was used.`, "REMOTE_AUTH_SIGNING_FAILED"),
        { key_stage: stage, key_error: code });
    }
    return output;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
