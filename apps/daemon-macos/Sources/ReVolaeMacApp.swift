import SwiftUI
import AppKit

@main
struct ReVolaeMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    @State private var session: MacSession?
    @State private var startupError: String?

    var body: some Scene {
        WindowGroup("ReVolae Mac", id: "main") {
            Group {
                if let session { MacRootView(session: session) }
                else if let startupError { ContentUnavailableView("安全身份不可用", systemImage: "lock.trianglebadge.exclamationmark", description: Text(startupError)) }
                else { ProgressView("正在准备 Mac 身份") }
            }.tint(.teal).frame(minWidth: 800, minHeight: 620)
                .task {
                    guard session == nil, startupError == nil else { return }
                    do { session = try MacSession() }
                    catch { startupError = error.localizedDescription }
                }
        }.defaultSize(width: 980, height: 800)
        MenuBarExtra("ReVolae", systemImage: "desktopcomputer") {
            MacMenu(session: session)
        }
    }
}

private struct MacMenu: View {
    let session: MacSession?
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("打开 ReVolae") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("立即停止任务") { session?.daemon?.stopCurrentRun() }
        Button("断开远程连接") { session?.disconnect() }
        Divider()
        Button("退出 ReVolae") { session?.disconnect(); NSApp.terminate(nil) }
    }
}

private final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
