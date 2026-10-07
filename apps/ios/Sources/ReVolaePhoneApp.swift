import SwiftUI

@main
struct ReVolaePhoneApp: App {
    @State private var session: PhoneSession?
    @State private var startupError: String?
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let session { PhoneRootView(session: session) }
                else if let startupError {
                    ContentUnavailableView("无法读取安全身份", systemImage: "lock.trianglebadge.exclamationmark", description: Text(startupError))
                } else { ProgressView("准备设备身份") }
            }
            .tint(.teal)
            .task {
                guard session == nil, startupError == nil else { return }
                do { session = try PhoneSession() }
                catch { startupError = "安全存储初始化失败。请确认设备已解锁且应用签名正确。\(error.localizedDescription)" }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { session?.disconnect() }
            }
        }
    }
}
