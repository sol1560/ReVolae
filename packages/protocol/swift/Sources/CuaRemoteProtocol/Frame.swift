// 手写，与 packages/protocol/src/frame.ts 保持一致。MIT。
import Foundation
import CryptoKit

public enum FrameKind: UInt8, Sendable {
    case control = 0, pty = 1, media = 2
}

public struct Frame: Sendable, Equatable {
    public var kind: FrameKind
    public var streamId: UInt32
    public var payload: Data
    public init(kind: FrameKind, streamId: UInt32, payload: Data) {
        self.kind = kind; self.streamId = streamId; self.payload = payload
    }

    public static let headerBytes = 5

    public func encode() -> Data {
        var d = Data(capacity: Frame.headerBytes + payload.count)
        d.append(kind.rawValue)
        var be = streamId.bigEndian
        withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        d.append(payload)
        return d
    }

    public static func decode(_ data: Data) throws -> Frame {
        guard data.count >= headerBytes else { throw ProtocolError.frameTooShort }
        let b = [UInt8](data.prefix(headerBytes))
        guard let kind = FrameKind(rawValue: b[0]) else { throw ProtocolError.badKind(b[0]) }
        let sid = UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4])
        return Frame(kind: kind, streamId: sid, payload: data.dropFirst(headerBytes))
    }

    public static func control<T: Encodable>(_ message: T, streamId: UInt32 = 0) throws -> Frame {
        Frame(kind: .control, streamId: streamId, payload: try JSONEncoder().encode(message))
    }

    public func controlMessage() throws -> AnyMessage {
        guard kind == .control else { throw ProtocolError.notControl }
        return try JSONDecoder().decode(AnyMessage.self, from: payload)
    }
}

public struct RelayEnvelope: Sendable, Equatable {
    public static let version: UInt8 = 1
    public var to: String
    public var from: String
    public var encrypted: Bool
    public var body: Data
    public init(to: String, from: String, encrypted: Bool, body: Data) {
        self.to = to; self.from = from; self.encrypted = encrypted; self.body = body
    }

    public func encode() throws -> Data {
        let t = Data(to.utf8), f = Data(from.utf8)
        guard t.count <= 255, f.count <= 255 else { throw ProtocolError.idTooLong }
        var d = Data()
        d.append(RelayEnvelope.version)
        d.append(UInt8(t.count)); d.append(t)
        d.append(UInt8(f.count)); d.append(f)
        d.append(encrypted ? 1 : 0)
        d.append(body)
        return d
    }

    public static func decode(_ data: Data) throws -> RelayEnvelope {
        var i = data.startIndex
        func next() throws -> UInt8 { guard i < data.endIndex else { throw ProtocolError.frameTooShort }; defer { i += 1 }; return data[i] }
        guard try next() == version else { throw ProtocolError.badRelayVersion }
        let tl = Int(try next()); guard data.distance(from: i, to: data.endIndex) >= tl else { throw ProtocolError.frameTooShort }
        let to = String(decoding: data[i..<i+tl], as: UTF8.self); i += tl
        let fl = Int(try next()); guard data.distance(from: i, to: data.endIndex) >= fl else { throw ProtocolError.frameTooShort }
        let from = String(decoding: data[i..<i+fl], as: UTF8.self); i += fl
        let flags = try next()
        return RelayEnvelope(to: to, from: from, encrypted: flags & 1 == 1, body: Data(data[i...]))
    }
}

public enum ProtocolError: Error, Equatable {
    case frameTooShort, badKind(UInt8), notControl, idTooLong, badRelayVersion
}

/// 与 approvalChallenge() 一致
public func approvalChallenge(runId: String, stepId: String, actionDetail: String, nonce: String, expiresAt: Int) -> String {
    let digest = SHA256.hash(data: Data(actionDetail.utf8)).map { String(format: "%02x", $0) }.joined()
    return ["cuaremote-approval-v1", runId, stepId, digest, nonce, String(expiresAt)].joined(separator: "\n")
}

public func approvalSignedPayload(_ challenge: String, allow: Bool) -> String {
    challenge + "\n" + (allow ? "allow" : "deny")
}
