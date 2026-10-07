import XCTest

/// 正式五栏活动页；数据明确隔离，无网络、模型、身份或 pin 操作。
@MainActor
final class ActivityStepPresentationTests: XCTestCase {
    private let app = XCUIApplication()

    func testStepDetailsAndCompleteLastCardAboveTaskEntry() {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        for mode in ["steps", "finished"] {
            app.launchEnvironment = ["CUA_ACTIVITY_FIXTURE": mode]
            app.launch()
            XCTAssertTrue(app.staticTexts["activityFixture"].waitForExistence(timeout: 10))
            if mode == "finished" {
                app.productTab("活动").tap()
                app.buttons["currentActivity"].tap()
            }
            XCTAssertTrue(app.staticTexts["检查来源：jev"].waitForExistence(timeout: 5), "活动卡必须展示实际检查来源")
            let local = app.otherElements["activityStep-local"]
            revealEntireCard(local)
            for text in ["检查结果：允许", "检查来源：jev", "静态风险等级：0 · 最终风险等级：1",
                         "符合任务意图：是", "风险值：0.13", "置信度：0.97", "Jev 检查耗时：17.25 毫秒",
                         "实际耗时：1,234.5 毫秒", "数据离机：否（设备报告）"] {
                XCTAssertTrue(local.staticTexts[text].exists, text)
            }
            XCTAssertFalse(local.staticTexts["风险值：0.81"].exists)
            capture(mode + "-01-local-full")
            let remote = app.otherElements["activityStep-remote"]
            for text in ["检查结果：需要确认", "检查来源：cache", "静态风险等级：1 · 最终风险等级：2",
                         "符合任务意图：否", "风险值：0.81", "置信度：0.62", "Jev 检查耗时：39.5 毫秒",
                         "实际耗时：87.25 毫秒", "数据离机：是（设备报告）"] {
                XCTAssertTrue(remote.staticTexts[text].exists, text)
            }
            XCTAssertFalse(remote.staticTexts["风险值：0.13"].exists)
            revealLine(remote.staticTexts["Jev 检查耗时：39.5 毫秒"])
            XCTAssertGreaterThan(remote.staticTexts["检查来源：cache"].frame.minY, app.productHeader.frame.maxY)
            XCTAssertLessThan(remote.staticTexts["Jev 检查耗时：39.5 毫秒"].frame.maxY, app.scrollViews.firstMatch.frame.maxY)
            capture(mode + "-02-remote-check")
            let output = remote.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "隔离错误第 14 行")).firstMatch
            XCTAssertTrue(output.exists)
            XCTAssertTrue(output.label.contains("隔离错误第 1 行"))
            revealLine(remote.staticTexts["数据离机：是（设备报告）"])
            XCTAssertLessThan(output.frame.maxY, app.scrollViews.firstMatch.frame.maxY)
            capture(mode + "-03-remote-long-output-end")

            let last = app.otherElements["activityStep-last"]
            revealEntireCard(last)
            for text in ["检查结果：禁止", "检查来源：fallback", "静态风险等级：2 · 最终风险等级：2"] {
                XCTAssertTrue(last.staticTexts[text].exists)
            }
            for prefix in ["符合任务意图", "风险值", "置信度", "Jev 检查耗时", "实际耗时", "数据离机"] {
                XCTAssertEqual(last.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).count, 0)
            }
            XCTAssertTrue(last.staticTexts[mode == "finished" ? "步骤结果未确认" : "待执行"].exists)
            XCTAssertFalse(app.buttons["approve"].exists); XCTAssertFalse(app.buttons["deny"].exists)
            app.assertTaskDockHidden()
            print("ACTIVITY_LAST_CARD mode=\(mode) card=\(last.frame) viewport=\(app.scrollViews.firstMatch.frame)")
            capture(mode + "-04-complete-last-card")
            app.productBack.tap()
            XCTAssertTrue(app.buttons["composeTask"].label.contains(mode == "finished" ? "让设备做一件事" : "正在执行"))
            if mode == "steps" {
                app.productTab("设备").tap()
                app.assertSeparateTaskDock()
                app.buttons["composeTask"].tap()
                XCTAssertTrue(app.otherElements["activityStep-local"].waitForExistence(timeout: 5), "忙时任务入口重新进入现有详情，不创建新任务")
                XCTAssertFalse(app.textFields["intent"].exists)
                XCTAssertEqual(app.otherElements.matching(NSPredicate(format: "identifier BEGINSWITH %@", "activityStep-")).count, 3)
                XCTAssertFalse(app.productTabs.isHittable)
                app.productBack.tap()
                app.assertSeparateTaskDock()
                XCTAssertTrue(app.productTab("活动").isSelected, "程序切栏后原生选中项同步到活动")
            }
            app.terminate()
        }
        app.launchEnvironment = [:]
    }

    private func revealLine(_ element: XCUIElement) {
        XCTAssertTrue(element.exists)
        for _ in 0..<20 {
            let top = app.productHeader.frame.maxY, bottom = app.scrollViews.firstMatch.frame.maxY
            if element.isHittable && element.frame.minY > top && element.frame.maxY < bottom { return }
            dragToward(element.frame.midY, top: top, bottom: bottom)
        }
        XCTFail("未能将实际末行滚入可见区域")
    }

    private func revealEntireCard(_ card: XCUIElement) {
        XCTAssertTrue(card.exists)
        for _ in 0..<20 {
            let top = app.productHeader.frame.maxY, bottom = app.scrollViews.firstMatch.frame.maxY
            XCTAssertLessThan(card.frame.height, bottom - top)
            if card.isHittable && card.frame.minY > top && card.frame.maxY < bottom { break }
            dragToward(card.frame.midY, top: top, bottom: bottom)
        }
        XCTAssertGreaterThan(card.frame.minY, app.productHeader.frame.maxY)
        XCTAssertLessThan(card.frame.maxY, app.scrollViews.firstMatch.frame.maxY)
        XCTAssertGreaterThan(card.frame.height, card.staticTexts.firstMatch.frame.height)
    }

    private func dragToward(_ y: CGFloat, top: CGFloat, bottom: CGFloat) {
        let amount = min((bottom - top) * 0.4, max(-(bottom - top) * 0.4, y - (top + bottom) / 2))
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: app.frame.midX, dy: (top + bottom + amount) / 2)).press(forDuration: 0.1,
            thenDragTo: origin.withOffset(CGVector(dx: app.frame.midX, dy: (top + bottom - amount) / 2)),
            withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "isolated-activity-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
