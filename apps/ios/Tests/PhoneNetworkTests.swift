import CuaRemoteProtocol
import SwiftUI
import XCTest
@testable import CuaRemote

@MainActor
final class PhoneNetworkTests: XCTestCase {
    /// 与 reconnect-hub.ts 的真实 JWT/签名服务通信；不是人工配对或模型验收。
    func testSimulatorFiniteReconnectAndManualStop() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["E2E_RECONNECT_URL"], let token = environment["E2E_RECONNECT_TOKEN"],
              let control = environment["E2E_RECONNECT_CONTROL"] else {
            throw XCTSkip("未配置独立网络测试服务，本项不能算网络验收通过")
        }
        let cache = FileManager.default.temporaryDirectory.appendingPathComponent("network-history-" + UUID().uuidString)
        let model = PhoneModel(historyStore: try HistoryStore(directory: cache)), connection = try XCTUnwrap(model.connection)
        defer { connection.disconnect(); try? FileManager.default.removeItem(at: cache) }
        func waitFor(_ seconds: Int = 10, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async throws {
            for _ in 0..<(seconds * 20) where !condition() { try await Task.sleep(for: .milliseconds(50)) }
            _ = try XCTUnwrap(condition() ? true : nil, "实际手机连接状态未完成", file: file, line: line)
        }
        func request(_ path: String, command: String? = nil) async throws -> [String: Int] {
            var url = try XCTUnwrap(URLComponents(string: address)); url.scheme = "http"; url.path = path
            var request = URLRequest(url: try XCTUnwrap(url.url))
            request.setValue("Bearer " + control, forHTTPHeaderField: "Authorization")
            if let command { request.httpMethod = "POST"; request.httpBody = Data(command.utf8) }
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            return try JSONSerialization.jsonObject(with: data) as? [String: Int] ?? [:]
        }
        model.hubURL = address; model.token = token
        await model.connect(); try await waitFor { model.connected }
        XCTAssertEqual(model.token, "")
        try await connection.rename(device: "nonexistent", name: "must-not-repeat", requestID: UUID().uuidString)
        // 表单故意改坏：自动重连只能使用此前已认证的内存配置。
        model.hubURL = "ws://127.0.0.1:1/ws"
        for (index, delay) in [2, 4, 8, 16, 30].enumerated() {
            let before = ContinuousClock.now
            _ = try await request("/control", command: "network")
            try await waitFor { connection.reconnecting }
            XCTAssertFalse(model.connected)
            XCTAssertNil(model.approval)
            XCTAssertFalse(model.busy)
            XCTAssertEqual(connection.reconnectAttempts, index + 1)
            if index == 0 { try await captureReconnecting(model) }
            try await waitFor(40) { model.connected }
            XCTAssertGreaterThanOrEqual(before.duration(to: .now), .seconds(delay))
            XCTAssertEqual(model.token, "")
            XCTAssertNil(model.error)
            let counts = try await request("/counts")
            XCTAssertEqual(counts["renames"], 1)
            print("SIMULATOR_RECONNECT_DELAY_PASS \(delay)")
        }
        _ = try await request("/control", command: "network")
        try await waitFor { !model.connected }
        let atLimit = try await request("/counts")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(connection.reconnecting)
        XCTAssertEqual(connection.reconnectAttempts, 5)
        let afterLimit = try await request("/counts")
        XCTAssertEqual(atLimit["opened"], afterLimit["opened"])
        await model.reconnect(); try await waitFor { model.connected }
        _ = try await request("/control", command: "network")
        try await waitFor { connection.reconnecting }
        connection.disconnect()
        let atStop = try await request("/counts")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(model.connected); XCTAssertFalse(connection.reconnecting)
        let afterStop = try await request("/counts")
        XCTAssertEqual(atStop["opened"], afterStop["opened"])
        for action in ["4001", "1000", "invalid"] {
            await model.reconnect(); try await waitFor { model.connected }
            _ = try await request("/control", command: action)
            try await waitFor { !model.connected }
            let stopped = try await request("/counts")
            try await Task.sleep(for: .seconds(3))
            XCTAssertFalse(connection.reconnecting); XCTAssertEqual(connection.reconnectAttempts, 0)
            let later = try await request("/counts")
            XCTAssertEqual(stopped["opened"], later["opened"])
        }
        model.hubURL = address; model.token = "invalid-jwt"
        await model.connect(); try await waitFor { model.error != nil }
        let invalid = try await request("/counts")
        try await Task.sleep(for: .seconds(3))
        XCTAssertFalse(model.connected); XCTAssertFalse(connection.reconnecting)
        XCTAssertEqual(connection.reconnectAttempts, 0)
        let later = try await request("/counts")
        XCTAssertEqual(invalid["opened"], later["opened"])
        print("SIMULATOR_RECONNECT_STOP_AND_FAILURES_PASS")
    }

    func testHistorySourceUsesAuthenticatedConnectionNotEditedForm() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["E2E_RECONNECT_URL"], let token = env["E2E_RECONNECT_TOKEN"],
              let control = env["E2E_RECONNECT_CONTROL"] else { throw XCTSkip("未配置真实中继，来源重连检查不能算通过") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("history-source-network-" + UUID().uuidString)
        let store = try HistoryStore(directory: root), model = PhoneModel(historyStore: store)
        let connection = try XCTUnwrap(model.connection)
        defer { connection.disconnect(); try? FileManager.default.removeItem(at: root) }
        func wait(_ condition: () -> Bool) async throws {
            for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(50)) }
            XCTAssertTrue(condition(), "实际中继状态未完成")
        }
        model.hubURL = address; model.token = token
        await model.connect(); try await wait { model.connected }
        let a = try XCTUnwrap(model.historyScope)
        let edited = address + "?different-source=1"
        let b = try HistoryStore.Scope(url: XCTUnwrap(URL(string: edited)), phoneID: connection.identity.id)
        XCTAssertNotEqual(a.sourceID, b.sourceID)
        model.hubURL = edited
        connection.disconnect()
        await model.reconnect(); try await wait { model.connected }
        XCTAssertEqual(connection.authenticatedURL?.absoluteString, address)
        XCTAssertEqual(model.historyScope, a)
        XCTAssertEqual(try store.lastScope(phoneID: connection.identity.id), a)

        var controlURL = try XCTUnwrap(URLComponents(string: address)); controlURL.scheme = "http"; controlURL.path = "/control"
        var request = URLRequest(url: try XCTUnwrap(controlURL.url)); request.httpMethod = "POST"
        request.setValue("Bearer " + control, forHTTPHeaderField: "Authorization")
        request.httpBody = Data("network".utf8)
        _ = try await URLSession.shared.data(for: request)
        try await wait { connection.reconnecting }
        try await wait { model.connected }
        XCTAssertEqual(connection.authenticatedURL?.absoluteString, address)
        XCTAssertEqual(model.historyScope, a)
        XCTAssertEqual(try store.lastScope(phoneID: connection.identity.id), a)
        connection.disconnect()

        // 独立缓存样本，不在真实 hub 中插入设备、配对或公钥。
        let record = HistoryStore.Archive(scope: a,
            device: DevicesPageDevicesItem(deviceId: "cache-fixture", role: .device, platform: .macos,
                name: "离线缓存测试", online: false, lastSeen: 0, paired: true),
            items: [HistoryItem(runId: "keep-a", deviceId: "cache-fixture", intent: "缓存测试", startedAt: 0)],
            listReceivedAt: Date(), nextCursor: nil, details: [:], detailReceivedAt: [:])
        try store.save(record)
        model.token = "invalid-jwt"; model.hubURL = edited
        await model.connect(); try await wait { model.error != nil }
        XCTAssertFalse(model.connected); XCTAssertNil(connection.authenticatedURL)
        XCTAssertEqual(try HistoryStore(directory: root).lastScope(phoneID: connection.identity.id), a)
        XCTAssertEqual(try store.load(scope: a, deviceID: "cache-fixture")?.items.map(\.runId), ["keep-a"])
        XCTAssertTrue(try store.restore(b).isEmpty)
        XCTAssertNil(model.approval); XCTAssertFalse(model.busy)
        print("HISTORY_ACTUAL_AUTH_SOURCE_MANUAL_AUTO_RECONNECT_AND_FAILED_B_PASS")
    }

    private func captureReconnecting(_ model: PhoneModel) async throws {
        XCTAssertEqual(model.token, "", "截图不能包含账号令牌")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: ConnectionView(model: model)
            .environment(\.locale, Locale(identifier: "zh_CN")).preferredColorScheme(.light))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "real-simulator-auto-reconnecting"; attachment.lifetime = .keepAlways; add(attachment)
    }
}
