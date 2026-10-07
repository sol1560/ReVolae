import Combine
import CryptoKit
import Foundation
import CuaRemoteProtocol

public enum RemoteClientStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case failed(String)
}

public struct RemotePeerState: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var online: Bool
    public var ready: Bool

    public init(id: String, name: String, online: Bool, ready: Bool) {
        self.id = id
        self.name = name
        self.online = online
        self.ready = ready
    }
}

public enum RemoteSecurityEvent: Equatable, Sendable {
    case untrustedPeer(String)
    case peerKeyMismatch(String)
    case freshLinkFailed(String)
}

private actor AsyncSendGate {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

private struct ActivePeerLink {
    let token: UUID
    let generation: UInt64
    let freshLink: FreshLink
    let sendGate: AsyncSendGate
}

@MainActor
public final class RemoteClient: ObservableObject {
    private static let maximumWebSocketMessageBytes = 1_048_576

    @Published public private(set) var status: RemoteClientStatus = .disconnected
    @Published public private(set) var peers: [String: RemotePeerState] = [:]
    @Published public private(set) var pendingPairRequest: PairReview?

    public let role: RemoteRole
    public let identity: DeviceIdentity
    public var onHubMessage: (@MainActor (AnyMessage) -> Void)?
    public var onControl: (@MainActor (String, AnyMessage) -> Void)?
    public var onFrame: (@MainActor (String, Frame) -> Void)?
    public var onSecurityEvent: (@MainActor (RemoteSecurityEvent) -> Void)?
    public var onTransportEnded: (@MainActor () -> Void)?
    public var onPendingPairRequest: (@MainActor (PairReview) -> Void)?
    public var onPeerUnavailable: (@MainActor (String) -> Void)?

    private let name: String
    private let platform: DevicePlatform
    private let secureStore: any SecureValueStore
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var generation: UInt64 = 0
    private var currentHubURL: URL?
    private var allowInsecureLocalDevelopment = false
    private var authenticationChallengeReceived = false
    private var trustStore: PeerTrustStore?
    private var pairing: PairingCoordinator?
    private var links: [String: ActivePeerLink] = [:]
    private var blockedPeers: Set<String> = []

    public init(
        role: RemoteRole,
        name: String,
        identity: DeviceIdentity,
        store: any SecureValueStore = KeychainValueStore(),
        platform: DevicePlatform? = nil
    ) {
        self.role = role
        self.name = name
        self.identity = identity
        self.secureStore = store
        self.platform = platform ?? Self.defaultPlatform
    }

    public convenience init(
        role: RemoteRole,
        name: String,
        store: any SecureValueStore = KeychainValueStore(),
        platform: DevicePlatform? = nil
    ) throws {
        let identity = try DeviceIdentityRepository(store: store).loadOrCreate()
        self.init(role: role, name: name, identity: identity, store: store, platform: platform)
    }

    public var readyPeers: [RemotePeerState] {
        peers.values.filter(\.ready).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    public func connect(
        to hubURL: URL,
        token: String? = nil,
        allowInsecureLocalDevelopment: Bool = false
    ) async throws {
        try HubURLPolicy.validate(hubURL, allowInsecureLocalDevelopment: allowInsecureLocalDevelopment)
        closeTransport(notify: socket != nil)
        generation &+= 1
        let currentGeneration = generation
        self.currentHubURL = hubURL
        self.allowInsecureLocalDevelopment = allowInsecureLocalDevelopment
        self.authenticationChallengeReceived = false
        let trust = PeerTrustStore(identityId: identity.deviceId, hubURL: hubURL.absoluteString, store: secureStore)
        self.trustStore = trust
        self.pairing = PairingCoordinator(role: role, identity: identity, trust: trust)
        self.peers = [:]
        self.blockedPeers.removeAll()
        self.status = .connecting

        let urlSession = URLSession(configuration: .ephemeral)
        let task = urlSession.webSocketTask(with: hubURL)
        self.session = urlSession
        self.socket = task
        task.resume()
        status = .authenticating

        let hello = Hello(
            id: UUID().uuidString.lowercased(),
            role: role.protocolRole,
            deviceId: identity.deviceId,
            platform: platform,
            name: name,
            pubKeys: try identity.publicKeys,
            protocolVersion: 1,
            token: token
        )
        do {
            try await sendText(hello, generation: currentGeneration)
        } catch {
            if generation == currentGeneration { failClosed(error) }
            throw error
        }
        receiveLoop(task, generation: currentGeneration)
    }

    public func disconnect() {
        generation &+= 1
        let peerIds = Array(links.keys)
        closeTransport(notify: true)
        for peerId in peerIds { onPeerUnavailable?(peerId) }
        for key in peers.keys {
            peers[key]?.online = false
            peers[key]?.ready = false
        }
        status = .disconnected
    }

    public func send(_ message: AnyMessage, to peerId: String) async throws {
        try await sendFrame(Frame.control(message), to: peerId)
    }

    public func sendFrame(_ frame: Frame, to peerId: String) async throws {
        guard status == .connected, let link = links[peerId], peers[peerId]?.ready == true else {
            throw RemoteClientError.peerNotReady(peerId)
        }
        let currentGeneration = generation
        let encodedFrame = try frame.encode()
        guard encodedFrame.count <= Self.maximumWebSocketMessageBytes else {
            throw RemoteClientError.webSocketMessageTooLarge
        }
        await link.sendGate.acquire()
        do {
            guard currentGeneration == generation,
                  link.generation == currentGeneration,
                  links[peerId]?.token == link.token,
                  peers[peerId]?.ready == true,
                  let socket else {
                throw RemoteClientError.notConnected
            }
            let envelope = try await link.freshLink.seal(encodedFrame)
            guard currentGeneration == generation, links[peerId]?.token == link.token else {
                throw RemoteClientError.notConnected
            }
            try await socket.send(.data(envelope))
            await link.sendGate.release()
        } catch {
            await link.sendGate.release()
            if currentGeneration == generation, shouldFailClosed(error) { failClosed(error) }
            throw error
        }
    }

    public func makePairOffer(lifetime: Int = 300) throws -> String {
        guard role == .device, status == .connected, let hubURL = currentHubURL, let pairing else {
            throw PairingError.wrongRole
        }
        let offer = try pairing.createOffer(
            hubURL: hubURL,
            name: name,
            now: Int(Date().timeIntervalSince1970),
            lifetime: lifetime,
            allowInsecureLocalDevelopment: allowInsecureLocalDevelopment
        )
        pendingPairRequest = pairing.pendingReview
        return offer
    }

    public func acceptPairOffer(
        json: String,
        phoneName: String
    ) async throws {
        guard role == .phone, status == .connected, let hubURL = currentHubURL, let pairing else {
            throw RemoteClientError.notConnected
        }
        let request = try pairing.acceptOffer(
            json: json,
            currentHubURL: hubURL,
            phoneName: phoneName,
            now: Int(Date().timeIntervalSince1970),
            allowInsecureLocalDevelopment: allowInsecureLocalDevelopment
        )
        do {
            try await sendHub(.pairRequest(request))
        } catch {
            pairing.discardPendingPhoneRequest()
            throw error
        }
    }

    public func confirmPair(deviceId: String, phoneId: String) async throws {
        guard role == .device, status == .connected, let pairing else { throw RemoteClientError.notConnected }
        try await sendHub(.pairConfirm(pairing.confirmPair(deviceId: deviceId, phoneId: phoneId)))
    }

    public func declinePair(deviceId: String, phoneId: String) async throws {
        guard role == .device, status == .connected, let pairing else { throw RemoteClientError.notConnected }
        let confirmation = try pairing.declinePair(deviceId: deviceId, phoneId: phoneId)
        pendingPairRequest = nil
        try await sendHub(.pairConfirm(confirmation))
    }

    public func trustedPeer(deviceId: String) throws -> TrustedPeer? {
        try trustStore?.peer(deviceId)
    }

    public func unpair(_ peerId: String) async throws {
        guard status == .connected, let pairing else { throw RemoteClientError.notConnected }
        try pairing.removePeer(peerId)
        dropLink(peerId)
        peers[peerId]?.ready = false
        peers[peerId]?.online = false
        pendingPairRequest = pairing.pendingReview
        onPeerUnavailable?(peerId)
        try await sendHub(.deviceUnpair(DeviceUnpair(id: UUID().uuidString.lowercased(), deviceId: peerId)))
    }

    public func sendHub(_ message: AnyMessage) async throws {
        guard status == .connected else { throw RemoteClientError.notConnected }
        try await sendText(message, generation: generation)
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, generation expected: UInt64) {
        Task { @MainActor [weak self] in
            while let self, self.generation == expected {
                do {
                    let message = try await task.receive()
                    guard self.generation == expected else { return }
                    switch message {
                    case .string(let text):
                        guard text.utf8.count <= Self.maximumWebSocketMessageBytes else {
                            throw RemoteClientError.webSocketMessageTooLarge
                        }
                        try await self.handleHubText(Data(text.utf8), generation: expected)
                    case .data(let data):
                        guard data.count <= Self.maximumWebSocketMessageBytes else {
                            throw RemoteClientError.webSocketMessageTooLarge
                        }
                        try await self.handleRelay(data, generation: expected)
                    @unknown default:
                        throw RemoteClientError.unsupportedWebSocketMessage
                    }
                } catch {
                    guard self.generation == expected else { return }
                    self.failClosed(error)
                    return
                }
            }
        }
    }

    private func handleHubText(_ data: Data, generation expected: UInt64) async throws {
        let message = try JSONDecoder().decode(AnyMessage.self, from: data)
        switch message {
        case .authChallenge(let challenge):
            guard status == .authenticating, !authenticationChallengeReceived else {
                throw RemoteClientError.unexpectedHubMessage
            }
            authenticationChallengeReceived = true
            let payload = Data("cuaremote-hub-auth-v1\n\(identity.deviceId)\n\(challenge.nonce)".utf8)
            let response = AuthResponse(
                id: UUID().uuidString.lowercased(),
                nonce: challenge.nonce,
                signature: try identity.sign(payload)
            )
            try await sendText(response, generation: expected)
        case .authOk:
            guard status == .authenticating, authenticationChallengeReceived else {
                throw RemoteClientError.unexpectedHubMessage
            }
            status = .connected
        case .errorMsg(let error):
            onHubMessage?(message)
            if status == .authenticating {
                failClosed(RemoteClientError.authenticationRejected("\(error.code): \(error.message)"))
            }
        case .peerKeys(let peerKeys):
            try handlePeerKeys(peerKeys)
        case .presence(let presence):
            try await handlePresence(presence, generation: expected)
        case .pairRequest(let request):
            guard role == .device, let pairing else { return }
            let pending = try pairing.stageDeviceRequest(request, now: Int(Date().timeIntervalSince1970))
            pendingPairRequest = pending
            onPendingPairRequest?(pending)
        case .pairResult(let result):
            guard let pairing else { return }
            let disposition = try pairing.apply(result, now: Int(Date().timeIntervalSince1970))
            if disposition == .pinMismatch {
                let peerId = role == .device ? result.phoneId : result.deviceId
                blockPeer(peerId)
            }
            pendingPairRequest = pairing.pendingReview
        case .pairRemoved(let removed):
            guard removed.deviceId == identity.deviceId || removed.phoneId == identity.deviceId else { return }
            let peerId = removed.deviceId == identity.deviceId ? removed.phoneId : removed.deviceId
            try pairing?.removePeer(peerId)
            dropLink(peerId)
            peers[peerId] = nil
            pendingPairRequest = pairing?.pendingReview
            onPeerUnavailable?(peerId)
        default:
            onHubMessage?(message)
        }
        if case .authOk = message { onHubMessage?(message) }
        if case .presence = message { onHubMessage?(message) }
        if case .peerKeys = message { onHubMessage?(message) }
        if case .pairResult = message { onHubMessage?(message) }
        if case .pairRemoved = message { onHubMessage?(message) }
    }

    private func handlePeerKeys(_ message: PeerKeys) throws {
        guard !blockedPeers.contains(message.deviceId) else { return }
        guard let trustStore else { return }
        switch try trustStore.assess(deviceId: message.deviceId, keys: message.pubKeys) {
        case .trusted:
            let peer = try trustStore.peer(message.deviceId)
            var state = peers[message.deviceId] ?? RemotePeerState(id: message.deviceId, name: peer?.name ?? message.deviceId, online: false, ready: false)
            if let peer { state.name = peer.name }
            peers[message.deviceId] = state
        case .untrusted:
            dropLink(message.deviceId)
            onSecurityEvent?(.untrustedPeer(message.deviceId))
            onPeerUnavailable?(message.deviceId)
        case .mismatch:
            blockPeer(message.deviceId)
        }
    }

    private func handlePresence(_ message: Presence, generation expected: UInt64) async throws {
        if message.deviceId == identity.deviceId { return }
        guard !blockedPeers.contains(message.deviceId) else { return }
        guard let trustStore else { return }
        guard let peer = try trustStore.peer(message.deviceId) else {
            dropLink(message.deviceId)
            onSecurityEvent?(.untrustedPeer(message.deviceId))
            peers[message.deviceId] = RemotePeerState(id: message.deviceId, name: message.deviceId, online: false, ready: false)
            return
        }
        if !message.online {
            dropLink(message.deviceId)
            peers[message.deviceId] = RemotePeerState(id: message.deviceId, name: peer.name, online: false, ready: false)
            onPeerUnavailable?(message.deviceId)
            return
        }
        var state = peers[message.deviceId] ?? RemotePeerState(id: message.deviceId, name: peer.name, online: false, ready: false)
        let wasOnline = state.online
        state.online = true
        state.name = peer.name
        peers[message.deviceId] = state
        guard !wasOnline, links[message.deviceId] == nil else { return }
        let kem = try Self.decodeKey(peer.pubKeys.kem, length: 32)
        let link = try FreshLink(
            selfId: identity.deviceId,
            selfPrivateKey: identity.kemPrivateKey,
            peerId: message.deviceId,
            peerPublicKey: kem
        )
        let activeLink = ActivePeerLink(token: UUID(), generation: expected, freshLink: link, sendGate: AsyncSendGate())
        links[message.deviceId] = activeLink
        let hello = try await link.hello()
        try await sendLinkData(hello, to: message.deviceId, link: activeLink, generation: expected)
    }

    private func handleRelay(_ data: Data, generation expected: UInt64) async throws {
        let envelope = try RelayEnvelope.decode(data)
        guard envelope.to == identity.deviceId, let link = links[envelope.from] else {
            throw RemoteClientError.unknownPeer(envelope.from)
        }
        do {
            let received = try await link.freshLink.receive(data)
            guard expected == generation else { return }
            if let reply = received.reply {
                try await sendLinkData(reply, to: envelope.from, link: link, generation: expected)
            }
            var state = peers[envelope.from] ?? RemotePeerState(id: envelope.from, name: envelope.from, online: true, ready: false)
            state.ready = await link.freshLink.ready
            guard expected == generation, links[envelope.from]?.token == link.token else { return }
            peers[envelope.from] = state
            guard let bytes = received.frame else { return }
            let frame = try Frame.decode(bytes)
            if frame.kind == .control {
                onControl?(envelope.from, try frame.controlMessage())
            } else {
                onFrame?(envelope.from, frame)
            }
        } catch {
            dropLink(envelope.from)
            peers[envelope.from]?.ready = false
            onSecurityEvent?(.freshLinkFailed(envelope.from))
            onPeerUnavailable?(envelope.from)
            throw error
        }
    }

    private func sendText<T: Encodable>(_ message: T, generation expected: UInt64) async throws {
        guard expected == generation, let socket else { throw RemoteClientError.notConnected }
        let data = try JSONEncoder().encode(message)
        guard data.count <= Self.maximumWebSocketMessageBytes else {
            throw RemoteClientError.webSocketMessageTooLarge
        }
        do {
            try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        } catch {
            if expected == generation { failClosed(error) }
            throw error
        }
    }

    private func sendLinkData(
        _ data: Data,
        to peerId: String,
        link: ActivePeerLink,
        generation expected: UInt64
    ) async throws {
        guard data.count <= Self.maximumWebSocketMessageBytes else {
            throw RemoteClientError.webSocketMessageTooLarge
        }
        await link.sendGate.acquire()
        do {
            guard expected == generation,
                  link.generation == expected,
                  links[peerId]?.token == link.token,
                  let socket else {
                throw RemoteClientError.notConnected
            }
            try await socket.send(.data(data))
            await link.sendGate.release()
        } catch {
            await link.sendGate.release()
            if expected == generation, shouldFailClosed(error) { failClosed(error) }
            throw error
        }
    }

    private func shouldFailClosed(_ error: Error) -> Bool {
        guard let error = error as? RemoteClientError else { return true }
        switch error {
        case .notConnected, .peerNotReady, .webSocketMessageTooLarge:
            return false
        default:
            return true
        }
    }

    private func dropLink(_ peerId: String) {
        links[peerId] = nil
        peers[peerId]?.ready = false
    }

    private func blockPeer(_ peerId: String) {
        blockedPeers.insert(peerId)
        dropLink(peerId)
        peers[peerId]?.online = false
        onSecurityEvent?(.peerKeyMismatch(peerId))
        onPeerUnavailable?(peerId)
    }

    private func closeTransport(notify: Bool) {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
        links.removeAll()
        blockedPeers.removeAll()
        pendingPairRequest = nil
        authenticationChallengeReceived = false
        for key in peers.keys {
            peers[key]?.online = false
            peers[key]?.ready = false
        }
        if notify { onTransportEnded?() }
    }

    private func failClosed(_ error: Error) {
        generation &+= 1
        let peerIds = Array(links.keys)
        closeTransport(notify: true)
        for peerId in peerIds { onPeerUnavailable?(peerId) }
        status = .failed(String(describing: error))
    }

    private static func decodeKey(_ value: String, length: Int) throws -> Data {
        guard let data = Data(base64Encoded: value), data.count == length else { throw RemoteClientError.invalidPeerKey }
        return data
    }

    private static var defaultPlatform: DevicePlatform {
        #if os(iOS)
        return .ios
        #else
        return .macos
        #endif
    }
}

public enum RemoteClientError: Error, Equatable {
    case notConnected
    case peerNotReady(String)
    case unknownPeer(String)
    case invalidPeerKey
    case webSocketMessageTooLarge
    case unsupportedWebSocketMessage
    case unexpectedHubMessage
    case authenticationRejected(String)
}
