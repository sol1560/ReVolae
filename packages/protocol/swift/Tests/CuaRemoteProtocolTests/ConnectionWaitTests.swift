import CryptoKit
import XCTest
@testable import CuaRemoteProtocol

final class ConnectionWaitTests: XCTestCase {
    @MainActor
    func testAllConcurrentSendersWaitForHandshake() async throws {
        let a = Curve25519.KeyAgreement.PrivateKey(), b = Curve25519.KeyAgreement.PrivateKey()
        let session = PhoneConnection.PeerLink(try EncryptedLink(selfID: "a", privateKey: a,
            peerID: "b", peerKey: b.publicKey.rawRepresentation))
        let peer = try EncryptedLink(selfID: "b", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        var entered = 0, completed = 0
        let first = Task { @MainActor in
            entered += 1; try await session.waitUntilReady(); completed += 1
        }
        let second = Task { @MainActor in
            entered += 1; try await session.waitUntilReady(); completed += 1
        }
        while entered < 2 { await Task.yield() }
        XCTAssertEqual(completed, 0)
        _ = try session.crypto.open(peer.handshake())
        session.handshakeReceived()
        try await first.value; try await second.value
        XCTAssertEqual(completed, 2)
    }

    @MainActor
    func testDisconnectFailsWaitingAndFutureSendersImmediately() async throws {
        let key = Curve25519.KeyAgreement.PrivateKey(), peer = Curve25519.KeyAgreement.PrivateKey()
        let session = PhoneConnection.PeerLink(try EncryptedLink(selfID: "a", privateKey: key,
            peerID: "b", peerKey: peer.publicKey.rawRepresentation))
        var entered = false
        let waiting = Task { @MainActor in
            entered = true
            do { try await session.waitUntilReady(); return false }
            catch { return error.localizedDescription == "加密会话已断开" }
        }
        while !entered { await Task.yield() }
        session.invalidate()
        let failed = await waiting.value
        XCTAssertTrue(failed)
        do { try await session.waitUntilReady(); XCTFail("已断线会话不能继续等待") }
        catch { XCTAssertEqual(error.localizedDescription, "加密会话已断开") }
        session.handshakeReceived() // 迟到的握手不能重复恢复 continuation。
    }

    @MainActor
    func testTimeoutAndCancellationDoNotResumeAgainOnHandshake() async throws {
        let key = Curve25519.KeyAgreement.PrivateKey(), peer = Curve25519.KeyAgreement.PrivateKey()
        let session = PhoneConnection.PeerLink(try EncryptedLink(selfID: "a", privateKey: key,
            peerID: "b", peerKey: peer.publicKey.rawRepresentation))
        do { try await session.waitUntilReady(timeout: .milliseconds(10)); XCTFail("必须有握手超时") }
        catch { XCTAssertTrue(error.localizedDescription.contains("超时")) }
        var entered = false
        let waiting = Task { @MainActor in
            entered = true
            do { try await session.waitUntilReady(); return false }
            catch { return error is CancellationError }
        }
        while !entered { await Task.yield() }
        waiting.cancel()
        let cancelled = await waiting.value
        XCTAssertTrue(cancelled)
        session.handshakeReceived()
        session.invalidate()
    }
}
