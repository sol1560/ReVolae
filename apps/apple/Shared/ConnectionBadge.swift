import SwiftUI
import CuaRemoteCore
import CryptoKit
import CuaRemoteProtocol

struct ConnectionBadge: View {
    let status: RemoteClientStatus

    var body: some View {
        Label(title, systemImage: status == .connected ? "lock.shield.fill" : "network")
            .font(.caption.weight(.semibold))
            .foregroundStyle(status == .connected ? Color.teal : Color.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.quaternary, in: Capsule())
            .accessibilityIdentifier("connection-status")
    }

    private var title: String {
        switch status {
        case .disconnected: "未连接"
        case .connecting: "正在连接"
        case .authenticating: "验证身份中"
        case .connected: "Hub 已认证"
        case .failed: "连接失败"
        }
    }
}

func keyFingerprint(_ keys: PublicKeys) -> String {
    let digest = SHA256.hash(data: Data("\(keys.kem)\n\(keys.sig)".utf8))
    return digest.prefix(12).map { String(format: "%02x", $0) }.joined(separator: ":")
}

struct NoticeView: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "info.circle")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
