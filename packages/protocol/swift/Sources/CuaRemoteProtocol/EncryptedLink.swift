import CryptoKit
import Foundation

public enum ConnectionError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? {
        switch self { case .invalid(let reason): reason }
    }
}

/// 每个方向独立维护 HPKE 计数器，与 hpke.ts 的 Auth 模式一致。
public struct EncryptedLink: Sendable {
    public let selfID: String
    public let peerID: String
    private let privateKey: Curve25519.KeyAgreement.PrivateKey
    private let peerKey: Curve25519.KeyAgreement.PublicKey
    private var sender: HPKE.Sender
    private var recipient: HPKE.Recipient?
    private let nonce: Data
    private var peerNonce: Data?

    public init(selfID: String, privateKey: Curve25519.KeyAgreement.PrivateKey, peerID: String, peerKey: Data) throws {
        try self.init(selfID: selfID, privateKey: privateKey, peerID: peerID, peerKey: peerKey,
                      nonce: SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }

    // 固定随机数仅供模块内互通向量测试；公开构造器总是使用系统随机数。
    init(selfID: String, privateKey: Curve25519.KeyAgreement.PrivateKey, peerID: String, peerKey: Data, nonce: Data) throws {
        guard nonce.count == 32 else { throw ConnectionError.invalid("握手随机数必须为 32 字节") }
        self.selfID = selfID
        self.peerID = peerID
        self.privateKey = privateKey
        self.peerKey = try .init(rawRepresentation: peerKey)
        self.nonce = nonce
        sender = try HPKE.Sender(recipientKey: self.peerKey, ciphersuite: .Curve25519_SHA256_ChachaPoly,
                                 info: Data("cuaremote-v2|\(selfID)|\(peerID)".utf8), authenticatedBy: privateKey)
    }

    public var ready: Bool { recipient != nil }

    public func handshake() throws -> Data {
        try RelayEnvelope(to: peerID, from: selfID, encrypted: false, body: Data([2]) + sender.encapsulatedKey + nonce).encode()
    }

    public mutating func seal(_ frame: Frame) throws -> Data {
        guard let peerNonce else { throw ConnectionError.invalid("对端尚未完成加密握手") }
        let header = try RelayEnvelope(to: peerID, from: selfID, encrypted: true, body: Data()).encode()
        return header + (try sender.seal(peerNonce + frame.encode(), authenticating: header))
    }

    public mutating func open(_ bytes: Data) throws -> Frame? {
        let envelope = try RelayEnvelope.decode(bytes)
        guard envelope.to == selfID, envelope.from == peerID else { throw ConnectionError.invalid("加密消息的收发设备不匹配") }
        if !envelope.encrypted {
            guard recipient == nil, envelope.body.count == 65, envelope.body.first == 2 else { throw ConnectionError.invalid("重复或无效的 v2 加密握手") }
            recipient = try HPKE.Recipient(privateKey: privateKey, ciphersuite: .Curve25519_SHA256_ChachaPoly,
                info: Data("cuaremote-v2|\(peerID)|\(selfID)".utf8), encapsulatedKey: envelope.body.dropFirst().prefix(32), authenticatedBy: peerKey)
            peerNonce = Data(envelope.body.suffix(32))
            return nil
        }
        guard var opener = recipient else { throw ConnectionError.invalid("对端尚未完成加密握手") }
        let header = bytes.prefix(bytes.count - envelope.body.count)
        let plaintext = try opener.open(envelope.body, authenticating: header)
        guard plaintext.count >= 32 + Frame.headerBytes, plaintext.prefix(32) == nonce else {
            throw ConnectionError.invalid("密文不属于本次连接，拒绝旧会话重放")
        }
        recipient = opener
        return try Frame.decode(plaintext.dropFirst(32))
    }
}

public func pairingHMAC(secret: String, deviceKey: String, phoneKey: String) throws -> String {
    guard let key = Data(base64Encoded: secret), key.count >= 16,
          let device = Data(base64Encoded: deviceKey), device.count == 32,
          let phone = Data(base64Encoded: phoneKey), phone.count == 32 else {
        throw ConnectionError.invalid("配对密钥格式不正确")
    }
    return Data(HMAC<SHA256>.authenticationCode(for: device + phone, using: SymmetricKey(data: key))).base64EncodedString()
}

/// 在签名前重新计算显示的动作，避免 UI 展示内容和真正签名内容不一致。
public func validateApproval(_ request: StepApprovalRequired, now: Int = Int(Date().timeIntervalSince1970)) throws -> String {
    let parts = request.challenge.components(separatedBy: "\n")
    guard parts.count == 6, !parts[4].isEmpty,
          request.expiresAt > now,
          request.challenge == approvalChallenge(runId: request.runId, stepId: request.stepId,
            actionDetail: request.action.detail, nonce: parts[4], expiresAt: request.expiresAt) else {
        throw ConnectionError.invalid("批准请求已过期，或命令内容与签名不一致")
    }
    return parts[4]
}
