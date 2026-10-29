import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { readEnrollment, enrollmentHash, connectionPayload, verifyDeviceProof } from "./remote-control-auth.mjs";

// No generic signing interface, key creation, enrollment or network access.
let stage = "input";
try {
  const file = process.argv[2], info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 16384) throw new Error();
  const input = JSON.parse(await readFile(file, "utf8")); stage = "enrollment";
  if (!["inspect", "sign"].includes(input.operation) || (input.operation === "inspect" && input.challenge !== undefined)) throw new Error();
  const enrollment = await readEnrollment(input.home, input.identity);
  if (enrollmentHash(enrollment) !== input.enrollmentHash) throw new Error();
  const payload = input.operation === "sign" ? Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: connectionPayload(input.challenge, enrollment) })) : null;
  stage = "addon";
  const native = createRequire(import.meta.url)("/Applications/ChatGPT.app/Contents/Resources/native/remote-control-device-key.node");
  stage = "public-key";
  const key = await native.getDeviceKeyPublic(enrollment.keyId);
  stage = "public-key-match";
  for (const field of ["keyId", "algorithm", "protectionClass", "publicKeySpkiDerBase64"]) if (key[field] !== enrollment[field]) throw new Error();
  if (input.operation === "inspect") {
    process.stdout.write(JSON.stringify({ ok: true, operation: "inspect", device_key_access: "verified" }));
  } else {
    stage = "sign";
    const signature = await native.signDeviceKey(enrollment.keyId, payload);
    stage = "verify";
    const proof = verifyDeviceProof({ type: "device_key_proof", keyId: enrollment.keyId, algorithm: signature.algorithm,
      signatureDerBase64: signature.signatureDerBase64, signedPayloadBase64: payload.toString("base64") }, input.challenge, enrollment);
    process.stdout.write(JSON.stringify({ ok: true, proof }));
  }
} catch (error) {
  const status = error?.message?.match(/(?:OSStatus|status|Security\.framework error code)[^\d-]*(-?\d+)/i)?.[1];
  const known = { "No keychain is available. You may need to restart your computer.": "KEYCHAIN_UNAVAILABLE",
    "device key not found": "DEVICE_KEY_NOT_FOUND", "invalid device key id": "DEVICE_KEY_ID_INVALID",
    remote_control_device_key_unusable: "DEVICE_KEY_UNUSABLE", remote_control_device_key_store_unavailable: "DEVICE_KEY_STORE_UNAVAILABLE" };
  const nativeCode = known[error?.message] ?? known[error?.errorCode] ?? (typeof error?.code === "number" || /^[A-Z][A-Z0-9_:-]{0,79}$/.test(error?.code ?? "") ? error.code : status ? Number(status) : null);
  process.stdout.write(JSON.stringify({ ok: false, code: "REMOTE_AUTH_SIGNING_FAILED", stage, native_code: nativeCode })); process.exitCode = 1;
}
