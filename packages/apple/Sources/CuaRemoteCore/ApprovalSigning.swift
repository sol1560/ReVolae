import CryptoKit
import Foundation
import CuaRemoteProtocol

public enum ApprovalSigningError: Error, Equatable {
    case malformedRequest
    case challengeMismatch
    case expired
    case lifetimeTooLong
    case foreignDecision
    case untrustedSigner
    case unsupportedSignature
    case invalidSignature
}

public struct ApprovalChallengeInfo: Sendable, Equatable {
    public let nonce: String
    public let expiresAt: Int
}

public enum ApprovalSigning {
    public static func signDecision(
        for request: StepApprovalRequired,
        allow: Bool,
        identity: DeviceIdentity,
        now: Int = Int(Date().timeIntervalSince1970)
    ) throws -> ApprovalDecision {
        let fields = try validateRequest(request, now: now)
        guard isSafeIdentifier(identity.deviceId) else { throw ApprovalSigningError.malformedRequest }
        let payload = signedPayload(challenge: request.challenge, allow: allow)
        let signature = ApprovalSignature(
            alg: .eS256,
            keyId: identity.deviceId,
            sig: try identity.sign(payload),
            expiresAt: fields.expiresAt,
            nonce: fields.nonce
        )
        return ApprovalDecision(
            id: UUID().uuidString.lowercased(),
            runId: request.runId,
            stepId: request.stepId,
            allow: allow,
            remember: .once,
            signature: signature
        )
    }

    public static func verifyDecision(
        _ decision: ApprovalDecision,
        for request: StepApprovalRequired,
        owner: TrustedPeer,
        now: Int = Int(Date().timeIntervalSince1970)
    ) throws {
        let fields = try validateRequest(request, now: now)
        guard decision.runId == request.runId, decision.stepId == request.stepId,
              decision.remember == .once else {
            throw ApprovalSigningError.foreignDecision
        }
        guard let signature = decision.signature else { throw ApprovalSigningError.invalidSignature }
        guard signature.keyId == owner.deviceId else { throw ApprovalSigningError.untrustedSigner }
        guard signature.alg == .eS256, owner.pubKeys.sigAlg == .eS256 else {
            throw ApprovalSigningError.unsupportedSignature
        }
        guard signature.nonce == fields.nonce, signature.expiresAt == fields.expiresAt else {
            throw ApprovalSigningError.challengeMismatch
        }
        guard let publicKeyBytes = Data(base64Encoded: owner.pubKeys.sig),
              publicKeyBytes.count == 65,
              let signatureBytes = Data(base64Encoded: signature.sig),
              signatureBytes.count == 64,
              let publicKey = try? P256.Signing.PublicKey(x963Representation: publicKeyBytes),
              let rawSignature = try? P256.Signing.ECDSASignature(rawRepresentation: signatureBytes),
              publicKey.isValidSignature(rawSignature, for: signedPayload(challenge: request.challenge, allow: decision.allow)) else {
            throw ApprovalSigningError.invalidSignature
        }
    }

    @discardableResult
    public static func validateRequest(
        _ request: StepApprovalRequired,
        now: Int = Int(Date().timeIntervalSince1970)
    ) throws -> ApprovalChallengeInfo {
        guard isSafeIdentifier(request.runId), isSafeIdentifier(request.stepId) else {
            throw ApprovalSigningError.malformedRequest
        }
        let fields = request.challenge.components(separatedBy: "\n")
        guard fields.count == 6, fields[0] == "cuaremote-approval-v1",
              fields[1] == request.runId, fields[2] == request.stepId,
              isSafeNonce(fields[4]),
              let expiresAt = Int(fields[5]), String(expiresAt) == fields[5],
              expiresAt == request.expiresAt else {
            throw ApprovalSigningError.malformedRequest
        }
        let expected = [
            "cuaremote-approval-v1",
            request.runId,
            request.stepId,
            sha256Hex(request.action.detail),
            fields[4],
            String(expiresAt),
        ].joined(separator: "\n")
        guard request.challenge == expected else { throw ApprovalSigningError.challengeMismatch }
        guard expiresAt > now else { throw ApprovalSigningError.expired }
        let (lifetime, overflow) = expiresAt.subtractingReportingOverflow(now)
        guard !overflow, lifetime <= 300 else { throw ApprovalSigningError.lifetimeTooLong }
        return ApprovalChallengeInfo(nonce: fields[4], expiresAt: expiresAt)
    }

    private static func isSafeIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 255 && !value.contains("\n") && !value.contains("\r")
    }

    private static func isSafeNonce(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57)
                || ($0 >= 65 && $0 <= 90)
                || ($0 >= 97 && $0 <= 122)
                || $0 == 45
                || $0 == 95
        }
    }

    private static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func signedPayload(challenge: String, allow: Bool) -> Data {
        Data("\(challenge)\n\(allow ? "allow" : "deny")".utf8)
    }
}
