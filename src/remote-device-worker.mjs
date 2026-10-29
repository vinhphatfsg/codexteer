import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { verify } from "node:crypto";
import { connectionPayload } from "./remote-control-auth.mjs";
import { validateDeviceKey } from "./remote-device-store.mjs";
import { enrollmentPayload } from "./remote-device-protocol.mjs";

// A new process of the unmodified signed Node, using normal OS key access.
// No Desktop process attachment, secret export, arbitrary signing or network.
let stage = "input";
try {
  const file = process.argv[2], info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 32768) throw new Error();
  const input = JSON.parse(await readFile(file, "utf8"));
  if (!["create", "inspect", "enrollment-proof", "connection-proof"].includes(input.operation)) throw new Error();
  stage = "addon";
  const native = createRequire(import.meta.url)("/Applications/ChatGPT.app/Contents/Resources/native/remote-control-device-key.node");
  if (input.operation === "create") {
    stage = "create";
    const created = await native.createDeviceKey("allow_os_protected_nonextractable");
    stage = "validate";
    process.stdout.write(JSON.stringify({ ok: true, key: validateDeviceKey(created) }));
  } else {
    stage = "public-key";
    const key = validateDeviceKey(input.enrollment), actual = await native.getDeviceKeyPublic(key.keyId);
    for (const field of Object.keys(key)) if (actual[field] !== key[field]) throw new Error();
    if (input.operation === "inspect") process.stdout.write(JSON.stringify({ ok: true, verified: true }));
    else {
      const payload = input.operation === "connection-proof" ? connectionPayload(input.challenge, input.enrollment)
        : enrollmentPayload(input.challenge, input.enrollment, input.path);
      const bytes = Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload }));
      stage = "sign";
      const signature = await native.signDeviceKey(key.keyId, bytes);
      if (signature.algorithm !== key.algorithm || !verify("sha256", bytes, { key: Buffer.from(key.publicKeySpkiDerBase64, "base64"), type: "spki", format: "der" }, Buffer.from(signature.signatureDerBase64, "base64"))) throw new Error();
      const proof = input.operation === "connection-proof"
        ? { type: "device_key_proof", keyId: key.keyId, algorithm: key.algorithm, signatureDerBase64: signature.signatureDerBase64, signedPayloadBase64: bytes.toString("base64") }
        : { challenge_token: input.challenge.challenge_token, key_id: key.keyId, algorithm: key.algorithm, signature_der_base64: signature.signatureDerBase64, signed_payload_base64: bytes.toString("base64") };
      process.stdout.write(JSON.stringify({ ok: true, proof }));
    }
  }
} catch (error) {
  // Native errors may include key identifiers; only a fixed classification exits.
  const message = String(error?.message ?? "");
  const statuses = [...message.matchAll(/(?:Security\.framework error code |OSStatus(?: error)?[: ]*|Code=)(-?\d+)/g)].map(match => Number(match[1]));
  const known = { "No keychain is available. You may need to restart your computer.": "KEYCHAIN_UNAVAILABLE", "device key not found": "DEVICE_KEY_NOT_FOUND" };
  const reason = known[message] ?? (/entitlement/i.test(message) ? "MISSING_ENTITLEMENT" : /keychain.*available/i.test(message) ? "KEYCHAIN_UNAVAILABLE" : /interaction.*not.*allowed/i.test(message) ? "OS_INTERACTION_REQUIRED" : "OS_KEY_OPERATION_FAILED");
  process.stdout.write(JSON.stringify({ ok: false, reason, stage, os_statuses: statuses }));
}
