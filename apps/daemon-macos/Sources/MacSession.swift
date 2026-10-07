import AppKit
import Combine
import CuaRemoteCore
import CuaRemoteMac
import Foundation

@MainActor
final class MacSession: ObservableObject {
    let client: RemoteClient
    @Published var daemon: MacDaemon?
    @Published var error: String?
    @Published var offer = ""
    @Published var connecting = false
    private var observations: [AnyCancellable] = []

    init() throws {
        client = try RemoteClient(role: .device, name: Host.current().localizedName ?? "Mac")
        observe(client)
        client.onSecurityEvent = { [weak self] _ in self?.error = "设备身份或加密会话验证失败，已停止相关连接。" }
        client.onHubMessage = { [weak self] message in
            if case .errorMsg(let value) = message { self?.error = "Hub：\(value.code)" }
        }
    }

    func connect(hub: String, token: String, local: Bool, repo: String, bun: String, workspace: String, provider: String, apiKey: String) async {
        guard !connecting else { return }
        connecting = true
        defer { connecting = false }
        do {
            guard let url = URL(string: hub) else { throw PairingError.invalidHubURL }
            daemon?.disconnect()
            offer = ""
            var environment: [String: String] = [:]
            if !apiKey.isEmpty {
                let prefix = provider.split(separator: ":").first.map(String.init) ?? ""
                let variable = ["openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "zenmux": "ZENMUX_API_KEY", "openai-compat": "OPENAI_COMPAT_API_KEY"][prefix]
                if let variable { environment[variable] = apiKey }
            }
            let configuration = try MacDaemonConfiguration(
                repoURL: URL(fileURLWithPath: (repo as NSString).expandingTildeInPath, isDirectory: true),
                bunURL: URL(fileURLWithPath: (bun as NSString).expandingTildeInPath),
                workspaceURL: URL(fileURLWithPath: (workspace as NSString).expandingTildeInPath, isDirectory: true),
                provider: provider,
                modelCredentialEnvironment: environment
            )
            let daemon = try MacDaemon(client: client, configuration: configuration)
            self.daemon = daemon
            observations = Array(observations.prefix(1))
            observe(daemon)
            try await daemon.connect(to: url, token: token.isEmpty ? nil : token, allowInsecureLocalDevelopment: local)
        } catch { self.error = "启动失败：\(error.localizedDescription)"; client.disconnect() }
    }

    func disconnect() { daemon?.disconnect(); client.disconnect(); offer = "" }

    func makeOffer() {
        do { offer = try client.makePairOffer() }
        catch { self.error = "无法创建配对码：\(error.localizedDescription)" }
    }

    func confirm(_ accept: Bool) async {
        guard let request = client.pendingPairRequest else { return }
        do {
            if accept { try await client.confirmPair(deviceId: request.deviceId, phoneId: request.phoneId) }
            else { try await client.declinePair(deviceId: request.deviceId, phoneId: request.phoneId) }
            offer = ""
        } catch { self.error = "配对处理失败：\(error.localizedDescription)" }
    }

    func unpair(_ peer: String) async {
        do { try await client.unpair(peer) }
        catch { self.error = "撤销配对失败：\(error.localizedDescription)" }
    }

    private func observe<T: ObservableObject>(_ value: T) where T.ObjectWillChangePublisher == ObservableObjectPublisher {
        observations.append(value.objectWillChange.sink { [weak self] in
            Task { @MainActor [weak self] in self?.objectWillChange.send() }
        })
    }
}
