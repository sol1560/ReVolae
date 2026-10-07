import AppKit
import ApplicationServices

public struct PermissionSnapshot: Encodable, Sendable {
    public let accessibility: Bool
    public let screenCapture: Bool
    public let automation: String
}

public struct PairConfirmation: Encodable, Sendable {
    public let accept: Bool
}

@MainActor
public enum Permissions {
    public static func snapshot() -> PermissionSnapshot {
        PermissionSnapshot(accessibility: AXIsProcessTrusted(), screenCapture: CGPreflightScreenCaptureAccess(), automation: "unknown")
    }

    /// 只有本机真实点击允许才返回 true；不合成认证结果，不读取私人应用。
    public static func confirmPair(phoneName: String, phoneID: String) throws -> PairConfirmation {
        guard !phoneID.isEmpty, phoneID.count <= 256, phoneName.count <= 256,
              !phoneID.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw NativeFailure.unavailable("配对手机名称或标识无效")
        }
        let name = String(phoneName.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined())
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "允许这台手机连接此 Mac？"
        alert.informativeText = "手机：\(name)\n设备标识：\(phoneID)\n\n请核对正在操作的手机。配对后它能提交任务和请求终端访问；高风险操作仍需要单独签名确认。"
        alert.addButton(withTitle: "拒绝")
        alert.addButton(withTitle: "允许这台手机配对")
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        return PairConfirmation(accept: alert.runModal() == .alertSecondButtonReturn)
    }
}
