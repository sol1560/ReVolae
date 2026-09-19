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
    case frameTooShort, badKind(UInt8), notControl, idTooLong, badRelayVersion, badMediaFlags(UInt8), badMediaSize
}

/// 与 approvalChallenge() 一致
public func approvalChallenge(runId: String, stepId: String, actionDetail: String, nonce: String, expiresAt: Int) -> String {
    let digest = SHA256.hash(data: Data(actionDetail.utf8)).map { String(format: "%02x", $0) }.joined()
    return ["cuaremote-approval-v1", runId, stepId, digest, nonce, String(expiresAt)].joined(separator: "\n")
}

public func approvalSignedPayload(_ challenge: String, allow: Bool) -> String {
    challenge + "\n" + (allow ? "allow" : "deny")
}

/// 与 terminalOpenChallenge() 一致：开终端的 challenge 套用审批格式
public func terminalOpenChallenge(sessionId: String, deviceId: String, nonce: String, expiresAt: Int) -> String {
    approvalChallenge(runId: "terminal", stepId: sessionId, actionDetail: "terminal.open\n" + deviceId, nonce: nonce, expiresAt: expiresAt)
}

// MARK: - 实时画面（kind=2 的 payload），与 media.ts 一致

/// [u8 flags][u32 pts BE][u16 width BE][u16 height BE][data]；flags bit0 关键帧、bit1 带 SPS/PPS
public struct MediaFrame: Sendable, Equatable {
    public static let headerBytes = 9
    public var keyframe: Bool
    public var hasParameterSets: Bool
    public var pts: UInt32
    public var width: UInt16
    public var height: UInt16
    public var data: Data

    public init(keyframe: Bool, hasParameterSets: Bool = false, pts: UInt32, width: UInt16, height: UInt16, data: Data) {
        self.keyframe = keyframe; self.hasParameterSets = hasParameterSets; self.pts = pts; self.width = width; self.height = height; self.data = data
    }

    public func encode() -> Data {
        var out = Data(capacity: Self.headerBytes + data.count)
        out.append((keyframe ? 1 : 0) | (hasParameterSets ? 2 : 0))
        for shift in stride(from: 24, through: 0, by: -8) { out.append(UInt8((pts >> UInt32(shift)) & 0xff)) }
        out.append(UInt8(width >> 8)); out.append(UInt8(width & 0xff))
        out.append(UInt8(height >> 8)); out.append(UInt8(height & 0xff))
        out.append(data)
        return out
    }

    public static func decode(_ d: Data) throws -> MediaFrame {
        guard d.count >= headerBytes else { throw ProtocolError.frameTooShort }
        let b = [UInt8](d.prefix(headerBytes))
        guard b[0] & ~3 == 0 else { throw ProtocolError.badMediaFlags(b[0]) }
        let pts = UInt32(b[1]) << 24 | UInt32(b[2]) << 16 | UInt32(b[3]) << 8 | UInt32(b[4])
        let w = UInt16(b[5]) << 8 | UInt16(b[6])
        let h = UInt16(b[7]) << 8 | UInt16(b[8])
        guard w > 0, h > 0 else { throw ProtocolError.badMediaSize }
        return MediaFrame(keyframe: b[0] & 1 == 1, hasParameterSets: b[0] & 2 == 2, pts: pts, width: w, height: h, data: d.dropFirst(headerBytes))
    }

    /// 与 mediaFrameIsNewer() 一致：u32 回绕安全
    public static func isNewer(_ pts: UInt32, than last: UInt32?) -> Bool {
        guard let last else { return true }
        let d = pts &- last
        return d != 0 && d < 0x8000_0000
    }
}

/// Bonjour 局域网直连
public enum LanDiscovery {
    public static let serviceType = "_cuaremote._tcp"
    public static let protocolVersion = "1"
    public static func txtRecord(deviceId: String, name: String) -> [String: String] { ["id": deviceId, "v": protocolVersion, "n": name] }
    public static func usableDeviceId(txt: [String: String], paired: Set<String>) -> String? {
        guard let id = txt["id"], txt["v"] == protocolVersion, paired.contains(id) else { return nil }
        return id
    }
}
