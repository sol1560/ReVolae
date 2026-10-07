import XCTest

@MainActor
final class CancellationTests: XCTestCase {
    private func launch(_ mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment["CUA_CANCEL_FIXTURE"] = mode
        app.launch()
        return app
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "isolated-cancel-" + name; shot.lifetime = .keepAlways; add(shot)
    }

    private func showCancel(_ app: XCUIApplication, approval: Bool = false) -> XCUIElement {
        let button = app.buttons[approval ? "cancelApprovalRun" : "cancelRun"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        for _ in 0..<4 where !button.isHittable { app.swipeUp() }
        XCTAssertTrue(button.isHittable)
        XCTAssertGreaterThanOrEqual(button.frame.height, 44 - 0.001)
        return button
    }

    private func waitForText(_ element: XCUIElement, _ text: String, timeout: TimeInterval = 5) {
        let predicate = NSPredicate { _, _ in element.exists && element.label.contains(text) }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout), .completed)
    }

    func testApprovalCancellationWaitingReceivedFailureAndRealTimeout() {
        continueAfterFailure = false
        for (mode, expected, retry) in [
            ("waiting", "等待设备回执", false),
            ("received", "设备已收到", false),
            ("error", "设备未确认取消", true),
            ("send-failure", "发送取消失败", true),
            ("timeout", "取消未确认", true)
        ] {
            let app = launch(mode)
            XCTAssertTrue(app.productTitle.waitForExistence(timeout: 5))
            XCTAssertEqual(app.productTitle.label, "确认操作")
            XCTAssertTrue(app.buttons["approve"].isEnabled); XCTAssertTrue(app.buttons["deny"].isEnabled)
            let cancel = showCancel(app, approval: true)
            if mode == "waiting" { capture(app, "01-before") }
            cancel.tap()
            waitForText(app.staticTexts["cancelApprovalStatus"], expected, timeout: mode == "timeout" ? 25 : 5)
            XCTAssertFalse(app.buttons["approve"].isEnabled); XCTAssertFalse(app.buttons["deny"].isEnabled)
            XCTAssertEqual(cancel.isEnabled, retry)
            XCTAssertFalse(app.staticTexts["runResult"].exists)
            XCTAssertEqual(app.productTitle.label, "确认操作", "ack不能清掉待结束的审批")
            // 末行按钮完整可见，不以标题位置代替。
            if cancel.frame.maxY > app.frame.maxY - 20 { app.swipeUp() }
            XCTAssertLessThanOrEqual(cancel.frame.maxY, app.frame.maxY - 20)
            capture(app, "02-" + mode)
            if mode == "timeout" {
                cancel.tap()
                waitForText(app.staticTexts["cancelApprovalStatus"], "等待设备回执")
                XCTAssertFalse(cancel.isEnabled)
                XCTAssertFalse(app.buttons["approve"].isEnabled); XCTAssertFalse(app.buttons["deny"].isEnabled)
                capture(app, "04-timeout-manual-retry-approval-locked")
            }
            app.terminate()
        }
    }

    func testActivityEntryDisconnectAndFinalBeforeAck() {
        continueAfterFailure = false
        for mode in ["activity", "offline", "finished"] {
            let app = launch(mode)
            showCancel(app, approval: mode != "activity").tap()
            // 关闭审批页的动画期间旧标题仍存在；每次重新查可见标题，不能等待旧元素。
            let detailVisible = NSPredicate { _, _ in
                let title = app.productTitle
                return title.exists && title.isHittable && title.label == "执行详情"
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: detailVisible, object: nil)], timeout: 5), .completed)
            XCTAssertEqual(app.productTitle.label, "执行详情")
            if mode == "activity" {
                waitForText(app.staticTexts["cancelStatus"], "设备已收到")
                XCTAssertFalse(app.buttons["cancelRun"].isEnabled)
                app.assertTaskDockHidden()
                XCTAssertLessThan(app.buttons["cancelRun"].frame.maxY, app.scrollViews.firstMatch.frame.maxY)
            } else if mode == "offline" {
                waitForText(app.staticTexts["cancelStatus"], "连接已断开")
                XCTAssertFalse(app.buttons["cancelRun"].exists)
                XCTAssertFalse(app.staticTexts["runResult"].exists)
            } else {
                waitForText(app.staticTexts["runResult"], "不是已取消")
                XCTAssertFalse(app.staticTexts["cancelStatus"].exists)
                XCTAssertFalse(app.buttons["cancelRun"].exists)
            }
            XCTAssertFalse(app.buttons["approve"].exists)
            XCTAssertFalse(app.buttons["deny"].exists)
            XCTAssertEqual(app.staticTexts["cancelFixture"].value as? String, "sent=1")
            capture(app, "03-" + mode)
            app.terminate()
        }
    }
}
