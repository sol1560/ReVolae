import CryptoKit
import CuaRemoteProtocol
import XCTest
@testable import CuaRemote

/// 只读取现有身份和pin；清理仅本轮随机中继来源的历史，不生成替代身份。
@MainActor
final class ExistingCancellationPairingTests: XCTestCase {
    struct Snapshot: Codable {
        let identityHash: String
        let pinsHash: String
        let active: Data?
        let sourceDirectory: String
    }
    func testExistingPairingAndHistoryScopeLifecycle() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let marker = env["E2E_CANCEL_ID"] else { throw XCTSkip("未配置既有配对取消专项") }
        _ = try XCTUnwrap(UUID(uuidString: marker))
        func required(_ key: String) throws -> String { try XCTUnwrap(env[key]) }
        func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
        let phone = try required("E2E_PHONE_ID"), device = try required("E2E_DEVICE_ID")
        let identity = try XCTUnwrap(KeychainData.read(service: "dev.cuaremote.phone.simulator-software", account: "identity"), "原手机身份不存在，不创建替代身份")
        let pinsData = try XCTUnwrap(KeychainData.read(service: "dev.cuaremote.phone", account: "pairedKeys"), "原pin不存在，不插入替代pin")
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: identity) as? [String: Any])
        XCTAssertEqual(stored["id"] as? String, phone)
        let pins = try JSONDecoder().decode([String: PublicKeys].self, from: pinsData)
        let pin = try XCTUnwrap(pins[device], "local-10原设备pin已不可用，停止专项")
        XCTAssertEqual(pin.kem, try required("E2E_DEVICE_KEM")); XCTAssertEqual(pin.sig, try required("E2E_DEVICE_SIG"))
        XCTAssertEqual(pin.sigAlg, .eS256)
        let store = try HistoryStore()
        let scope = try HistoryStore.Scope(url: XCTUnwrap(URL(string: required("E2E_HUB_URL"))), phoneID: phone)
        let source = store.fileURL(scope: scope, deviceID: device).deletingLastPathComponent()
        let active = source.deletingLastPathComponent().appendingPathComponent("active.json")
        let backup = FileManager.default.temporaryDirectory.appendingPathComponent("cancel-live-" + marker + ".json")
        let phase = try required("E2E_CANCEL_PHASE")
        if phase == "before" {
            XCTAssertFalse(FileManager.default.fileExists(atPath: source.path), "本轮应使用新的中继来源，不覆盖已有历史")
            XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path), "不覆盖已有检查快照")
            let activeBytes = FileManager.default.fileExists(atPath: active.path) ? try Data(contentsOf: active) : nil
            let snapshot = Snapshot(identityHash: digest(identity), pinsHash: digest(pinsData), active: activeBytes, sourceDirectory: source.path)
            try JSONEncoder().encode(snapshot).write(to: backup, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
        } else {
            XCTAssertEqual(phase, "cleanup")
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: backup))
            XCTAssertEqual(snapshot.identityHash, digest(identity)); XCTAssertEqual(snapshot.pinsHash, digest(pinsData))
            // 模拟器重装保留数据但可更换容器UUID；核对手机与来源，不信任旧容器绝对路径。
            let savedSource = URL(fileURLWithPath: snapshot.sourceDirectory)
            XCTAssertEqual(savedSource.lastPathComponent, source.lastPathComponent)
            XCTAssertEqual(savedSource.deletingLastPathComponent().lastPathComponent, source.deletingLastPathComponent().lastPathComponent)
            if FileManager.default.fileExists(atPath: source.path) { try FileManager.default.removeItem(at: source) }
            if let bytes = snapshot.active {
                try bytes.write(to: active, options: [.atomic, .completeFileProtection])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: active.path)
                XCTAssertEqual(try Data(contentsOf: active), bytes)
            } else if FileManager.default.fileExists(atPath: active.path) { try FileManager.default.removeItem(at: active) }
            try FileManager.default.removeItem(at: backup)
            XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
        }
        let receipt: [String: Any] = ["phase": phase, "originalPhoneAndPinMatched": true,
            "identitySHA256": digest(identity), "pinsSHA256": digest(pinsData), "marker": marker,
            "sourceExists": FileManager.default.fileExists(atPath: source.path)]
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys, .prettyPrinted]), uniformTypeIdentifier: "public.json")
        attachment.name = "existing-cancel-pairing-" + phase; attachment.lifetime = .keepAlways; add(attachment)
        print("EXISTING_CANCEL_PAIRING_\(phase.uppercased())_PASS")
    }
}
