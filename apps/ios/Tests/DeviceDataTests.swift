import CuaRemoteProtocol
import SwiftUI
import XCTest
@testable import CuaRemote

@MainActor
final class DeviceDataTests: XCTestCase {
    func testRenderShortcutOrderFailureWithoutInventingSuccess() async throws {
        let model = PhoneModel(), state = model.data(for: "fixture")
        state.shortcuts = ["Zulu 23", "Alpha 7", "Mike 51"].map {
            Shortcut(id: $0, name: $0, body: "只读测试，不执行。", runIn: .agent, level: .l0)
        }
        state.shortcutOrderError = "设备上的列表已经改变"
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            ShortcutsView(model: model, deviceID: "fixture")
                .safeAreaInset(edge: .top) { Text("展示测试数据 · 不代表真实执行").font(.caption).padding(8) }
        }.preferredColorScheme(.light))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "fixture-shortcut-order-failed"; attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertEqual(state.shortcuts?.map(\.id), ["Zulu 23", "Alpha 7", "Mike 51"])
        XCTAssertEqual(state.shortcutOrderError, "设备上的列表已经改变")
    }

    func testShortcutReorderNeedsCurrentPeerAndRefAndPreservesFailureAfterReadback() {
        let model = PhoneModel(), state = model.data(for: "mac")
        let original = ["zulu", "alpha", "mike"].map {
            Shortcut(id: $0, name: $0, body: "read only", runIn: .agent, level: .l0)
        }
        let reordered = [original[2], original[0], original[1]]
        state.shortcuts = original
        state.pending[.shortcuts] = "reorder-current"; state.shortcutReorderID = "reorder-current"
        let reply = ShortcutsList(id: "reply", ref: "reorder-current", shortcuts: reordered)
        model.receiveDeviceData(.shortcutsList(reply), peer: "other")
        model.requestFailed(.shortcuts, device: "mac", ref: "previous-request", message: "late send failure")
        XCTAssertEqual(state.shortcuts?.map(\.id), ["zulu", "alpha", "mike"])
        XCTAssertEqual(state.pending[.shortcuts], "reorder-current")
        model.receiveDeviceData(.shortcutsList(reply), peer: "mac")
        XCTAssertEqual(state.shortcuts?.map(\.id), ["mike", "zulu", "alpha"])
        XCTAssertEqual(state.shortcutReplyID, "reply")
        XCTAssertNil(state.shortcutReorderID)

        state.pending[.shortcuts] = "next-order"; state.shortcutReorderID = "next-order"
        model.receiveDeviceData(.errorMsg(ErrorMsg(id: "e", code: "invalid", message: "list changed", ref: "next-order")), peer: "mac")
        XCTAssertEqual(state.shortcutOrderError, "list changed")
        XCTAssertEqual(state.shortcuts?.map(\.id), ["mike", "zulu", "alpha"], "失败不能在本地猜测排序结果")
        state.pending[.shortcuts] = "refresh"
        model.receiveDeviceData(.shortcutsList(ShortcutsList(id: "fresh", ref: "refresh", shortcuts: original)), peer: "mac")
        XCTAssertEqual(state.shortcuts?.map(\.id), ["zulu", "alpha", "mike"])
        XCTAssertEqual(state.shortcutOrderError, "list changed", "刷新成功不能抹掉失败原因")
        state.pending[.shortcuts] = "offline"; state.shortcutReorderID = "offline"
        state.disconnected()
        XCTAssertNil(state.shortcutReplyID)
        XCTAssertNil(state.shortcutReorderID)
        XCTAssertTrue(state.shortcutOrderError?.contains("未确认") == true)
    }

    func testManagementErrorsNeedHubAndMatchingRef() {
        let model = PhoneModel()
        model.connected = true
        model.pendingDeviceChanges["mac"] = "rename-new"
        let stale = ErrorMsg(id: "old", code: "denied", message: "old error", ref: "rename-old")
        model.receive(.errorMsg(stale), peer: nil)
        XCTAssertEqual(model.pendingDeviceChanges["mac"], "rename-new")
        let current = ErrorMsg(id: "new", code: "denied", message: "not permitted", ref: "rename-new")
        model.receive(.errorMsg(current), peer: "other-device")
        XCTAssertEqual(model.pendingDeviceChanges["mac"], "rename-new")
        model.receive(.errorMsg(current), peer: nil)
        XCTAssertNil(model.pendingDeviceChanges["mac"])
        XCTAssertEqual(model.deviceChangeErrors["mac"], "not permitted")
        XCTAssertTrue(model.connected)
    }

    func testDisconnectAndUnpairInvalidateAvailabilityAndLateMessages() {
        let model = PhoneModel()
        let device = DevicesPageDevicesItem(deviceId: "mac", role: .device, platform: .macos,
            name: "isolated test", online: true, lastSeen: 1, paired: true)
        let page = AnyMessage.devicesPage(DevicesPage(id: "page", devices: [device]))
        let auth = AnyMessage.authOk(AuthOk(id: "auth", sessionToken: "unit-test-only", expiresAt: 1))
        model.receive(auth, peer: nil); model.receive(page, peer: nil)
        let state = model.data(for: "mac")
        state.pending[.stats] = "old-stats"
        model.pendingDeviceChanges["mac"] = "rename"
        model.connectionLost()
        XCTAssertFalse(model.connected)
        XCTAssertFalse(model.devices[0].online)
        XCTAssertTrue(model.pendingDeviceChanges.isEmpty)
        model.receive(page, peer: nil)
        model.receive(.presence(Presence(id: "old", deviceId: "mac", online: true, lastSeen: 1)), peer: nil)
        XCTAssertFalse(model.devices[0].online)
        model.receive(auth, peer: "mac")
        XCTAssertFalse(model.connected, "设备不能冒充中继认证成功")
        model.receive(auth, peer: nil)
        XCTAssertFalse(model.devices[0].online, "只认证账号不能恢复旧设备在线标记")
        model.receive(page, peer: nil)
        XCTAssertTrue(model.devices[0].online)
        model.receive(.stats(Stats(id: "late", ref: "old-stats", deviceId: "mac", stats: DeviceStats(runningApps: []))), peer: "mac")
        XCTAssertNil(state.stats)
        model.receive(.pairRemoved(PairRemoved(id: "remove", deviceId: "mac", phoneId: "phone", by: "phone")), peer: nil)
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertNil(model.deviceData["mac"])
        XCTAssertEqual(model.selectedDevice, "")
    }

    func testReplyNeedsBothDeviceAndCurrentRequest() {
        let model = PhoneModel()
        let first = model.data(for: "first"), second = model.data(for: "second")
        first.pending[.stats] = "request-1"; second.pending[.stats] = "request-2"
        let reply = Stats(id: "reply", ref: "request-1", deviceId: "first", stats: DeviceStats(runningApps: [], cpuPercent: 37))
        model.receiveDeviceData(.stats(reply), peer: "second")
        XCTAssertNil(first.stats); XCTAssertNil(second.stats)
        first.pending[.stats] = "retry-1"
        model.receiveDeviceData(.stats(reply), peer: "first")
        XCTAssertNil(first.stats)
        XCTAssertEqual(first.pending[.stats], "retry-1")
        var latest = reply; latest.ref = "retry-1"
        model.receiveDeviceData(.stats(latest), peer: "first")
        XCTAssertEqual(first.stats?.cpuPercent, 37)
        XCTAssertNil(first.pending[.stats])
    }

    func testErrorsCannotClearOtherRequestsAndDisconnectInvalidatesPending() {
        let model = PhoneModel(), ref = "save-shortcut"
        let state = model.data(for: "mac")
        state.pending[.shortcuts] = ref; state.pending[.privacy] = "privacy"
        model.receiveDeviceData(.errorMsg(ErrorMsg(id: "e", code: "failed", message: "unrelated", ref: "old-ref")), peer: "mac")
        XCTAssertEqual(state.pending.count, 2)
        model.receiveDeviceData(.errorMsg(ErrorMsg(id: "e2", code: "failed", message: "storage full", ref: ref)), peer: "mac")
        XCTAssertEqual(state.errors[.shortcuts], "storage full")
        XCTAssertEqual(state.pending[.privacy], "privacy")
        state.disconnected()
        XCTAssertTrue(state.pending.isEmpty)
        XCTAssertFalse(state.finish(.privacy, ref: "privacy"))
    }

    func testHistoryDoesNotRestoreOldApprovalOrChangeActiveRun() throws {
        let model = PhoneModel()
        let state = model.data(for: "mac")
        state.pending[.detail] = "history-query"; state.requestedRunID = "old-run"
        let request = StepApprovalRequired(id: "old-message", runId: "old-run", stepId: "step", level: .l2,
            action: ConcreteAction(channel: .shell, summary: "old", detail: "echo old"), reason: "old",
            expiresAt: 1, challenge: "expired")
        let raw = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(request))
        let detail = HistoryDetail(id: "reply", ref: "history-query",
            item: HistoryItem(runId: "old-run", deviceId: "mac", intent: "old", startedAt: 0), events: [raw])
        model.receiveDeviceData(.historyDetail(detail), peer: "mac")
        XCTAssertNotNil(state.historyDetails["old-run"])
        XCTAssertNil(model.approval)
        XCTAssertNil(model.runID)
        XCTAssertFalse(model.busy)
    }
}
