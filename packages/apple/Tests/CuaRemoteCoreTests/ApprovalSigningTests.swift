import CryptoKit
import Foundation
import XCTest
@testable import CuaRemoteCore
import CuaRemoteProtocol

final class ApprovalSigningTests: XCTestCase {
    private final class MemoryStore: SecureValueStore {
        private var values: [String: Data] = [:]

        func data(forKey key: String) throws -> Data? { values[key] }
        func set(_ data: Data, forKey key: String) throws { values[key] = data }
        func removeValue(forKey key: String) throws { values[key] = nil }
    }

    func testSignsAndVerifiesAllowAndDenyOnceDecisions() throws {
        let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let owner = TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys)
        let request = makeRequest(now: 1_000)

        for allow in [true, false] {
            let decision = try ApprovalSigning.signDecision(for: request, allow: allow, identity: phone, now: 1_000)
            XCTAssertEqual(decision.remember, .once)
            XCTAssertEqual(decision.allow, allow)
            try ApprovalSigning.verifyDecision(decision, for: request, owner: owner, now: 1_001)
        }
    }

    func testRejectsExpiredLongLivedMalformedAndMismatchedChallenges() throws {
        let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let owner = TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys)
        let expired = makeRequest(now: 1_000, expiresAt: 999)
        let tooLong = makeRequest(now: 1_000, expiresAt: 1_301)
        let malformedNonce = makeRequest(now: 1_000, nonce: "nonce\ninjected")

        XCTAssertThrowsError(try ApprovalSigning.signDecision(for: expired, allow: true, identity: phone, now: 1_000)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .expired)
        }
        XCTAssertThrowsError(try ApprovalSigning.signDecision(for: tooLong, allow: true, identity: phone, now: 1_000)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .lifetimeTooLong)
        }
        XCTAssertThrowsError(try ApprovalSigning.signDecision(for: malformedNonce, allow: true, identity: phone, now: 1_000)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .malformedRequest)
        }

        let request = makeRequest(now: 1_000)
        let decision = try ApprovalSigning.signDecision(for: request, allow: true, identity: phone, now: 1_000)
        var altered = request
        altered.action.detail += " changed"
        XCTAssertThrowsError(try ApprovalSigning.verifyDecision(decision, for: altered, owner: owner, now: 1_001)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .challengeMismatch)
        }
    }

    func testRejectsForeignAndTamperedSignaturesAndRememberAlways() throws {
        let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let other = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let request = makeRequest(now: 1_000)
        let decision = try ApprovalSigning.signDecision(for: request, allow: true, identity: phone, now: 1_000)
        let foreignOwner = TrustedPeer(deviceId: other.deviceId, name: "Other", pubKeys: try other.publicKeys)

        XCTAssertThrowsError(try ApprovalSigning.verifyDecision(decision, for: request, owner: foreignOwner, now: 1_001)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .untrustedSigner)
        }
        var tampered = decision
        tampered.signature?.sig = Data(repeating: 0, count: 64).base64EncodedString()
        XCTAssertThrowsError(try ApprovalSigning.verifyDecision(tampered, for: request, owner: TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys), now: 1_001)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .invalidSignature)
        }
        var always = decision
        always.remember = .always
        XCTAssertThrowsError(try ApprovalSigning.verifyDecision(always, for: request, owner: TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys), now: 1_001)) {
            XCTAssertEqual($0 as? ApprovalSigningError, .foreignDecision)
        }
    }

    private func makeRequest(
        now: Int,
        expiresAt: Int? = nil,
        nonce: String = "nonce_123"
    ) -> StepApprovalRequired {
        let expiry = expiresAt ?? now + 180
        let runId = "run-123"
        let stepId = "step-1"
        let detail = "write file /tmp/approval-test.txt"
        let digest = SHA256.hash(data: Data(detail.utf8)).map { String(format: "%02x", $0) }.joined()
        let challenge = [
            "cuaremote-approval-v1",
            runId,
            stepId,
            digest,
            nonce,
            String(expiry),
        ].joined(separator: "\n")
        return StepApprovalRequired(
            id: "approval-1",
            runId: runId,
            stepId: stepId,
            level: .l2,
            action: ConcreteAction(channel: .shell, summary: "Write file", detail: detail),
            reason: "Explicit approval required",
            expiresAt: expiry,
            challenge: challenge
        )
    }
}
