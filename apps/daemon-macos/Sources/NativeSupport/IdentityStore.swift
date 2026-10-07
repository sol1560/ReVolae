import CuaRemoteProtocol
import Darwin
import Foundation

/// Keychain 保存完整的软件密钥记录，不宣称它们来自 Secure Enclave。
public enum IdentityStore {
    public static let service = "io.cuaremote.device.identity"

    public static func account(for path: String) throws -> String {
        guard path.hasPrefix("/"), !path.contains("\0") else { throw NativeFailure.unavailable("身份目录必须是绝对路径") }
        // Foundation 会把 /private/var 的现存目录缩写成 /var，与 Bun/Node realpath 不同。
        // 两端必须使用同一个真实目录作为 Keychain account，才能迁移、重启和准确清理。
        guard let resolved = realpath(path, nil) else { throw NativeFailure.unavailable("无法解析身份目录的真实路径") }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    public static func load(stateDirectory: String) throws -> Data? {
        guard let data = try KeychainData.read(service: service, account: account(for: stateDirectory)) else { return nil }
        _ = try object(data)
        return data
    }

    public static func save(_ data: Data, stateDirectory: String) throws {
        _ = try object(data)
        try KeychainData.write(data, service: service, account: account(for: stateDirectory))
    }

    public static func response(stateDirectory: String) throws -> Data {
        let identity: Any
        if let data = try load(stateDirectory: stateDirectory) { identity = try object(data) }
        else { identity = NSNull() }
        return try JSONSerialization.data(withJSONObject: ["identity": identity], options: [.sortedKeys])
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["deviceId"] is String, value["peers"] is [String: Any],
              let kem = value["kem"] as? [String: String], kem["publicKey"] != nil, kem["privateKey"] != nil,
              let sig = value["sig"] as? [String: String], sig["publicKey"] != nil, sig["privateKey"] != nil else {
            throw NativeFailure.unavailable("身份记录格式无效，未写入安全存储")
        }
        return value
    }
}
