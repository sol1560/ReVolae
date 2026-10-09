import Foundation
import CryptoKit

public struct FreshLinkReceiveResult: Sendable {
    public let reply: Data?
    public let frame: Data?

    public init(reply: Data? = nil, frame: Data? = nil) {
        self.reply = reply
        self.frame = frame
    }
}

public func freshLinkInfo(from: String, to: String, senderNonce: String, receiverNonce: String) throws -> Data {
    try validateLinkId(from)
    try validateLinkId(to)
    guard isNonce(senderNonce), isNonce(receiverNonce) else { throw FreshLinkError.badNonce }
    return Data("cuaremote-link-v2\n\(from)\n\(to)\n\(senderNonce)\n\(receiverNonce)".utf8)
}

public enum FreshLinkError: Error, Equatable {
    case invalidIdentity
    case selfLink
    case badKey
    case badNonce
    case failed
    case helloAlreadySent
    case helloRequired
    case wrongRoute
    case unexpectedHandshake
    case handshakeTooLarge
    case unsupportedHandshake
}

public actor FreshLink {
    private let selfId: String
    private let peerId: String
    private let nonce: Data
    private let nonceHex: String
    private let selfPrivateKey: Curve25519.KeyAgreement.PrivateKey
    private let peerPublicKey: Curve25519.KeyAgreement.PublicKey
    private var helloSent = false
    private var peerNonce: String?
    private var sender: HPKE.Sender?
    private var recipient: HPKE.Recipient?
    private var failed = false

    public init(selfId: String, selfPrivateKey: Data, peerId: String, peerPublicKey: Data) throws {
        let nonce = Self.randomNonce()
        try Self.validate(selfId: selfId, selfPrivateKey: selfPrivateKey, peerId: peerId, peerPublicKey: peerPublicKey, nonce: nonce)
        self.selfId = selfId
        self.peerId = peerId
        self.nonce = nonce
        self.nonceHex = nonce.lowercaseHex
        self.selfPrivateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: selfPrivateKey)
        self.peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
    }

    package init(selfId: String, selfPrivateKey: Data, peerId: String, peerPublicKey: Data, testNonce: Data) throws {
        try Self.validate(selfId: selfId, selfPrivateKey: selfPrivateKey, peerId: peerId, peerPublicKey: peerPublicKey, nonce: testNonce)
        self.selfId = selfId
        self.peerId = peerId
        self.nonce = testNonce
        self.nonceHex = testNonce.lowercaseHex
        self.selfPrivateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: selfPrivateKey)
        self.peerPublicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
    }

    public var ready: Bool {
        !failed && sender != nil && recipient != nil
    }

    public func hello() throws -> Data {
        guard !failed else { throw FreshLinkError.failed }
        guard !helloSent else {
            failed = true
            throw FreshLinkError.helloAlreadySent
        }
        helloSent = true
        do {
            let body = try JSONEncoder().encode(HelloBody(v: 2, type: "hello", nonce: nonceHex))
            return try makeEnvelope(body)
        } catch {
            failed = true
            throw error
        }
    }

    public func receive(_ bytes: Data) async throws -> FreshLinkReceiveResult {
        guard !failed else { throw FreshLinkError.failed }
        do {
            let decoded = try RelayEnvelope.decodeWithHeader(bytes)
            let envelope = decoded.envelope
            guard envelope.from == peerId, envelope.to == selfId else { throw FreshLinkError.wrongRoute }
            if envelope.encrypted {
                guard ready, recipient != nil else { throw FreshLinkError.unexpectedHandshake }
                return FreshLinkReceiveResult(frame: try recipient!.open(envelope.body, authenticating: decoded.header))
            }
            guard helloSent else { throw FreshLinkError.helloRequired }
            guard envelope.body.count <= 1024 else { throw FreshLinkError.handshakeTooLarge }
            switch try parseHandshake(envelope.body) {
            case .hello(let remoteNonce):
                guard peerNonce == nil else { throw FreshLinkError.unexpectedHandshake }
                peerNonce = remoteNonce
                let info = try freshLinkInfo(from: selfId, to: peerId, senderNonce: nonceHex, receiverNonce: remoteNonce)
                let newSender = try HPKE.Sender(
                    recipientKey: peerPublicKey,
                    ciphersuite: .Curve25519_SHA256_ChachaPoly,
                    info: info,
                    authenticatedBy: selfPrivateKey
                )
                sender = newSender
                let body = try JSONEncoder().encode(KeyBody(v: 2, type: "key", nonce: nonceHex, peerNonce: remoteNonce, enc: newSender.encapsulatedKey.lowercaseHex))
                return FreshLinkReceiveResult(reply: try makeEnvelope(body))
            case .key(let remoteNonce, let receiverNonce, let enc):
                guard let peerNonce, recipient == nil, receiverNonce == nonceHex, remoteNonce == peerNonce else {
                    throw FreshLinkError.unexpectedHandshake
                }
                let info = try freshLinkInfo(from: peerId, to: selfId, senderNonce: remoteNonce, receiverNonce: nonceHex)
                recipient = try HPKE.Recipient(
                    privateKey: selfPrivateKey,
                    ciphersuite: .Curve25519_SHA256_ChachaPoly,
                    info: info,
                    encapsulatedKey: enc,
                    authenticatedBy: peerPublicKey
                )
                return FreshLinkReceiveResult()
            }
        } catch {
            failed = true
            throw error
        }
    }

    public func seal(_ frame: Data) throws -> Data {
        guard !failed else { throw FreshLinkError.failed }
        do {
            guard ready, sender != nil else { throw FreshLinkError.unexpectedHandshake }
            let header = try RelayEnvelope(to: peerId, from: selfId, encrypted: true, body: Data()).encode()
            let ciphertext = try sender!.seal(frame, authenticating: header)
            return try RelayEnvelope(to: peerId, from: selfId, encrypted: true, body: ciphertext).encode()
        } catch {
            failed = true
            throw error
        }
    }

    private func makeEnvelope(_ body: Data) throws -> Data {
        try RelayEnvelope(to: peerId, from: selfId, encrypted: false, body: body).encode()
    }

    private static func validate(selfId: String, selfPrivateKey: Data, peerId: String, peerPublicKey: Data, nonce: Data) throws {
        try validateLinkId(selfId)
        try validateLinkId(peerId)
        guard selfId != peerId else { throw FreshLinkError.selfLink }
        guard selfPrivateKey.count == 32, peerPublicKey.count == 32 else { throw FreshLinkError.badKey }
        guard nonce.count == 32 else { throw FreshLinkError.badNonce }
        _ = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: selfPrivateKey)
        _ = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerPublicKey)
        _ = try freshLinkInfo(from: selfId, to: peerId, senderNonce: nonce.lowercaseHex, receiverNonce: nonce.lowercaseHex)
    }

    private static func randomNonce() -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }
}

private enum ParsedHandshake {
    case hello(String)
    case key(nonce: String, peerNonce: String, enc: Data)
}

private struct HelloBody: Encodable {
    let v: Int
    let type: String
    let nonce: String
}

private struct KeyBody: Encodable {
    let v: Int
    let type: String
    let nonce: String
    let peerNonce: String
    let enc: String
}

private struct HelloFields: Decodable {
    let v: Int
    let type: String
    let nonce: String
}

private struct KeyFields: Decodable {
    let v: Int
    let type: String
    let nonce: String
    let peerNonce: String
    let enc: String
}

private func parseHandshake(_ data: Data) throws -> ParsedHandshake {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = object["type"] as? String,
          let version = object["v"] as? Int,
          version == 2
    else { throw FreshLinkError.unsupportedHandshake }
    switch type {
    case "hello":
        guard Set(object.keys) == Set(["v", "type", "nonce"]) else { throw FreshLinkError.unsupportedHandshake }
        let body = try JSONDecoder().decode(HelloFields.self, from: data)
        guard isNonce(body.nonce) else { throw FreshLinkError.badNonce }
        return .hello(body.nonce)
    case "key":
        guard Set(object.keys) == Set(["v", "type", "nonce", "peerNonce", "enc"]) else { throw FreshLinkError.unsupportedHandshake }
        let body = try JSONDecoder().decode(KeyFields.self, from: data)
        guard isNonce(body.nonce), isNonce(body.peerNonce), isNonce(body.enc) else { throw FreshLinkError.badNonce }
        return .key(nonce: body.nonce, peerNonce: body.peerNonce, enc: try Data(hex: body.enc))
    default:
        throw FreshLinkError.unsupportedHandshake
    }
}

private func validateLinkId(_ id: String) throws {
    let bytes = Data(id.utf8)
    guard !id.isEmpty, bytes.count <= 255, !id.contains("\r"), !id.contains("\n") else {
        throw FreshLinkError.invalidIdentity
    }
}

private func isNonce(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private extension Data {
    var lowercaseHex: String { map { String(format: "%02x", $0) }.joined() }

    init(hex: String) throws {
        guard isNonce(hex) else { throw FreshLinkError.badNonce }
        var output = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { throw FreshLinkError.badNonce }
            output.append(byte)
            index = next
        }
        self = output
    }
}
