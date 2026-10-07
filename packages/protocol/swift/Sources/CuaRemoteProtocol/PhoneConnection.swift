import Darwin
import Foundation

/// WebSocket 登录使用设备签名；intent 和批准仅通过已固定公钥的 HPKE 链路发送。
@MainActor
public final class PhoneConnection {
    public let identity: DeviceIdentity
    /// 仅在本次链路通过 auth.ok 后提供；原地址可能含私有参数，不得直接持久化或展示。
    public private(set) var authenticatedURL: URL?
    public var onMessage: ((AnyMessage, String?) -> Void)?
    public var onStatus: ((String) -> Void)?
    public var onError: ((Error) -> Void)?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var writeTail: Task<Void, Error>?
    private var links: [String: PeerLink] = [:]
    private var pins: [String: PublicKeys]
    private var pendingOffer: PairOffer?
    private let service: String
    private var authenticated = false
    private var lastConnection: (url: URL, token: String)?
    private var retryTask: Task<Void, Never>?
    public private(set) var reconnecting = false
    public private(set) var reconnectAttempts = 0
    public var canReconnect: Bool { lastConnection != nil }

    public init(service: String = "dev.cuaremote.phone") throws {
        self.service = service
        identity = try DeviceIdentity.load(service: service)
        if let data = try KeychainData.read(service: service, account: "pairedKeys") {
            pins = try JSONDecoder().decode([String: PublicKeys].self, from: data)
        } else { pins = [:] }
    }

    public func connect(url: URL, token: String) async throws {
        guard ["wss", "ws"].contains(url.scheme), url.host != nil else { throw ConnectionError.invalid("请输入 ws:// 或 wss:// 中继地址") }
        // 非本机连接必须用 TLS，避免账号令牌在网络上明文传输。
        guard url.scheme == "wss" || ["localhost", "127.0.0.1", "::1"].contains(url.host!) else {
            throw ConnectionError.invalid("远程中继必须使用 wss:// 加密连接")
        }
        disconnect()
        reconnectAttempts = 0
        lastConnection = (url, token)
        try await open(url: url, token: token)
    }

    private func open(url: URL, token: String) async throws {
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.maximumMessageSize = 8 * 1024 * 1024
        task.resume()
        onStatus?(reconnecting ? "正在重新验证设备身份（第 \(reconnectAttempts) 次）" : "正在验证设备身份")
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                let packet: URLSessionWebSocketTask.Message
                do { packet = try await task.receive() }
                catch {
                    self?.failed(error, task: task, transport: true)
                    return
                }
                guard let self, self.socket === task else { return }
                do {
                    switch packet {
                    case .string(let text): try await self.receiveControl(JSONDecoder().decode(AnyMessage.self, from: Data(text.utf8)), task: task, url: url)
                    case .data(let data): try await self.receiveRelay(data)
                    @unknown default: throw ConnectionError.invalid("未知 WebSocket 消息")
                    }
                } catch {
                    self.failed(error, task: task, transport: false)
                    return
                }
            }
        }
        try await sendHub(Hello(id: UUID().uuidString, role: .phone, deviceId: identity.id, platform: .ios,
            name: "CuaRemote iPhone", pubKeys: identity.publicKeys, protocolVersion: 1, token: token.isEmpty ? nil : token))
    }

    public func disconnect() {
        retryTask?.cancel(); retryTask = nil
        reconnecting = false
        receiveTask?.cancel(); receiveTask = nil
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        writeTail?.cancel(); writeTail = nil
        for link in links.values { link.invalidate() }
        authenticated = false; links.removeAll(); pendingOffer = nil
        authenticatedURL = nil
        onStatus?("未连接")
    }

    private func failed(_ error: Error, task: URLSessionWebSocketTask, transport: Bool) {
        guard socket === task else { return }
        let retry = authenticated && transport && Self.canRetry(error, closeCode: task.closeCode.rawValue)
        disconnect()
        onError?(error)
        guard retry, let lastConnection else { return }
        let delays = [2, 4, 8, 16, 30]
        guard reconnectAttempts < delays.count else {
            onStatus?("自动重连已停止，请手动重新连接")
            return
        }
        let delay = delays[reconnectAttempts]
        reconnectAttempts += 1; reconnecting = true
        onStatus?("连接中断，\(delay) 秒后重连（\(reconnectAttempts)/5）")
        retryTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
                guard let self else { return }
                try await self.open(url: lastConnection.url, token: lastConnection.token)
            } catch {
                // 主动断开或更换连接会取消这次等待，不得影响新连接。
                guard !Task.isCancelled else { return }
                self?.onError?(error)
            }
        }
    }

    static func canRetry(_ error: Error, closeCode: Int) -> Bool {
        if [1001, 1006, 1012, 1013].contains(closeCode) { return true }
        // 正常关闭、认证拒绝和未知关闭码均停止；仅无关闭帧时按网络错误判断。
        guard closeCode == 0 else { return false }
        let error = error as NSError
        if error.domain == NSPOSIXErrorDomain {
            return [ENOTCONN, ECONNRESET, EPIPE, ETIMEDOUT, ENETDOWN, ENETUNREACH, EHOSTUNREACH].contains(Int32(error.code))
        }
        return error.domain == NSURLErrorDomain && [URLError.networkConnectionLost.rawValue,
            URLError.notConnectedToInternet.rawValue, URLError.timedOut.rawValue].contains(error.code)
    }

    public func pair(_ offer: PairOffer) async throws {
        guard authenticated else { throw ConnectionError.invalid("请先连接中继") }
        guard offer.expiresAt > Int(Date().timeIntervalSince1970) else { throw ConnectionError.invalid("配对信息已过期，请在 Mac 上重新生成") }
        let hmac = try pairingHMAC(secret: offer.secret, deviceKey: offer.pubKeys.kem, phoneKey: identity.publicKeys.kem)
        pendingOffer = offer
        try await sendHub(PairRequest(id: UUID().uuidString, deviceId: offer.deviceId, phoneId: identity.id,
            phoneName: "CuaRemote iPhone", phonePubKeys: identity.publicKeys, hmac: hmac))
        onStatus?("等待 Mac 确认配对")
    }

    public func claim(code: String) async throws {
        guard authenticated else { throw ConnectionError.invalid("请先连接中继") }
        try await sendHub(PairCodeClaim(id: UUID().uuidString, code: code, phoneId: identity.id, phonePubKeys: identity.publicKeys))
    }

    public func refreshDevices() async throws {
        try await sendHub(DevicesList(id: UUID().uuidString))
    }

    public func reconnect() async throws {
        guard let lastConnection else { throw ConnectionError.invalid("请先输入连接信息") }
        try await connect(url: lastConnection.url, token: lastConnection.token)
    }

    public func rename(device: String, name: String, requestID: String) async throws {
        guard authenticated else { throw ConnectionError.invalid("尚未连接") }
        try await sendHub(DeviceRename(id: requestID, deviceId: device, name: name))
    }

    public func unpair(device: String, requestID: String) async throws {
        guard authenticated else { throw ConnectionError.invalid("尚未连接") }
        try await sendHub(DeviceUnpair(id: requestID, deviceId: device))
    }

    public func send<T: Encodable>(_ message: T, to peer: String) async throws {
        guard authenticated else { throw ConnectionError.invalid("尚未连接") }
        let link = try await ensureLink(peer)
        try await link.waitUntilReady()
        guard links[peer] === link else { throw ConnectionError.invalid("加密会话已更换，请重新发送") }
        let encrypted = try link.crypto.seal(Frame.control(message))
        try await sendPacket(.data(encrypted))
    }

    private func sendHub<T: Encodable>(_ message: T) async throws {
        let data = try JSONEncoder().encode(message)
        try await sendPacket(.string(String(decoding: data, as: UTF8.self)))
    }

    private func sendPacket(_ message: URLSessionWebSocketTask.Message) async throws {
        guard let socket else { throw ConnectionError.invalid("连接已断开") }
        let previous = writeTail
        let write = Task { @MainActor in
            try await previous?.value
            try Task.checkCancellation()
            guard self.socket === socket else { throw ConnectionError.invalid("连接已断开") }
            try await socket.send(message)
        }
        writeTail = write
        do { try await write.value }
        catch {
            failed(error, task: socket, transport: true)
            throw error
        }
    }

    private func ensureLink(_ peer: String) async throws -> PeerLink {
        if let link = links[peer] { return link }
        guard let pinned = pins[peer], let bytes = Data(base64Encoded: pinned.kem) else { throw ConnectionError.invalid("设备未配对，无法发送指令") }
        let link = PeerLink(try EncryptedLink(selfID: identity.id, privateKey: identity.kem, peerID: peer, peerKey: bytes))
        links[peer] = link
        try await sendPacket(.data(link.crypto.handshake()))
        guard links[peer] === link else { throw ConnectionError.invalid("加密会话已断开") }
        return link
    }

    private func receiveControl(_ message: AnyMessage, task: URLSessionWebSocketTask, url: URL) async throws {
        switch message {
        case .authChallenge(let challenge):
            let signed = try identity.sign("cuaremote-hub-auth-v1\n\(identity.id)\n\(challenge.nonce)")
            try await sendHub(AuthResponse(id: UUID().uuidString, nonce: challenge.nonce, signature: signed))
        case .authOk:
            authenticated = true
            authenticatedURL = url
            reconnecting = false; retryTask = nil
            onStatus?("已连接中继")
            try await refreshDevices()
            guard socket === task else { return }
            heartbeat = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .seconds(30))
                        guard let self else { return }
                        try await self.refreshDevices()
                    } catch { return }
                }
            }
        case .pairOfferMsg(let offer):
            try await pair(PairOffer(hubURL: offer.hubURL, deviceId: offer.deviceId, name: offer.name,
                                     pubKeys: offer.pubKeys, secret: offer.secret, expiresAt: offer.expiresAt))
        case .pairResult(let result):
            guard result.phoneId == identity.id else { throw ConnectionError.invalid("配对结果不属于此手机") }
            if result.ok {
                guard let offer = pendingOffer, offer.deviceId == result.deviceId else { throw ConnectionError.invalid("没有对应的配对请求") }
                pins[result.deviceId] = offer.pubKeys
                try KeychainData.write(JSONEncoder().encode(pins), service: service, account: "pairedKeys")
                pendingOffer = nil
                onStatus?("已安全配对")
                try await refreshDevices()
            } else {
                pendingOffer = nil
                throw ConnectionError.invalid(result.reason ?? "Mac 拒绝了配对")
            }
        case .peerKeys(let peer):
            if let key = pins[peer.deviceId] {
                guard key.kem == peer.pubKeys.kem, key.sig == peer.pubKeys.sig, key.sigAlg == peer.pubKeys.sigAlg else {
                    throw ConnectionError.invalid("设备公钥已改变，请重新配对")
                }
            }
        case .presence(let presence):
            if !presence.online { links.removeValue(forKey: presence.deviceId)?.invalidate() }
        case .pairRemoved(let removed):
            pins.removeValue(forKey: removed.deviceId); links.removeValue(forKey: removed.deviceId)?.invalidate()
            try KeychainData.write(JSONEncoder().encode(pins), service: service, account: "pairedKeys")
            try await refreshDevices()
        case .errorMsg(let error):
            let failure = ConnectionError.invalid("\(error.code)：\(error.message)")
            if !authenticated { throw failure }
            onError?(failure)
        default: break
        }
        guard socket === task else { return }
        onMessage?(message, nil)
    }

    private func receiveRelay(_ data: Data) async throws {
        let envelope = try RelayEnvelope.decode(data)
        guard authenticated, envelope.to == identity.id, pins[envelope.from] != nil else { throw ConnectionError.invalid("收到未配对设备的消息") }
        // 只发送本方握手，不在接收循环中等待对端握手；重复握手由 open 拒绝。
        let link = try await ensureLink(envelope.from)
        let frame = try link.crypto.open(data)
        if link.crypto.ready { link.handshakeReceived() }
        if let frame { onMessage?(try frame.controlMessage(), envelope.from) }
    }

    /// 一个在线会话的握手等待者。离线后立即失败，不把指令带入下一条连接。
    @MainActor final class PeerLink {
        var crypto: EncryptedLink
        private var active = true
        private var waiters: [(UUID, CheckedContinuation<Void, Error>)] = []

        init(_ crypto: EncryptedLink) { self.crypto = crypto }

        func waitUntilReady(timeout: Duration = .seconds(10)) async throws {
            try Task.checkCancellation()
            guard active else { throw ConnectionError.invalid("加密会话已断开") }
            if crypto.ready { return }
            let id = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    waiters.append((id, continuation))
                    Task { @MainActor [weak self] in
                        try await Task.sleep(for: timeout)
                        self?.fail(id, error: ConnectionError.invalid("加密握手超时，请检查 Mac 是否在线"))
                    }
                }
            } onCancel: {
                Task { @MainActor [weak self] in self?.fail(id, error: CancellationError()) }
            }
        }

        func handshakeReceived() {
            let pending = waiters; waiters.removeAll()
            for (_, continuation) in pending { continuation.resume() }
        }

        func invalidate() {
            active = false
            let pending = waiters; waiters.removeAll()
            for (_, continuation) in pending { continuation.resume(throwing: ConnectionError.invalid("加密会话已断开")) }
        }

        private func fail(_ id: UUID, error: Error) {
            guard let index = waiters.firstIndex(where: { $0.0 == id }) else { return }
            waiters.remove(at: index).1.resume(throwing: error)
        }
    }
}
