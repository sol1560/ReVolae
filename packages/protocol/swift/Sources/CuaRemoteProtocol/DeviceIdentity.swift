import CryptoKit
import Foundation
import Security

/// 私钥保存在本机 Keychain；支持时使用 Secure Enclave，不以测试开关跳过签名。
public struct DeviceIdentity: Sendable {
    public let id: String
    public let kem: Curve25519.KeyAgreement.PrivateKey
    private let software: P256.Signing.PrivateKey?
    private let enclave: SecureEnclave.P256.Signing.PrivateKey?
    public var hardwareBacked: Bool { enclave != nil }

    public var publicKeys: PublicKeys {
        PublicKeys(kem: kem.publicKey.rawRepresentation.base64EncodedString(),
                   sig: (enclave?.publicKey.x963Representation ?? software!.publicKey.x963Representation).base64EncodedString(), sigAlg: .eS256)
    }

    public func sign(_ text: String) throws -> String {
        let data = Data(text.utf8)
        let signature = try enclave?.signature(for: data) ?? software!.signature(for: data)
        return signature.rawRepresentation.base64EncodedString()
    }

    public func approve(_ request: StepApprovalRequired, allow: Bool) throws -> ApprovalDecision {
        let nonce = try validateApproval(request)
        let signature = ApprovalSignature(alg: .eS256, keyId: id,
            sig: try sign(approvalSignedPayload(request.challenge, allow: allow)), expiresAt: request.expiresAt, nonce: nonce)
        return ApprovalDecision(id: UUID().uuidString, runId: request.runId, stepId: request.stepId,
                                allow: allow, signature: signature)
    }

    private struct Stored: Codable {
        var id: String
        var kem: Data
        var signing: Data
        var enclave: Bool
    }

    public static func load(service: String) throws -> DeviceIdentity {
        // 模拟器可能访问宿主安全芯片，但那不是被模拟的 iPhone 硬件。
        // 独立命名空间保留旧身份，不以认证失败为由替换密钥。
        #if targetEnvironment(simulator)
        let service = service + ".simulator-software"
        let useEnclave = false
        #else
        let useEnclave = SecureEnclave.isAvailable
        #endif
        let saved: Stored
        if let bytes = try KeychainData.read(service: service, account: "identity") {
            saved = try JSONDecoder().decode(Stored.self, from: bytes)
        } else {
            let kem = Curve25519.KeyAgreement.PrivateKey()
            let enclave = useEnclave ? try SecureEnclave.P256.Signing.PrivateKey() : nil
            saved = Stored(id: "phone-" + UUID().uuidString.lowercased(), kem: kem.rawRepresentation,
                signing: enclave?.dataRepresentation ?? P256.Signing.PrivateKey().rawRepresentation, enclave: enclave != nil)
            try KeychainData.write(JSONEncoder().encode(saved), service: service, account: "identity")
        }
        return try DeviceIdentity(id: saved.id, kem: .init(rawRepresentation: saved.kem),
            software: saved.enclave ? nil : .init(rawRepresentation: saved.signing),
            enclave: saved.enclave ? .init(dataRepresentation: saved.signing) : nil)
    }
}

public enum KeychainData {
    public static func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ConnectionError.invalid("无法读取安全存储：\(status)") }
        return data
    }

    public static func write(_ data: Data, service: String, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let result = SecItemAdd(item as CFDictionary, nil)
            guard result == errSecSuccess else { throw ConnectionError.invalid("无法保存到安全存储：\(result)") }
        } else if status != errSecSuccess { throw ConnectionError.invalid("无法更新安全存储：\(status)") }
    }
}
