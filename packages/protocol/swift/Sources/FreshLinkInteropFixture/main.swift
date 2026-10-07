import Foundation
import CryptoKit
import CuaRemoteProtocol

@main
struct FreshLinkInteropFixture {
    static func main() async throws {
        let phoneId = "phone-swift-fixture"
        let macId = "mac-swift-fixture"
        let phonePrivateData = Data(repeating: 0x21, count: 32)
        let macPrivateData = Data(repeating: 0x22, count: 32)
        let phonePrivate = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: phonePrivateData)
        let macPrivate = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: macPrivateData)
        let phoneNonce = String(repeating: "44", count: 32)
        let macLink = try FreshLink(
            selfId: macId,
            selfPrivateKey: macPrivateData,
            peerId: phoneId,
            peerPublicKey: phonePrivate.publicKey.rawRepresentation,
            testNonce: Data(repeating: 0x32, count: 32)
        )
        let macHello = try await macLink.hello()
        let macNonce = try handshakeField("nonce", from: macHello)

        let phoneHello = try RelayEnvelope(
            to: macId,
            from: phoneId,
            encrypted: false,
            body: JSONSerialization.data(withJSONObject: ["v": 2, "type": "hello", "nonce": phoneNonce])
        ).encode()
        let macKeyReply = try await macLink.receive(phoneHello)
        guard let macKey = macKeyReply.reply else { throw FixtureError.missingReply }
        let macEnc = try handshakeField("enc", from: macKey)

        let info = try freshLinkInfo(from: phoneId, to: macId, senderNonce: phoneNonce, receiverNonce: macNonce)
        let phoneSender = try HPKE.Sender(
            recipientKey: macPrivate.publicKey,
            ciphersuite: .Curve25519_SHA256_ChachaPoly,
            info: info,
            authenticatedBy: phonePrivate
        )
        let phoneKeyBody = try JSONSerialization.data(withJSONObject: [
            "v": 2,
            "type": "key",
            "nonce": phoneNonce,
            "peerNonce": macNonce,
            "enc": phoneSender.encapsulatedKey.lowercaseHex,
        ])
        let phoneKey = try RelayEnvelope(to: macId, from: phoneId, encrypted: false, body: phoneKeyBody).encode()
        _ = try await macLink.receive(phoneKey)

        let encrypted = try await macLink.seal(Data([0, 0, 0, 0, 0, 0x42]))
        let signingPrivate = try P256.Signing.PrivateKey(rawRepresentation: Data(repeating: 0x01, count: 32))
        let authPayload = "cuaremote-hub-auth-v1\nswift-fixture\ntest-nonce"
        let authSignature = try signingPrivate.signature(for: Data(authPayload.utf8))

        let result: [String: String] = [
            "phoneId": phoneId,
            "macId": macId,
            "phonePrivate": phonePrivateData.lowercaseHex,
            "phonePublic": phonePrivate.publicKey.rawRepresentation.lowercaseHex,
            "macPublic": macPrivate.publicKey.rawRepresentation.lowercaseHex,
            "macEnc": macEnc,
            "macNonce": macNonce,
            "phoneNonce": phoneNonce,
            "ciphertext": encrypted.lowercaseHex,
            "authPayload": authPayload,
            "authPublicKey": signingPrivate.publicKey.rawRepresentation.base64EncodedString(),
            "authSignature": authSignature.rawRepresentation.base64EncodedString(),
        ]
        let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(decoding: json, as: UTF8.self))
    }

    private static func handshakeField(_ field: String, from bytes: Data) throws -> String {
        let envelope = try RelayEnvelope.decode(bytes)
        let object = try JSONSerialization.jsonObject(with: envelope.body) as? [String: Any]
        guard let value = object?[field] as? String else { throw FixtureError.missingField(field) }
        return value
    }
}

private enum FixtureError: Error {
    case missingReply
    case missingField(String)
}

private extension Data {
    var lowercaseHex: String { map { String(format: "%02x", $0) }.joined() }
}
