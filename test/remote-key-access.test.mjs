import test from "node:test";
import assert from "node:assert/strict";
import { entitlementBlob, inspectKeychainIdentities } from "../src/remote-key-access.mjs";

const plist = values => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${values}</dict></plist>`);
function signature(xml) {
  const result = Buffer.alloc(28 + xml.length);
  result.writeUInt32BE(0xfade0cc0); result.writeUInt32BE(result.length, 4); result.writeUInt32BE(1, 8);
  result.writeUInt32BE(5, 12); result.writeUInt32BE(20, 16); result.writeUInt32BE(0xfade7171, 20); result.writeUInt32BE(xml.length + 8, 24);
  xml.copy(result, 28); return result;
}

test("embedded public entitlements are bounded by their code signature index and blob", () => {
  const xml = plist("<key>keychain-access-groups</key><array><string>fixture.group</string></array>");
  const original = signature(xml); assert.deepEqual(entitlementBlob(original), xml);
  assert.deepEqual(entitlementBlob(Buffer.concat([original, Buffer.alloc(8192)])), xml);
  assert.throws(() => entitlementBlob(Buffer.concat([original, Buffer.from([1])])));
  for (const [offset, value] of [[4, original.length + 1], [8, 1025], [16, 0], [16, original.length], [20, 0], [24, original.length]]) {
    const invalid = Buffer.from(original); invalid.writeUInt32BE(value, offset); assert.throws(() => entitlementBlob(invalid));
  }
  assert.throws(() => entitlementBlob(Buffer.alloc(4)));
  const absent = Buffer.from(original); absent.writeUInt32BE(7, 12); assert.equal(entitlementBlob(absent), null);
});

test("public identity inspection distinguishes Desktop from signed Node without key IDs or credentials", { skip: process.platform !== "darwin" }, async () => {
  const result = await inspectKeychainIdentities({ read: async path => path.endsWith("/ChatGPT")
    ? plist("<key>com.apple.application-identifier</key><string>fixture.desktop</string><key>keychain-access-groups</key><array><string>fixture.group</string></array>")
    : plist("<key>com.apple.security.network.client</key><true/>") });
  assert.equal(result.desktop.application_identifier, true); assert.equal(result.desktop.keychain_access_group_count, 1);
  assert.equal(result.helper.application_identifier, false); assert.equal(result.helper.keychain_access_group_count, 0);
  assert.equal(result.different_keychain_identity, true);
  assert.equal(JSON.stringify(result).includes("fixture.group"), false);
});

test("unreadable or unknown executable metadata remains unverified rather than granting access", async () => {
  const result = await inspectKeychainIdentities({ read: async () => { throw new Error("secret path or other native data"); } });
  assert.equal(result.desktop.status, "unverified"); assert.equal(result.helper.status, "unverified");
  assert.equal(result.different_keychain_identity, null); assert.equal(JSON.stringify(result).includes("secret"), false);
});
