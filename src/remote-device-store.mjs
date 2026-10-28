import { lstat, mkdir, readFile, realpath, rename, writeFile, rm } from "node:fs/promises";
import { createHash, randomUUID, createPublicKey } from "node:crypto";
import path from "node:path";
import { controlFailure } from "./remote-control-auth.mjs";

export function validateDeviceKey(key) {
  try {
    if (key?.algorithm !== "ecdsa_p256_sha256" || !["hardware_secure_enclave", "os_protected_nonextractable"].includes(key.protectionClass)
      || ![key.keyId, key.publicKeySpkiDerBase64].every(value => typeof value === "string" && value.length > 0 && value.length < 8192)) throw new Error();
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKeySpkiDerBase64, "base64"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    return { keyId: key.keyId, publicKeySpkiDerBase64: key.publicKeySpkiDerBase64, algorithm: key.algorithm, protectionClass: key.protectionClass };
  } catch { throw controlFailure("The dedicated device key is not a supported OS-protected P-256 key.", "REMOTE_DEVICE_KEY_INVALID"); }
}

export async function deviceStore(home, identity, { create = false } = {}) {
  const canonical = await realpath(home), directories = [path.join(canonical, "codex-steer"), path.join(canonical, "codex-steer", "remote-device")];
  for (const directory of directories) {
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw controlFailure("Unsafe dedicated device directory.", "REMOTE_DEVICE_STORE_UNSAFE");
  }
  const hash = createHash("sha256").update(JSON.stringify([identity.accountId, identity.accountUserId])).digest("hex");
  return { file: path.join(directories[1], `${hash}.json`), lock: path.join(directories[1], `${hash}.lock`) };
}

export async function readDevice(home, identity) {
  try {
    const { file } = await deviceStore(home, identity), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) throw controlFailure("Unsafe dedicated device record.", "REMOTE_DEVICE_STORE_UNSAFE");
    const record = JSON.parse(await readFile(file, "utf8"));
    if (record.schema !== 1 || record.accountId !== identity.accountId || record.accountUserId !== identity.accountUserId
      || !["key-failed", "prepared", "starting", "creating-key", "key-created", "finish-unknown", "enrolled"].includes(record.phase) || !Array.isArray(record.pairings)) throw new Error();
    if ((record.key_provider !== undefined && !["openai-native", "keychain"].includes(record.key_provider))
      || record.pairings.some(pair => !/^remote-control:env_[A-Za-z0-9_-]+$/.test(pair?.host_id ?? ""))) throw new Error();
    if (record.key) validateDeviceKey(record.key);
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code?.startsWith("REMOTE_")) throw error;
    throw controlFailure("Invalid dedicated device registration record.", "REMOTE_DEVICE_STORE_UNSAFE");
  }
}

export async function saveDevice(home, identity, record) {
  const { file } = await deviceStore(home, identity, { create: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  // All callers pass an explicit public-metadata record, never HTTP bodies,
  // OAuth responses, pairing codes or any private key representation.
  const allowed = ["schema", "accountId", "accountUserId", "phase", "operation_id", "clientId", "serverAccountUserId", "key", "pairings", "created_at", "updated_at", "pairing_unknown", "key_provider", "key_runtime", "key_error", "candidate_key_id"];
  if (Object.keys(record).some(key => !allowed.includes(key))) throw controlFailure("Unexpected dedicated registration data.", "REMOTE_DEVICE_STORE_UNSAFE");
  try { await writeFile(temporary, JSON.stringify({ ...record, updated_at: new Date().toISOString() }), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

export async function withDeviceLock(home, identity, operation) {
  const { lock } = await deviceStore(home, identity, { create: true });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw controlFailure("Another device operation is running or left an unresolved lock. Inspect it before retrying.", "REMOTE_DEVICE_BUSY"); throw error; }
  try { return await operation(); } finally { await rm(lock, { recursive: true }); }
}

export function dedicatedEnrollment(record, identity) {
  if (!record || record.phase !== "enrolled" || !record.clientId || ![identity.accountUserId, identity.authUserId].includes(record.serverAccountUserId)) {
    throw controlFailure("Enroll a codexteer device with remote enroll, then pair it with the selected host.", "REMOTE_DEDICATED_ENROLLMENT_REQUIRED");
  }
  return { ...validateDeviceKey(record.key), clientId: record.clientId, accountUserId: record.serverAccountUserId,
    ...keySelection(record) };
}

export const keySelection = record => record.key_provider === "keychain" ? { keyProvider: "keychain", keyRuntime: record.key_runtime } : {};
