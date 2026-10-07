import Foundation
import Security
import XCTest
@testable import NativeSupport

final class IdentityStoreTests: XCTestCase {
    func testActualKeychainMissingSaveUpdateAndInvalidInputPreservesRecord() throws {
        let path = FileManager.default.temporaryDirectory.appending(path: "cuaremote-keychain-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
        let account = try IdentityStore.account(for: path.path)
        defer {
            let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: IdentityStore.service, kSecAttrAccount as String: account] as CFDictionary)
            XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound, "只清理本测试的唯一 Keychain 条目")
            try? FileManager.default.removeItem(at: path)
        }
        XCTAssertNil(try IdentityStore.load(stateDirectory: path.path))
        let first = Data(#"{"deviceId":"test-only","kem":{"publicKey":"public-a","privateKey":"private-a"},"sig":{"publicKey":"public-b","privateKey":"private-b"},"peers":{},"extra":{"preserved":true}}"#.utf8)
        try IdentityStore.save(first, stateDirectory: path.path)
        XCTAssertEqual(try IdentityStore.load(stateDirectory: path.path), first)
        let updated = Data(#"{"deviceId":"test-only","kem":{"publicKey":"public-a","privateKey":"private-a"},"sig":{"publicKey":"public-b","privateKey":"private-b"},"peers":{"phone":{"kem":"c","sig":"d","sigAlg":"ES256"}}}"#.utf8)
        try IdentityStore.save(updated, stateDirectory: path.path)
        XCTAssertEqual(try IdentityStore.load(stateDirectory: path.path), updated)
        XCTAssertThrowsError(try IdentityStore.save(Data("[]".utf8), stateDirectory: path.path))
        XCTAssertThrowsError(try IdentityStore.save(Data("not json".utf8), stateDirectory: path.path))
        XCTAssertEqual(try IdentityStore.load(stateDirectory: path.path), updated)
    }

    func testCanonicalAccountResolvesSymlinkAndRejectsRelativePath() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let target = root.appending(path: "actual")
        let alias = root.appending(path: "alias")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: target)
        XCTAssertEqual(try IdentityStore.account(for: alias.path), try IdentityStore.account(for: target.path))
        XCTAssertThrowsError(try IdentityStore.account(for: "relative/path"))
        XCTAssertThrowsError(try IdentityStore.account(for: root.appending(path: "missing").path))
    }

    func testPrivateVarAccountIsNotRewrittenToConvenienceAlias() throws {
        let root = URL(fileURLWithPath: "/private/var/tmp/cuaremote-account-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(try IdentityStore.account(for: root.path), root.path)
        XCTAssertEqual(try IdentityStore.account(for: root.path.replacingOccurrences(of: "/private/var/", with: "/var/")), root.path)
    }
}
