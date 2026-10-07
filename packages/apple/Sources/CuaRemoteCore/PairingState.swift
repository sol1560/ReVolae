import CryptoKit
import Foundation
import Security
import CuaRemoteProtocol

public enum RemoteRole: Equatable, Sendable {
    case phone
    case device

    var protocolRole: HelloRole { self == .phone ? .phone : .device }
    var localPlatform: DevicePlatform { self == .phone ? .ios : .macos }
}

public struct TrustedPeer: Codable, Sendable {
    public let deviceId: String
    public let name: String
    public let pubKeys: PublicKeys

    public init(deviceId: String, name: String, pubKeys: PublicKeys) {
        self.deviceId = deviceId
        self.name = name
        self.pubKeys = pubKeys
    }
}

public enum PeerKeyAssessment: Equatable, Sendable {
    case trusted
    case untrusted
    case mismatch
}

public final class PeerTrustStore {
    private let store: any SecureValueStore
    private let prefix: String

    public init(identityId: String, hubURL: String, store: any SecureValueStore) {
        let namespace = Data("\(identityId)\n\(hubURL)".utf8)
        let digest = SHA256.hash(data: namespace).map { String(format: "%02x", $0) }.joined()
        self.store = store
        self.prefix = "peer-trust.\(digest)."
    }

    public func peer(_ deviceId: String) throws -> TrustedPeer? {
        guard let data = try store.data(forKey: prefix + deviceId) else { return nil }
        return try JSONDecoder().decode(TrustedPeer.self, from: data)
    }

    public func assess(deviceId: String, keys: PublicKeys) throws -> PeerKeyAssessment {
        guard let pinned = try peer(deviceId) else { return .untrusted }
        return Self.sameKeys(pinned.pubKeys, keys) ? .trusted : .mismatch
    }

    @discardableResult
    public func pin(_ peer: TrustedPeer) throws -> Bool {
        if let pinned = try self.peer(peer.deviceId) {
            guard Self.sameKeys(pinned.pubKeys, peer.pubKeys) else { return false }
            return true
        }
        try store.set(JSONEncoder().encode(peer), forKey: prefix + peer.deviceId)
        return true
    }

    public func remove(_ deviceId: String) throws {
        try store.removeValue(forKey: prefix + deviceId)
    }

    private static func sameKeys(_ lhs: PublicKeys, _ rhs: PublicKeys) -> Bool {
        lhs.kem == rhs.kem && lhs.sig == rhs.sig && lhs.sigAlg == rhs.sigAlg
    }
}

public struct PairReview: Sendable {
    public let deviceId: String
    public let phoneId: String
    public let phoneName: String
    public let phonePubKeys: PublicKeys
}

public enum PairResultDisposition: Equatable, Sendable {
    case committed
    case rejected
    case ignored
    case pinMismatch
}

public enum PairingError: Error, Equatable {
    case invalidHubURL
    case insecureHubURL
    case hubURLMismatch
    case invalidOffer
    case expiredOffer
    case wrongRole
    case invalidKeys
    case invalidHMAC
    case pendingRequestExists
    case noPendingRequest
    case confirmationAlreadySent
}

public enum HubURLPolicy {
    public static func validate(_ url: URL, allowInsecureLocalDevelopment: Bool) throws {
        guard let scheme = url.scheme?.lowercased(),
              let rawHost = url.host?.lowercased(),
              url.user == nil, url.password == nil else {
            throw PairingError.invalidHubURL
        }
        let host = rawHost.hasPrefix("[") && rawHost.hasSuffix("]")
            ? String(rawHost.dropFirst().dropLast())
            : rawHost
        if scheme == "wss" { return }
        guard scheme == "ws" else { throw PairingError.insecureHubURL }
        guard allowInsecureLocalDevelopment, isLocalHost(host) else {
            throw PairingError.insecureHubURL
        }
    }

    static func sameEndpoint(_ lhs: URL, _ rhs: URL) -> Bool {
        guard var a = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
              var b = URLComponents(url: rhs, resolvingAgainstBaseURL: false) else { return false }
        a.scheme = a.scheme?.lowercased()
        a.host = a.host?.lowercased()
        b.scheme = b.scheme?.lowercased()
        b.host = b.host?.lowercased()
        return a.url?.absoluteString == b.url?.absoluteString
    }

    private static func isLocalHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") || host == "::1" {
            return true
        }
        if host.contains(":") {
            let sections = host.components(separatedBy: "::")
            guard sections.count <= 2 else { return false }
            let groups = sections.flatMap { section in
                section.isEmpty ? [] : section.split(separator: ":", omittingEmptySubsequences: false)
            }
            guard groups.allSatisfy({ group in
                !group.isEmpty && group.count <= 4 && group.allSatisfy(\.isHexDigit)
            }) else { return false }
            if sections.count == 1 {
                guard groups.count == 8 else { return false }
            } else {
                guard groups.count < 8 else { return false }
            }
            if groups.count == 8,
               groups.dropLast().allSatisfy({ UInt16($0, radix: 16) == 0 }),
               UInt16(groups[7], radix: 16) == 1 {
                return true
            }
            guard let firstGroup = groups.first else { return false }
            guard let first = UInt16(firstGroup, radix: 16) else { return false }
            return (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { UInt8($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 169 && octets[1] == 254)
    }
}

public enum PairingCrypto {
    public static func hmac(secret: Data, deviceKem: Data, phoneKem: Data) -> Data {
        let key = SymmetricKey(data: secret)
        return Data(HMAC<SHA256>.authenticationCode(for: deviceKem + phoneKem, using: key))
    }

    public static func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count, !lhs.isEmpty else { return false }
        var difference: UInt8 = 0
        for (left, right) in zip(lhs, rhs) { difference |= left ^ right }
        return difference == 0
    }

    public static func hmacBase64(secret: String, deviceKem: String, phoneKem: String) throws -> String {
        guard let secretBytes = Data(base64Encoded: secret),
              let deviceBytes = Data(base64Encoded: deviceKem),
              let phoneBytes = Data(base64Encoded: phoneKem) else { throw PairingError.invalidOffer }
        return hmac(secret: secretBytes, deviceKem: deviceBytes, phoneKem: phoneBytes).base64EncodedString()
    }
}

public final class PairingCoordinator {
    private struct PendingDevice {
        let request: PairRequest
        var confirmationSent: Bool
    }

    private struct PendingPhone {
        let offer: PairOffer
        let phoneId: String
        let phoneName: String
    }

    private let role: RemoteRole
    private let identity: DeviceIdentity
    private let trust: PeerTrustStore
    private var deviceOffer: PairOffer?
    private var pendingDevice: PendingDevice?
    private var pendingPhone: PendingPhone?

    public init(role: RemoteRole, identity: DeviceIdentity, trust: PeerTrustStore) {
        self.role = role
        self.identity = identity
        self.trust = trust
    }

    public var pendingReview: PairReview? {
        guard let request = pendingDevice?.request else { return nil }
        return PairReview(
            deviceId: request.deviceId,
            phoneId: request.phoneId,
            phoneName: request.phoneName,
            phonePubKeys: request.phonePubKeys
        )
    }

    public func createOffer(hubURL: URL, name: String, now: Int, lifetime: Int = 300, allowInsecureLocalDevelopment: Bool) throws -> String {
        guard role == .device else { throw PairingError.wrongRole }
        try HubURLPolicy.validate(hubURL, allowInsecureLocalDevelopment: allowInsecureLocalDevelopment)
        guard now >= 0, lifetime > 0 else { throw PairingError.expiredOffer }
        let expiresAt = min(lifetime, 300)
        guard now <= Int.max - expiresAt else { throw PairingError.expiredOffer }
        var generator = SystemRandomNumberGenerator()
        let secret = Data((0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        let offer = PairOffer(
            hubURL: hubURL.absoluteString,
            deviceId: identity.deviceId,
            name: name,
            pubKeys: try identity.publicKeys,
            secret: secret.base64EncodedString(),
            expiresAt: now + expiresAt
        )
        deviceOffer = offer
        pendingDevice = nil
        return String(decoding: try JSONEncoder().encode(offer), as: UTF8.self)
    }

    public func acceptOffer(
        json: String,
        currentHubURL: URL,
        phoneName: String,
        now: Int,
        allowInsecureLocalDevelopment: Bool
    ) throws -> PairRequest {
        guard role == .phone else { throw PairingError.wrongRole }
        try HubURLPolicy.validate(currentHubURL, allowInsecureLocalDevelopment: allowInsecureLocalDevelopment)
        guard let data = json.data(using: .utf8),
              let offer = try? JSONDecoder().decode(PairOffer.self, from: data),
              let offerURL = URL(string: offer.hubURL) else { throw PairingError.invalidOffer }
        try HubURLPolicy.validate(offerURL, allowInsecureLocalDevelopment: allowInsecureLocalDevelopment)
        guard HubURLPolicy.sameEndpoint(offerURL, currentHubURL) else { throw PairingError.hubURLMismatch }
        guard now >= 0, offer.expiresAt > now, offer.expiresAt - now <= 300 else { throw PairingError.expiredOffer }
        guard validPublicKeys(offer.pubKeys),
              let secret = Data(base64Encoded: offer.secret), secret.count == 16 else {
            throw PairingError.invalidOffer
        }
        guard pendingPhone == nil else { throw PairingError.pendingRequestExists }
        let phoneKeys = try identity.publicKeys
        guard validPublicKeys(phoneKeys),
              let deviceKem = Data(base64Encoded: offer.pubKeys.kem),
              let phoneKem = Data(base64Encoded: phoneKeys.kem) else { throw PairingError.invalidKeys }
        let hmac = PairingCrypto.hmac(secret: secret, deviceKem: deviceKem, phoneKem: phoneKem).base64EncodedString()
        let request = PairRequest(
            id: UUID().uuidString.lowercased(),
            deviceId: offer.deviceId,
            phoneId: identity.deviceId,
            phoneName: phoneName,
            phonePubKeys: phoneKeys,
            hmac: hmac
        )
        pendingPhone = PendingPhone(offer: offer, phoneId: identity.deviceId, phoneName: phoneName)
        return request
    }

    public func stageDeviceRequest(_ request: PairRequest, now: Int) throws -> PairReview {
        guard role == .device else { throw PairingError.wrongRole }
        guard pendingDevice == nil else { throw PairingError.pendingRequestExists }
        guard let offer = deviceOffer, offer.deviceId == request.deviceId else { throw PairingError.expiredOffer }
        guard offer.expiresAt > now else { throw PairingError.expiredOffer }
        guard validPublicKeys(request.phonePubKeys),
              let secret = Data(base64Encoded: offer.secret),
              let deviceKem = Data(base64Encoded: offer.pubKeys.kem),
              let phoneKem = Data(base64Encoded: request.phonePubKeys.kem),
              let supplied = Data(base64Encoded: request.hmac) else { throw PairingError.invalidKeys }
        let expected = PairingCrypto.hmac(secret: secret, deviceKem: deviceKem, phoneKem: phoneKem)
        guard PairingCrypto.constantTimeEqual(expected, supplied) else { throw PairingError.invalidHMAC }
        pendingDevice = PendingDevice(request: request, confirmationSent: false)
        return pendingReview!
    }

    public func confirmPair(deviceId: String, phoneId: String) throws -> PairConfirm {
        try confirmPair(deviceId: deviceId, phoneId: phoneId, now: Int(Date().timeIntervalSince1970))
    }

    func confirmPair(deviceId: String, phoneId: String, now: Int) throws -> PairConfirm {
        guard role == .device else { throw PairingError.wrongRole }
        guard var pending = pendingDevice,
              pending.request.deviceId == deviceId,
              pending.request.phoneId == phoneId else { throw PairingError.noPendingRequest }
        guard now >= 0, let offer = deviceOffer, offer.expiresAt > now else {
            pendingDevice = nil
            deviceOffer = nil
            throw PairingError.expiredOffer
        }
        guard !pending.confirmationSent else { throw PairingError.confirmationAlreadySent }
        pending.confirmationSent = true
        pendingDevice = pending
        return PairConfirm(
            id: UUID().uuidString.lowercased(),
            deviceId: deviceId,
            phoneId: phoneId,
            accept: true
        )
    }

    public func declinePair(deviceId: String, phoneId: String) throws -> PairConfirm {
        guard role == .device,
              let pending = pendingDevice,
              pending.request.deviceId == deviceId,
              pending.request.phoneId == phoneId else {
            throw PairingError.noPendingRequest
        }
        pendingDevice = nil
        deviceOffer = nil
        return PairConfirm(
            id: UUID().uuidString.lowercased(),
            deviceId: deviceId,
            phoneId: phoneId,
            accept: false
        )
    }

    public func apply(_ result: PairResult, now: Int) throws -> PairResultDisposition {
        if role == .device,
           let pending = pendingDevice,
           pending.confirmationSent,
           pending.request.deviceId == result.deviceId,
           pending.request.phoneId == result.phoneId {
            defer {
                pendingDevice = nil
                deviceOffer = nil
            }
            guard now >= 0, let offer = deviceOffer, offer.expiresAt > now, result.ok else { return .rejected }
            let peer = TrustedPeer(deviceId: result.phoneId, name: pending.request.phoneName, pubKeys: pending.request.phonePubKeys)
            return try trust.pin(peer) ? .committed : .pinMismatch
        }
        if role == .phone,
           let pending = pendingPhone,
           pending.offer.deviceId == result.deviceId,
           pending.phoneId == result.phoneId {
            defer { pendingPhone = nil }
            guard now >= 0, result.ok, pending.offer.expiresAt > now else { return .rejected }
            let peer = TrustedPeer(deviceId: result.deviceId, name: pending.offer.name, pubKeys: pending.offer.pubKeys)
            return try trust.pin(peer) ? .committed : .pinMismatch
        }
        return .ignored
    }

    public func removePeer(_ peerId: String) throws {
        try trust.remove(peerId)
        if pendingDevice?.request.phoneId == peerId { pendingDevice = nil }
        if pendingPhone?.offer.deviceId == peerId { pendingPhone = nil }
    }

    func discardPendingPhoneRequest() {
        pendingPhone = nil
    }

    public func assessPeerKeys(deviceId: String, keys: PublicKeys) throws -> PeerKeyAssessment {
        try trust.assess(deviceId: deviceId, keys: keys)
    }

    private func validPublicKeys(_ keys: PublicKeys) -> Bool {
        guard keys.sigAlg == .eS256,
              let kem = Data(base64Encoded: keys.kem),
              let signature = Data(base64Encoded: keys.sig) else { return false }
        return kem.count == 32 && signature.count == 65
    }
}
