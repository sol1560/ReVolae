import CuaRemoteProtocol
import SwiftUI
import XCTest
@testable import CuaRemote

@MainActor
final class RunOutcomeTests: XCTestCase {
    func testExplicitStatusWinsAndLegacySummaryCannotInventDenial() {
        var result = RunFinished(id: "finish", runId: "run", ok: false, summary: "已拒绝，也已取消",
            cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0), stepCount: 0)
        XCTAssertEqual(result.resultTitle, "任务未完成")
        result.cancelled = true
        XCTAssertEqual(result.resultTitle, "已取消")
        result.status = .failed
        XCTAssertEqual(result.resultTitle, "执行失败", "不能把确认超时或其他失败猜成拒绝")
        result.status = .denied; result.ok = true
        XCTAssertEqual(result.resultTitle, "已拒绝")
        XCTAssertFalse(result.wasSuccessful)
        var history = HistoryItem(runId: "old", deviceId: "mac", intent: "old", startedAt: 0,
            finishedAt: 1, ok: false, summary: "已拒绝")
        XCTAssertEqual(history.resultTitle, "任务未完成")
        history.status = .denied
        XCTAssertEqual(history.resultTitle, "已拒绝")
        history.status = nil; history.finishedAt = nil
        XCTAssertEqual(history.resultTitle, "未结束")
    }

    /// 仅检查展示：这些是明确标记的 UI 固定数据，不是模型或真实执行证据。
    func testRenderEachOutcome() async throws {
        let titles = ["任务完成", "执行失败", "已拒绝", "已取消"]
        for (index, status) in [RunStatus.succeeded, .failed, .denied, .cancelled].enumerated() {
            let model = PhoneModel()
            model.completion = RunFinished(id: "render", runId: "render", ok: status == .succeeded,
                status: status, summary: "展示测试数据 · \(titles[index])\n不代表真实执行。",
                cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0), stepCount: 0)
            XCTAssertEqual(model.completion?.resultTitle, titles[index])
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene)
            let root = UIHostingController(rootView: NavigationStack { ActivityView(model: model) }
                .environment(\.locale, Locale(identifier: "zh_CN")).preferredColorScheme(.light))
            window.rootViewController = root; window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(300))
            root.view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "fixture-outcome-" + status.rawValue
            attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}
