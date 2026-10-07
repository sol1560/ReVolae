import XCTest

/// 实际 App 终止/启动与正式导航；只用独立 UUID 缓存，不连接网络或建立身份。
@MainActor
final class HistoryRelaunchTests: XCTestCase {
    private let app = XCUIApplication()

    private struct Receipt: Decodable {
        let marker: String
        let mode: String
        let pid: Int
        let rootExists: Bool
        let files: [String: String]
    }

    func testOfflineHistorySurvivesActualAppTermination() throws {
        continueAfterFailure = false
        let marker = UUID().uuidString
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment["CUA_HISTORY_FIXTURE_ID"] = marker
        addTeardownBlock { @MainActor in
            self.app.terminate()
            self.app.launchEnvironment["CUA_HISTORY_FIXTURE_MODE"] = "cleanup"
            self.app.launch()
            let clean = try self.receipt("cleanup")
            XCTAssertFalse(clean.rootExists); XCTAssertTrue(clean.files.isEmpty)
            print("HISTORY_RELAUNCH_CLEANED \(marker)")
            self.app.terminate()
            self.app.launchEnvironment = [:]
        }

        app.launchEnvironment["CUA_HISTORY_FIXTURE_MODE"] = "seed"
        app.launch()
        let first = try receipt("seed")
        XCTAssertEqual(first.marker, marker); XCTAssertTrue(first.rootExists); XCTAssertEqual(first.files.count, 2)
        openHistory()
        let savedAt = app.staticTexts["historySavedAt"].label
        capture("01-seeded-offline-history")
        app.terminate()
        XCTAssertEqual(app.state, .notRunning, "必须真实结束 App 进程，而不是新建内存 Model")
        print("HISTORY_RELAUNCH_TERMINATED pid=\(first.pid)")

        app.launchEnvironment["CUA_HISTORY_FIXTURE_MODE"] = "read"
        app.launch()
        let second = try receipt("read")
        XCTAssertNotEqual(first.pid, second.pid)
        XCTAssertEqual(second.marker, marker); XCTAssertEqual(first.files, second.files, "第二进程只能读原存档，不重新灌入样本")
        app.assertSeparateTaskDock()
        openHistory()
        XCTAssertEqual(app.staticTexts["historySavedAt"].label, savedAt)
        capture("02-relaunched-offline-history")
        let cached = app.buttons["history-cached-" + marker]
        XCTAssertTrue(cached.waitForExistence(timeout: 5)); cached.tap()
        XCTAssertEqual(app.productTitle.label, "任务详情")
        XCTAssertEqual(app.staticTexts["historyAvailability"].label, "设备离线 · 本机历史只读")
        XCTAssertTrue(app.staticTexts["historySavedAt"].exists)
        capture("03-relaunched-detail-top")

        let expected = ["计划更新", "执行前检查", "实际耗时：1,234.5 毫秒", "只是建议，未因此执行", "旧请求已不可在此确认"]
        for (index, label) in expected.enumerated() {
            let card = app.otherElements["historyEvent-\(index)"]
            revealEntireCard(card)
            XCTAssertTrue(card.staticTexts[label].exists, "应显示存档中的事件，而不是当前执行")
            assertNoExecutionControls()
            capture("04-event-\(index)")
        }
        let finalCard = app.otherElements["historyEvent-5"]
        revealEntireCard(finalCard)
        let lastLine = app.staticTexts["historySummary"]
        XCTAssertTrue(lastLine.label.contains("最后一行 · " + marker))
        XCTAssertGreaterThan(finalCard.frame.height, lastLine.frame.height, "检查对象必须是整卡，不只是标题或末行")
        XCTAssertGreaterThanOrEqual(lastLine.frame.minY, finalCard.frame.minY)
        XCTAssertLessThanOrEqual(lastLine.frame.maxY, finalCard.frame.maxY)
        XCTAssertLessThan(lastLine.frame.maxY, app.scrollViews.firstMatch.frame.maxY)
        app.assertTaskDockHidden()
        print("HISTORY_RELAUNCH_BOTTOM card=\(finalCard.frame) lastLine=\(lastLine.frame) viewport=\(app.scrollViews.firstMatch.frame)")
        assertNoExecutionControls()
        capture("05-complete-final-card-above-task-entry")

        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "活动")
        let missing = app.buttons["history-missing-" + marker]
        XCTAssertTrue(missing.waitForExistence(timeout: 5)); missing.tap()
        XCTAssertTrue(app.staticTexts["historyDetailUnavailable"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["historyDetailUnavailable"].label, "这条记录的详情尚未保存，需要设备在线时获取")
        assertNoExecutionControls()
        capture("06-uncached-detail-offline")
        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "活动")
        XCTAssertFalse(app.buttons["currentActivity"].exists)
        XCTAssertFalse(app.staticTexts["Mac 正在执行"].exists)
        XCTAssertFalse(app.staticTexts["1 项待确认"].exists)
        XCTAssertTrue(app.buttons["composeTask"].label.contains("让设备做一件事"))
        assertNoExecutionControls()
        capture("07-activity-remains-idle")

        app.terminate(); XCTAssertEqual(app.state, .notRunning)
        app.launch()
        let afterViewing = try receipt("read")
        XCTAssertNotEqual(afterViewing.pid, second.pid)
        XCTAssertEqual(afterViewing.files, first.files, "离线浏览后再次读盘，存档字节仍不改变")
        print("HISTORY_RELAUNCH_PASS marker=\(marker)")
    }

    private func receipt(_ mode: String) throws -> Receipt {
        let banner = app.staticTexts["historyFixture"]
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        let json = try XCTUnwrap(banner.value as? String)
        let result = try JSONDecoder().decode(Receipt.self, from: Data(json.utf8))
        XCTAssertEqual(result.mode, mode)
        print("HISTORY_RELAUNCH_RECEIPT " + json)
        let attachment = XCTAttachment(data: Data(json.utf8), uniformTypeIdentifier: "public.json")
        attachment.name = "history-relaunch-\(mode)-\(result.pid)"; attachment.lifetime = .keepAlways; add(attachment)
        return result
    }

    private func openHistory() {
        XCTAssertTrue(app.productTab("活动").waitForExistence(timeout: 10))
        app.productTab("活动").tap()
        XCTAssertEqual(app.productTitle.label, "活动")
        XCTAssertEqual(app.staticTexts["historyAvailability"].label, "设备离线 · 本机历史只读")
        XCTAssertTrue(app.staticTexts["来源：wss://history-ui.example.test/ws"].exists)
        XCTAssertTrue(app.staticTexts["historySavedAt"].exists)
    }

    private func revealEntireCard(_ card: XCUIElement) {
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        for _ in 0..<16 {
            let top = app.productHeader.frame.maxY, bottom = app.scrollViews.firstMatch.frame.maxY
            let frame = card.frame, available = bottom - top
            if card.isHittable, frame.minY > top, frame.maxY < bottom { break }
            XCTAssertLessThan(frame.height, available, "当前卡片应能完整放入真实可视区域")
            let needed = frame.midY - (top + bottom) / 2
            let distance = min(available * 0.4, max(-available * 0.4, needed))
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let startY = (top + bottom) / 2 + distance / 2
            origin.withOffset(CGVector(dx: app.frame.midX, dy: startY)).press(forDuration: 0.1,
                thenDragTo: origin.withOffset(CGVector(dx: app.frame.midX, dy: startY - distance)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(card.isHittable)
        XCTAssertGreaterThan(card.frame.minY, app.productHeader.frame.maxY)
        XCTAssertLessThan(card.frame.maxY, app.scrollViews.firstMatch.frame.maxY, "完整事件卡必须在详情安全区内")
        print("HISTORY_RELAUNCH_CARD \(card.identifier) frame=\(card.frame) viewport=\(app.scrollViews.firstMatch.frame)")
    }

    private func assertNoExecutionControls() {
        XCTAssertFalse(app.buttons["approve"].exists); XCTAssertFalse(app.buttons["deny"].exists)
        for title in ["执行", "填入终端", "取消任务", "仅批准这一次", "拒绝执行"] { XCTAssertFalse(app.buttons[title].exists) }
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "history-relaunch-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
