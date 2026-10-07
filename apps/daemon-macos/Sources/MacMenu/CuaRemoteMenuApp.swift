import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: HostModel?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model, model.running || model.retrying else { return .terminateNow }
        Task { await model.stop(); sender.reply(toApplicationShouldTerminate: !model.running) }
        return .terminateLater
    }
}

@main
struct CuaRemoteMenuApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = HostModel()

    var body: some Scene {
        Window("此 Mac", id: "host") {
            HostView(model: model).onAppear { delegate.model = model }
        }.defaultSize(width: 680, height: 800)
        MenuBarExtra("CuaRemote", systemImage: model.running ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark") {
            MenuContent(model: model)
        }
    }
}

private struct MenuContent: View {
    @Bindable var model: HostModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(model.connectionLabel)
        Button("打开此 Mac") { openWindow(id: "host"); NSApplication.shared.activate(ignoringOtherApps: true) }
        Divider()
        Button("退出 CuaRemote") { NSApplication.shared.terminate(nil) }
    }
}
