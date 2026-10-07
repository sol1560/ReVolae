import XCTest
import CryptoKit
@testable import CuaRemoteProtocol

final class CryptoTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Key: Decodable { var id: String; var pk: String; var sk: String; var nonce: String }
        var phone: Key; var mac: Key
        var phoneHandshake: String; var macHandshake: String
        var phoneToMac: [String]; var plaintexts: [String]
        var macToPhone: String; var macToPhonePlaintext: String
    }

    func testTypeScriptHPKEVectorsBothDirectionsAndSequence() throws {
        let url = Bundle.module.url(forResource: "hpke", withExtension: "json", subdirectory: "fixtures")!
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        var mac = try EncryptedLink(selfID: f.mac.id, privateKey: .init(rawRepresentation: Data(hex: f.mac.sk)),
                                    peerID: f.phone.id, peerKey: Data(hex: f.phone.pk), nonce: Data(hex: f.mac.nonce))
        XCTAssertNil(try mac.open(Data(hex: f.phoneHandshake)))
        for (cipher, plain) in zip(f.phoneToMac, f.plaintexts) {
            XCTAssertEqual(try mac.open(Data(hex: cipher))?.encode(), Data(hex: plain))
        }
        XCTAssertThrowsError(try mac.open(Data(hex: f.phoneToMac[0])))
        XCTAssertThrowsError(try mac.open(Data(hex: f.phoneHandshake)))
        var phone = try EncryptedLink(selfID: f.phone.id, privateKey: .init(rawRepresentation: Data(hex: f.phone.sk)),
                                      peerID: f.mac.id, peerKey: Data(hex: f.mac.pk), nonce: Data(hex: f.phone.nonce))
        XCTAssertNil(try phone.open(Data(hex: f.macHandshake)))
        XCTAssertEqual(try phone.open(Data(hex: f.macToPhone))?.encode(), Data(hex: f.macToPhonePlaintext))
    }

    func testAuthenticationRejectsWrongPeerAndModifiedCiphertext() throws {
        let a = Curve25519.KeyAgreement.PrivateKey(), b = Curve25519.KeyAgreement.PrivateKey()
        var sender = try EncryptedLink(selfID: "a", privateKey: a, peerID: "b", peerKey: b.publicKey.rawRepresentation)
        var receiver = try EncryptedLink(selfID: "b", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        XCTAssertNil(try receiver.open(sender.handshake()))
        XCTAssertNil(try sender.open(receiver.handshake()))
        let frame = Frame(kind: .control, streamId: 17, payload: Data("asymmetric payload".utf8))
        let cipher = try sender.seal(frame)
        var modified = cipher; modified[modified.count - 1] ^= 1
        XCTAssertThrowsError(try receiver.open(modified))
        XCTAssertEqual(try receiver.open(cipher), frame)
        var wrong = try EncryptedLink(selfID: "other", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        XCTAssertThrowsError(try wrong.open(sender.handshake()))
    }

    func testCompleteRecordedSessionCannotBeReplayedAfterRestart() throws {
        let a = Curve25519.KeyAgreement.PrivateKey(), b = Curve25519.KeyAgreement.PrivateKey()
        var sender = try EncryptedLink(selfID: "a", privateKey: a, peerID: "b", peerKey: b.publicKey.rawRepresentation)
        var original = try EncryptedLink(selfID: "b", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        let handshake = try sender.handshake()
        _ = try original.open(handshake)
        _ = try sender.open(original.handshake())
        let frame = Frame(kind: .control, streamId: 17, payload: Data("execute once".utf8))
        let captured = try sender.seal(frame)
        XCTAssertEqual(try original.open(captured), frame)
        var restarted = try EncryptedLink(selfID: "b", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        let oldNonce = try RelayEnvelope.decode(original.handshake()).body.suffix(32)
        let newNonce = try RelayEnvelope.decode(restarted.handshake()).body.suffix(32)
        XCTAssertNotEqual(oldNonce, newNonce)
        XCTAssertNil(try restarted.open(handshake))
        XCTAssertThrowsError(try restarted.open(captured))
    }

    func testV1AndModifiedNonceAreRejectedAndSendNeedsPeerHandshake() throws {
        let a = Curve25519.KeyAgreement.PrivateKey(), b = Curve25519.KeyAgreement.PrivateKey()
        var sender = try EncryptedLink(selfID: "a", privateKey: a, peerID: "b", peerKey: b.publicKey.rawRepresentation)
        var receiver = try EncryptedLink(selfID: "b", privateKey: b, peerID: "a", peerKey: a.publicKey.rawRepresentation)
        let frame = Frame(kind: .control, streamId: 7, payload: Data("do not execute".utf8))
        XCTAssertThrowsError(try sender.seal(frame))
        var legacy = try RelayEnvelope.decode(sender.handshake())
        legacy.body = Data(legacy.body.dropFirst().prefix(32))
        XCTAssertThrowsError(try receiver.open(legacy.encode()))
        XCTAssertFalse(receiver.ready)
        _ = try receiver.open(sender.handshake())
        var modified = try receiver.handshake()
        modified[modified.count - 1] ^= 1
        _ = try sender.open(modified)
        XCTAssertThrowsError(try receiver.open(sender.seal(frame)))
        XCTAssertThrowsError(try receiver.open(sender.handshake()))
    }

    func testApprovalValidatesDisplayedCommandAndExpiry() throws {
        let expiry = 101
        let action = ConcreteAction(channel: .shell, summary: "read", detail: "cat /tmp/a")
        var request = StepApprovalRequired(id: "id", runId: "run", stepId: "step", level: .l2,
            action: action, reason: "确认", expiresAt: expiry,
            challenge: approvalChallenge(runId: "run", stepId: "step", actionDetail: action.detail, nonce: "nonce", expiresAt: expiry))
        XCTAssertEqual(try validateApproval(request, now: 100), "nonce")
        XCTAssertThrowsError(try validateApproval(request, now: 101))
        request.action.detail = "rm /tmp/a"
        XCTAssertThrowsError(try validateApproval(request, now: 100))
    }

    func testTypeScriptP256SignaturesBindAllowAndDeny() throws {
        struct Vector: Decodable { var alg: String; var publicKey: String; var challenge: String; var signature: ApprovalSignature; var denySignature: ApprovalSignature }
        struct Vectors: Decodable { var vectors: [Vector] }
        let url = Bundle.module.url(forResource: "approval", withExtension: "json", subdirectory: "fixtures")!
        let vector = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).vectors.first { $0.alg == "ES256" }!
        let key = try P256.Signing.PublicKey(x963Representation: Data(hex: vector.publicKey))
        let allowed = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: vector.signature.sig)!)
        let denied = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: vector.denySignature.sig)!)
        XCTAssertTrue(key.isValidSignature(allowed, for: Data(approvalSignedPayload(vector.challenge, allow: true).utf8)))
        XCTAssertTrue(key.isValidSignature(denied, for: Data(approvalSignedPayload(vector.challenge, allow: false).utf8)))
        XCTAssertFalse(key.isValidSignature(allowed, for: Data(approvalSignedPayload(vector.challenge, allow: false).utf8)))
    }
}
