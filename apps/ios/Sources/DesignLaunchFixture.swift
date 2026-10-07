#if DEBUG && targetEnvironment(simulator)
import CuaRemoteProtocol
import Foundation
import SwiftUI

/// 只供显式模拟器视觉测试：不读取身份、pin或默认历史目录，不建立网络连接。
@MainActor
struct DesignLaunchFixture {
    let model: PhoneModel
    let mode: String
    static func requested() -> Self? {
        guard let mode = ProcessInfo.processInfo.environment["CUA_DESIGN_FIXTURE"],
              ["online", "offline", "empty", "dark", "large", "waiting"].contains(mode) else { return nil }
        let model = PhoneModel(historyFixtureStore: nil, phoneID: "design-isolated")
        model.status = "隔离视觉数据 · 无真实连接"
        guard mode != "empty" else { return Self(model: model, mode: mode) }
        model.connected = mode != "offline"
        model.devices = [DevicesPageDevicesItem(deviceId: "design-mac", role: .device, platform: .macos,
            name: "工作 Mac · 隔离数据", online: mode != "offline", lastSeen: 0, paired: true)]
        model.selectedDevice = "design-mac"
        let state = model.data(for: "design-mac")
        state.stats = DeviceStats(batteryPercent: 82, charging: true, runningApps: [], cpuPercent: 23,
            memUsedMB: 5632, memTotalMB: 16384, diskFreeGB: 217)
        state.statsAt = Date(timeIntervalSince1970: 1_788_912_000)
        state.apps = [
            InstalledApp(bundleId: "com.apple.finder", name: "Finder", running: true, learned: true),
            InstalledApp(bundleId: "com.apple.Notes", name: "备忘录", running: true, learned: true),
            InstalledApp(bundleId: "com.apple.Safari", name: "Safari", running: true, learned: false),
            InstalledApp(bundleId: "com.apple.TextEdit", name: "文本编辑", running: false, learned: false)
        ]
        state.cards = [Level.l0, .l1, .l2].map { level in
            CapabilityCard(id: "design-card-\(level.rawValue)", appBundleId: "com.apple.Safari", appName: "Safari",
                name: ["读取标签页", "整理标签页", "操作应用界面"][level.rawValue],
                description: "隔离展示数据，不会执行。", control: .button,
                action: CardAction(kind: level == .l2 ? .gui : .applescript, template: "隔离样例，未执行"),
                staticLevel: level, source: level == .l2 ? .window : .sdef)
        }
        state.shortcuts = ["整理下载文件", "检查项目状态", "汇总今天的备忘录"].enumerated().map {
            Shortcut(id: "design-\($0.offset)", name: $0.element,
                body: "先列出相关内容，修改前停下确认。这是隔离展示数据，不会执行。", runIn: .agent, level: .l1)
        }
        if mode == "waiting" { state.pending[.shortcuts] = "isolated-no-reply" }
        state.history = [
            HistoryItem(runId: "design-history", deviceId: "design-mac", intent: "整理本周工作记录，生成一份简洁的待办清单",
                startedAt: 1_788_912_000_000, finishedAt: 1_788_912_005_000, ok: true, status: .succeeded,
                summary: "隔离展示数据，未实际读取或修改文件。"),
            HistoryItem(runId: "design-cancelled", deviceId: "design-mac", intent: "检查下载目录中的重复文件",
                startedAt: 1_788_902_000_000, finishedAt: 1_788_902_001_000, ok: false, status: .cancelled,
                summary: "隔离取消记录，未执行命令。"),
            HistoryItem(runId: "design-failed", deviceId: "design-mac", intent: "读取不可用的工作目录",
                startedAt: 1_788_901_000_000, finishedAt: 1_788_901_001_000, ok: false, status: .failed,
                summary: "隔离失败记录，目录不可用。未实际执行。"),
            HistoryItem(runId: "design-pending", deviceId: "design-mac", intent: "尚未收到结束结果的旧任务",
                startedAt: 1_788_900_000_000, summary: "隔离未结束记录，不恢复任务或审批。")
        ]
        return Self(model: model, mode: mode)
    }
}

struct DesignFixtureAppearance: ViewModifier {
    let mode: String?
    func body(content: Content) -> some View {
        if let mode {
            content.preferredColorScheme(mode == "dark" ? .dark : .light)
                .dynamicTypeSize(mode == "large" ? .accessibility1 : .large)
        } else { content }
    }
}
#endif
