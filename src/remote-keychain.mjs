import { readFile, lstat, mkdir, writeFile, rename, rm, chmod } from "node:fs/promises";
import { createHash, randomUUID, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deviceStore, validateDeviceKey } from "./remote-device-store.mjs";
import { connectionPayload, controlFailure } from "./remote-control-auth.mjs";
import { enrollmentPayload } from "./remote-device-protocol.mjs";

const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function owned(file, directory = false) {
  const info = await lstat(file);
  if (info.uid !== process.getuid() || info.isSymbolicLink() || (info.mode & 0o077) || !(directory ? info.isDirectory() : info.isFile())) throw controlFailure("Unsafe dedicated key helper runtime.", "REMOTE_DEVICE_STORE_UNSAFE");
}

export async function prepareKeychainRuntime(home, identity) {
  const { file } = await deviceStore(home, identity, { create: true }), root = path.join(path.dirname(file), "key-helpers");
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); await owned(root, true);
  const source = await readFile(new URL("../assets/remote-device-key.swift", import.meta.url)), sourceHash = hash(Buffer.concat([source, Buffer.from(process.arch)]));
  const directory = path.join(root, sourceHash), binary = path.join(directory, "device-key");
  try { await owned(directory, true); await owned(path.join(directory, "manifest.json")); const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    const runtime = { source: sourceHash, sha256: manifest.sha256 }; await keychainBinary(home, identity, runtime); return runtime;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const staging = path.join(root, `.build-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
  try {
    const swift = path.join(staging, "device-key.swift"), target = path.join(staging, "device-key"); await writeFile(swift, source, { mode: 0o600 });
    try {
      await execute("/usr/bin/xcrun", ["swiftc", swift, "-O", "-framework", "Security", "-framework", "Foundation", "-module-cache-path", path.join(staging, "module-cache"), "-o", target], { timeout: 120000, maxBuffer: 65536 });
      await chmod(target, 0o700);
      // Ad-hoc sign our own new helper only. No Desktop binary or privileged
      // entitlement is modified; no user's signing certificate is accessed.
      await execute("/usr/bin/codesign", ["--sign", "-", "--identifier", "dev.codexteer.device-key", target], { timeout: 10000, maxBuffer: 16384 });
    } catch { throw controlFailure("Cannot build the dedicated Keychain helper. Xcode command-line tools are required; no key was created.", "REMOTE_KEY_HELPER_BUILD_FAILED"); }
    const runtime = { source: sourceHash, sha256: hash(await readFile(target)) };
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify(runtime), { mode: 0o600 });
    await rm(path.join(staging, "module-cache"), { recursive: true, force: true }); await rm(swift);
    await rename(staging, directory); return runtime;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function keychainBinary(home, identity, runtime) {
  if (!/^[a-f0-9]{64}$/.test(runtime?.source ?? "") || !/^[a-f0-9]{64}$/.test(runtime?.sha256 ?? "")) throw controlFailure("Invalid pinned key helper.", "REMOTE_DEVICE_STORE_UNSAFE");
  const { file } = await deviceStore(home, identity), root = path.join(path.dirname(file), "key-helpers"), directory = path.join(root, runtime.source), binary = path.join(directory, "device-key");
  await owned(root, true); await owned(directory, true); await owned(binary);
  if (hash(await readFile(binary)) !== runtime.sha256) throw controlFailure("Pinned key helper changed. No signing was attempted.", "REMOTE_DEVICE_STORE_UNSAFE");
  await execute("/usr/bin/codesign", ["--verify", "--strict", binary], { timeout: 10000, maxBuffer: 16384 }); return binary;
}

export async function keychainOperation(operation, input) {
  const { home, identity, runtime } = input, binary = await keychainBinary(home, identity, runtime);
  const { file: record } = await deviceStore(home, identity), request = path.join(path.dirname(record), `.request-${randomUUID()}.json`);
  let payload;
  if (operation === "connection-proof") payload = connectionPayload(input.challenge, input.enrollment);
  else if (operation === "enrollment-proof") payload = enrollmentPayload(input.challenge, input.enrollment, input.path);
  const bytes = payload ? Buffer.from(JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload })) : null;
  try {
    await writeFile(request, JSON.stringify({ operation: operation === "create" ? "create" : ["inspect", "recover"].includes(operation) ? "inspect" : "sign",
      keyId: input.enrollment?.keyId ?? input.keyId, ...(bytes ? { signedPayloadBase64: bytes.toString("base64") } : {}) }), { mode: 0o600, flag: "wx" });
    let response;
    try { response = JSON.parse((await execute(binary, [request], { timeout: 10000, maxBuffer: 32768 })).stdout); }
    catch { throw controlFailure("Dedicated Keychain helper lost its acknowledgement. Inspect the saved phase before retrying.", "REMOTE_DEDICATED_KEY_UNAVAILABLE"); }
    if (response.ok !== true) throw controlFailure(`Dedicated Keychain operation failed at ${["input", "create", "validate", "public-key", "payload", "sign"].includes(response.stage) ? response.stage : "worker"} (${Number.isSafeInteger(response.os_status) ? response.os_status : "UNVERIFIED"}).`, "REMOTE_DEDICATED_KEY_UNAVAILABLE");
    const key = validateDeviceKey(response.key);
    if (["create", "recover"].includes(operation)) return key;
    for (const field of Object.keys(key)) if (key[field] !== input.enrollment[field]) throw controlFailure("Dedicated Keychain public key changed.", "REMOTE_DEVICE_KEY_INVALID");
    if (operation === "inspect") return;
    if (!verify("sha256", bytes, { key: Buffer.from(key.publicKeySpkiDerBase64, "base64"), type: "spki", format: "der" }, Buffer.from(response.signatureDerBase64, "base64"))) throw controlFailure("Dedicated signature did not match the enrolled key.", "REMOTE_AUTH_PROOF_INVALID");
    return operation === "connection-proof" ? { type: "device_key_proof", keyId: key.keyId, algorithm: key.algorithm, signatureDerBase64: response.signatureDerBase64, signedPayloadBase64: bytes.toString("base64") }
      : { challenge_token: input.challenge.challenge_token, key_id: key.keyId, algorithm: key.algorithm, signature_der_base64: response.signatureDerBase64, signed_payload_base64: bytes.toString("base64") };
  } finally { await rm(request, { force: true }); }
}
