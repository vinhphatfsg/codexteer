import { createHash, verify } from "node:crypto";
import { controlFailure, CONTROL_SCOPE } from "./remote-control-auth.mjs";
import { REMOTE_CLIENT_INFO } from "./remote-client-info.mjs";

export const ENROLL_START = "/codex/remote/control/client/enroll/start";
export const ENROLL_FINISH = "/codex/remote/control/client/enroll/finish";
export const PAIR_PATH = "/wham/remote/control/client/pair";
export const deviceIdentity = key => ({ key_id: key.keyId, public_key_spki_der_base64: key.publicKeySpkiDerBase64, algorithm: key.algorithm, protection_class: key.protectionClass });
export const deviceIdentityHash = key => createHash("sha256").update(JSON.stringify({ algorithm: key.algorithm, keyId: key.keyId, protectionClass: key.protectionClass, publicKeySpkiDerBase64: key.publicKeySpkiDerBase64 })).digest("base64url");
const expires = value => Number.isSafeInteger(value) ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;

export function enrollmentPayload(challenge, enrollment, targetPath, now = Date.now()) {
  const hash = deviceIdentityHash(enrollment);
  if (![ENROLL_FINISH, "/codex/remote/control/client/refresh/finish"].includes(targetPath)
    || challenge?.purpose !== "remote_control_client_enrollment" || challenge.audience !== "remote_control_client_enrollment"
    || challenge.target_origin !== "https://chatgpt.com" || challenge.target_path !== `/backend-api${targetPath}`
    || challenge.account_user_id !== enrollment.accountUserId || challenge.client_id !== enrollment.clientId
    || typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43,512}$/.test(challenge.nonce)
    || !Number.isFinite(expires(challenge.challenge_expires_at)) || expires(challenge.challenge_expires_at) <= now
    || typeof challenge.challenge_id !== "string" || !challenge.challenge_id || challenge.challenge_id.length > 512
    || typeof challenge.challenge_token !== "string" || !challenge.challenge_token || challenge.challenge_token.length > 16384
    || (challenge.device_identity_hash != null && challenge.device_identity_hash !== hash)
    || (targetPath.endsWith("/refresh/finish") && challenge.device_identity_hash == null)) {
    throw controlFailure("Enrollment challenge does not match this dedicated key, account or official destination.", "REMOTE_ENROLLMENT_CHALLENGE_INVALID");
  }
  // Canonical order from Desktop Qdt, including the hash of our new public key.
  return { accountUserId: enrollment.accountUserId, audience: challenge.audience, challengeExpiresAt: challenge.challenge_expires_at,
    challengeId: challenge.challenge_id, clientId: enrollment.clientId, deviceIdentitySha256Base64url: hash, nonce: challenge.nonce,
    targetOrigin: challenge.target_origin, targetPath: challenge.target_path, type: "remoteControlClientEnrollment" };
}

export function validateRegistration(result, enrollment) {
  if (result?.client_id !== enrollment.clientId || result.account_user_id !== enrollment.accountUserId
    || expires(result.expires_at) <= Date.now() || !Number.isFinite(expires(result.expires_at))
    || !Array.isArray(result.scopes) || result.scopes.length !== 1 || result.scopes[0] !== CONTROL_SCOPE
    || typeof result.remote_control_token !== "string" || !result.remote_control_token) {
    throw controlFailure("Enrollment response was not confirmed for this dedicated client. Verify before retrying.", "REMOTE_ENROLLMENT_UNKNOWN");
  }
}

export function verifyEnrollmentProof(proof, challenge, enrollment, path = ENROLL_FINISH) {
  const bytes = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: enrollmentPayload(challenge, enrollment, path) }));
  if (proof?.challenge_token !== challenge.challenge_token || proof.key_id !== enrollment.keyId || proof.algorithm !== enrollment.algorithm
    || proof.signed_payload_base64 !== bytes.toString("base64") || typeof proof.signature_der_base64 !== "string"
    || !verify("sha256", bytes, { key: Buffer.from(enrollment.publicKeySpkiDerBase64, "base64"), type: "spki", format: "der" }, Buffer.from(proof.signature_der_base64, "base64"))) {
    throw controlFailure("Dedicated enrollment proof does not match its challenge and public key.", "REMOTE_AUTH_PROOF_INVALID");
  }
  return proof;
}

// Fixed official origin and a small operation allowlist. No overrides, redirects,
// raw error bodies, request retries or credential-bearing debug output.
export async function officialDeviceRequest(auth, route, { method = "POST", body, fetch: request = globalThis.fetch } = {}) {
  const allowed = method === "POST" ? [ENROLL_START, ENROLL_FINISH, PAIR_PATH].includes(route)
    : method === "GET" && /^(?:\/codex\/remote\/control\/clients\/[A-Za-z0-9_-]+\/environments|\/wham\/remote\/control\/clients)\?limit=100(?:&cursor=[A-Za-z0-9%_.~-]+)?$/.test(route);
  if (!allowed) throw controlFailure("Unsupported official device endpoint.", "REMOTE_DEVICE_ENDPOINT_INVALID");
  let response;
  try {
    response = await request(`https://chatgpt.com/backend-api${route}`, { method, headers: { Authorization: `Bearer ${auth.token}`,
      "ChatGPT-Account-Id": auth.identity.accountId, originator: "codexteer", "User-Agent": REMOTE_CLIENT_INFO.user_agent, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch { throw controlFailure("Official device request lost its acknowledgement. Inspect the registration before retrying.", "REMOTE_ENROLLMENT_UNKNOWN"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw controlFailure(`Official device request returned HTTP ${response.status}. No authentication fallback was attempted.`, response.status >= 500 ? "REMOTE_ENROLLMENT_UNKNOWN" : "REMOTE_ENROLLMENT_REJECTED");
  }
  try {
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw controlFailure("Official device response was incomplete. Verify before retrying.", "REMOTE_ENROLLMENT_UNKNOWN"); }
}
