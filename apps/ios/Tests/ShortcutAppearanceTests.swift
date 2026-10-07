import CuaRemoteProtocol
import SwiftUI
import XCTest
@testable import CuaRemote

/// 仅渲染正式页面；测试数据不会打开连接、执行指令或写入配对记录。
@MainActor
final class ShortcutAppearanceTests: XCTestCase {
    func testOnlineBoundariesWaitingOfflineAndError() async throws {
        for mode in ["online", "waiting", "offline", "error"] {
            try await checkAppearance(mode)
        }
    }

    private func checkAppearance(_ mode: String) async throws {
        let model = PhoneModel(), state = model.data(for: "visual-fixture")
        model.connected = mode != "offline"
        model.devices = [DevicesPageDevicesItem(deviceId: "visual-fixture", role: .device, platform: .macos,
            name: "页面测试数据", online: true, lastSeen: 0, paired: true)]
        let names = ["Mike 51", "Alpha 7", "Zulu 23"]
        state.shortcuts = names.map { Shortcut(id: $0, name: $0, body: "只读页面测试，不执行任务。", runIn: .agent, level: .l0) }
        // 让页面首次读取保持等待；渲染完成后再设置待检查状态，不伪造网络回执。
        state.pending[.shortcuts] = "fixture-render-only"
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let measurements = ShortcutMeasurements()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: ShortcutAppearanceFixture(model: model, mode: mode, measurements: measurements))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(500))
        if mode != "waiting" { state.pending[.shortcuts] = nil }
        if mode == "offline" { state.errors[.shortcuts] = "连接已断开，未确认操作结果" }
        if mode == "error" { state.shortcutOrderError = "设备上的列表已经改变" }
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()

        // 从正式按钮的 isEnabled 环境读取禁用状态，不重复执行产品判断来生成实际值。
        let arrows = measurements.buttons.values.filter { $0.frame.minX > window.bounds.midX && abs($0.frame.width - 44) < 0.1 && abs($0.frame.height - 44) < 0.1 }
            .sorted { abs($0.frame.minY - $1.frame.minY) < 0.5 ? $0.frame.minX < $1.frame.minX : $0.frame.minY < $1.frame.minY }
        XCTAssertEqual(arrows.count, 6, "三张卡必须保留六个44pt箭头区域")
        let expected = mode == "waiting" || mode == "offline" ? [false, false, false, false, false, false] : [false, true, true, true, true, false]
        XCTAssertEqual(arrows.map(\.enabled), expected, mode)
        for arrow in arrows {
            XCTAssertEqual(arrow.frame.width, 44, accuracy: 0.0001)
            XCTAssertEqual(arrow.frame.height, 44, accuracy: 0.0001)
        }
        capture(window, name: "supplement-fixture-\(mode)-top")

        let scroll = try XCTUnwrap(descendants(window).compactMap { $0 as? UIScrollView }.first)
        let bottom = max(-scroll.adjustedContentInset.top,
                         scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()
        let lastY = try XCTUnwrap(measurements.buttons.values.map(\.frame.maxY).max())
        let lastRow = measurements.buttons.values.filter { abs($0.frame.maxY - lastY) < 0.5 }
        XCTAssertEqual(lastRow.count, 3, "目标必须是最后的运行/编辑/删除操作行，而不是标题或箭头")
        let actions = lastRow.reduce(CGRect.null) { $0.union($1.frame) }
        XCTAssertGreaterThan(actions.minY, window.safeAreaInsets.top)
        let safeBottom = window.bounds.maxY - window.safeAreaInsets.bottom
        XCTAssertLessThan(actions.maxY + 18, safeBottom, "详情无底栏；完整操作行及卡片内边距须高于真实安全区")
        print("SHORTCUT_VISUAL_GEOMETRY \(mode) actions=\(actions) safeBottom=\(safeBottom) arrowsEnabled=\(arrows.map(\.enabled))")
        capture(window, name: "supplement-fixture-\(mode)-bottom")
    }

    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }

    private func capture(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

@MainActor
private final class ShortcutMeasurements {
    struct ButtonState { let frame: CGRect; let enabled: Bool }
    var buttons: [UUID: ButtonState] = [:]
}

private struct ShortcutInspectionStyle: ButtonStyle {
    let measurements: ShortcutMeasurements
    func makeBody(configuration: Configuration) -> some View {
        InspectedLabel(label: configuration.label, measurements: measurements)
    }
    private struct InspectedLabel: View {
        let label: ButtonStyleConfiguration.Label
        let measurements: ShortcutMeasurements
        @Environment(\.isEnabled) private var enabled
        @State private var id = UUID()
        @State private var frame = CGRect.zero
        var body: some View {
            label.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { value in
                frame = value; measurements.buttons[id] = .init(frame: value, enabled: enabled)
            }
            .onChange(of: enabled) { _, value in measurements.buttons[id] = .init(frame: frame, enabled: value) }
            .onDisappear { measurements.buttons[id] = nil }
        }
    }
}

private struct ShortcutAppearanceFixture: View {
    let model: PhoneModel
    let mode: String
    let measurements: ShortcutMeasurements
    var body: some View {
        // 正式详情不显示底栏；此处只挂载正式详情并按 UIWindow 的真实安全区检查。
        NavigationStack {
            ShortcutsView(model: model, deviceID: "visual-fixture")
                .buttonStyle(ShortcutInspectionStyle(measurements: measurements))
                .safeAreaInset(edge: .top) {
                    Text("补测 · 测试数据 · \(mode) · 未连接设备").font(.caption).padding(8)
                }
        }.tint(Design.ink).preferredColorScheme(.light)
    }
}
