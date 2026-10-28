import Foundation
import Security

// A codexteer-owned, nonextractable login-Keychain key. This helper has no
// network access code and never requests a private key's external representation.
enum Failure: Error { case invalid }
var stage = "input"
func fail(_ status: OSStatus) throws -> Never { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
func query(_ id: String) throws -> [String: Any] {
    guard id.range(of: "^codexteer_[a-f0-9-]{36}$", options: .regularExpression) != nil else { throw Failure.invalid }
    return [kSecClass as String: kSecClassKey, kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: Data(("dev.codexteer.device-key." + id).utf8),
            kSecUseDataProtectionKeychain as String: false]
}
func metadata(_ key: SecKey, _ id: String) throws -> [String: Any] {
    guard let attrs = SecKeyCopyAttributes(key) as? [String: Any],
          (attrs[kSecAttrIsExtractable as String] as? NSNumber)?.boolValue == false,
          (attrs[kSecAttrKeySizeInBits as String] as? NSNumber)?.intValue == 256,
          let pub = SecKeyCopyPublicKey(key) else { throw Failure.invalid }
    var error: Unmanaged<CFError>?
    guard let bytes = SecKeyCopyExternalRepresentation(pub, &error) as Data?, bytes.count == 65, bytes.first == 4 else { throw Failure.invalid }
    let header: [UInt8] = [0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00]
    return ["keyId": id, "algorithm": "ecdsa_p256_sha256", "protectionClass": "os_protected_nonextractable",
            "publicKeySpkiDerBase64": (Data(header) + bytes).base64EncodedString()]
}
func supportedPayload(_ bytes: Data) throws {
    guard let outer = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], outer.count == 2,
          outer["domain"] as? String == "codex-device-key-sign-payload/v1", let p = outer["payload"] as? [String: Any],
          p["targetOrigin"] as? String == "https://chatgpt.com",
          let account = p["accountUserId"] as? String, !account.isEmpty,
          let client = p["clientId"] as? String, !client.isEmpty,
          let nonce = p["nonce"] as? String, nonce.range(of: "^[A-Za-z0-9_-]{43,512}$", options: .regularExpression) != nil else { throw Failure.invalid }
    switch p["type"] as? String {
    case "remoteControlClientConnection":
        guard p.count == 11, p["targetPath"] as? String == "/backend-api/codex/remote/control/client",
              p["audience"] as? String == "remote_control_client_websocket",
              p["scopes"] as? [String] == ["remote_control_controller_websocket"],
              let expiry = p["tokenExpiresAt"] as? NSNumber, expiry.doubleValue > Date().timeIntervalSince1970 else { throw Failure.invalid }
    case "remoteControlClientEnrollment":
        guard p.count == 10, p["audience"] as? String == "remote_control_client_enrollment",
              ["/backend-api/codex/remote/control/client/enroll/finish", "/backend-api/codex/remote/control/client/refresh/finish"].contains(p["targetPath"] as? String ?? "") else { throw Failure.invalid }
    default: throw Failure.invalid
    }
}
func output(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) { FileHandle.standardOutput.write(data) }
}
do {
    guard CommandLine.arguments.count == 2 else { throw Failure.invalid }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    guard data.count <= 32768, let input = try JSONSerialization.jsonObject(with: data) as? [String: Any], let op = input["operation"] as? String else { throw Failure.invalid }
    if op == "create" {
        stage = "create"
        guard let id = input["keyId"] as? String else { throw Failure.invalid }
        let lookup = try query(id)
        let existing = SecItemCopyMatching(lookup as CFDictionary, nil)
        guard existing == errSecItemNotFound else { try fail(existing == errSecSuccess ? errSecDuplicateItem : existing) }
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
            kSecUseDataProtectionKeychain as String: false, kSecAttrIsExtractable as String: false, kSecAttrIsSensitive as String: true,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrIsExtractable as String: false,
                kSecAttrApplicationTag as String: Data(("dev.codexteer.device-key." + id).utf8), kSecAttrLabel as String: "codexteer Remote Control"]]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            if let error = error?.takeRetainedValue() { throw error }; throw Failure.invalid
        }
        stage = "validate"
        output(["ok": true, "key": try metadata(key, id)])
    } else {
        guard ["inspect", "sign"].contains(op), let id = input["keyId"] as? String else { throw Failure.invalid }
        stage = "public-key"
        var q = try query(id); q[kSecReturnRef as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess else { try fail(status) }
        guard let item = item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw Failure.invalid }
        let key = item as! SecKey
        let info = try metadata(key, id)
        if op == "inspect" { output(["ok": true, "key": info]) }
        else {
            stage = "payload"
            guard let encoded = input["signedPayloadBase64"] as? String, let payload = Data(base64Encoded: encoded) else { throw Failure.invalid }
            try supportedPayload(payload)
            stage = "sign"
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, payload as CFData, &error) as Data? else {
                if let error = error?.takeRetainedValue() { throw error }; throw Failure.invalid
            }
            output(["ok": true, "signatureDerBase64": signature.base64EncodedString(), "key": info])
        }
    }
} catch {
    output(["ok": false, "stage": stage, "os_status": (error as NSError).code])
}
