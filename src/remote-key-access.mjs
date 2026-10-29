import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { BUNDLED_NODE } from "./wrapper.mjs";

const DESKTOP = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";

// Read public code-signature metadata only. Do not load Desktop code, attach to
// its process, alter entitlements, or query/export Keychain item material.
export function entitlementBlob(signature) {
  if (signature.length < 12 || signature.readUInt32BE(0) !== 0xfade0cc0) throw new Error("Invalid signature container");
  const length = signature.readUInt32BE(4), count = signature.readUInt32BE(8);
  // LC_CODE_SIGNATURE reserves aligned zero-filled capacity beyond the actual
  // SuperBlob. Only that padding may lie outside its declared length.
  if (length < 12 || length > signature.length || signature.subarray(length).some(byte => byte !== 0)
    || count > 1024 || 12 + count * 8 > length) throw new Error("Invalid signature index");
  for (let index = 0; index < count; index++) {
    const slot = 12 + index * 8, offset = signature.readUInt32BE(slot + 4);
    if (signature.readUInt32BE(slot) !== 5) continue;
    if (offset < 12 + count * 8 || offset + 8 > length || signature.readUInt32BE(offset) !== 0xfade7171) throw new Error("Invalid entitlement slot");
    const size = signature.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > length) throw new Error("Invalid entitlement size");
    return signature.subarray(offset + 8, offset + size);
  }
  return null;
}

async function embeddedEntitlements(executable) {
  const file = await open(executable, "r");
  try {
    const exact = async (length, offset) => {
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) throw new Error("Incomplete signature metadata");
      return bytes;
    };
    const header = await exact(32, 0);
    // The installed Desktop and bundled Node use little-endian thin Mach-O64.
    // Unknown layouts are reported as unverified, never treated as authorized.
    if (header.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Unrecognized executable layout");
    const count = header.readUInt32LE(16), size = header.readUInt32LE(20);
    if (count > 4096 || size > 1024 * 1024) throw new Error("Invalid load commands");
    const commands = await exact(size, 32);
    for (let index = 0, offset = 0; index < count; index++) {
      if (offset + 8 > size) throw new Error("Incomplete load command");
      const command = commands.readUInt32LE(offset), length = commands.readUInt32LE(offset + 4);
      if (length < 8 || offset + length > size) throw new Error("Invalid load command");
      if (command === 0x1d) {
        if (length < 16) throw new Error("Invalid code signature command");
        const start = commands.readUInt32LE(offset + 8), bytes = commands.readUInt32LE(offset + 12);
        if (bytes > 16 * 1024 * 1024) throw new Error("Signature metadata too large");
        return entitlementBlob(await exact(bytes, start));
      }
      offset += length;
    }
    throw new Error("No code signature metadata");
  } finally { await file.close(); }
}

export async function inspectKeychainIdentities({ read = embeddedEntitlements, run = spawnSync } = {}) {
  const summary = async executable => {
    try {
      const xml = await read(executable);
      if (!xml) throw new Error();
      const result = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: xml, encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0) throw new Error();
      const values = JSON.parse(result.stdout), groups = values["keychain-access-groups"];
      if (groups !== undefined && (!Array.isArray(groups) || groups.some(value => typeof value !== "string"))) throw new Error();
      return { status: "observed", application_identifier: typeof (values["com.apple.application-identifier"] ?? values["application-identifier"]) === "string",
        keychain_access_group_count: groups?.length ?? 0 };
    } catch { return { status: "unverified" }; }
  };
  const [desktop, helper] = await Promise.all([summary(DESKTOP), summary(BUNDLED_NODE)]);
  return { source: "embedded-public-entitlements", desktop, helper,
    different_keychain_identity: desktop.status !== "observed" || helper.status !== "observed" ? null
      : desktop.application_identifier !== helper.application_identifier || desktop.keychain_access_group_count !== helper.keychain_access_group_count,
    interpretation: "Identity metadata can explain access differences; it does not prove the enrolled key is missing from Desktop." };
}
