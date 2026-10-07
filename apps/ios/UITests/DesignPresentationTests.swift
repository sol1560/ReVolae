import XCTest

/// 真正启动 App；显式隔离视觉数据，无身份、pin、模型或网络。
@MainActor
final class DesignPresentationTests: XCTestCase {
    private let app = XCUIApplication()
    private var nativeBarID = ""
    private func launch(_ mode: String) {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment = ["CUA_DESIGN_FIXTURE": mode]
        app.launch()
        XCTAssertTrue(app.staticTexts["designFixture"].waitForExistence(timeout: 10))
        nativeBarID = app.productTabs.value as? String ?? ""
        XCTAssertTrue(nativeBarID.hasPrefix("native-instance-"))
    }
    private func shot(_ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = "ui33-isolated-" + name; image.lifetime = .keepAlways; add(image)
    }
    private func tab(_ name: String) {
        let button = app.productTab(name)
        XCTAssertTrue(button.isHittable); button.tap()
        app.assertSeparateTaskDock()
        XCTAssertEqual(app.productTabs.value as? String, nativeBarID, "切换栏目不能拆掉UITabBar，否则原生选中过渡会被截断")
    }
    private func bottom(_ element: XCUIElement) {
        for _ in 0..<12 {
            let edge = app.productTabs.isHittable ? app.productDock.frame.minY : app.scrollViews.firstMatch.frame.maxY
            if element.isHittable && element.frame.maxY < edge { break }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThan(element.frame.maxY, app.scrollViews.firstMatch.frame.maxY)
    }

    func testNativeDockWidthAndSingleInstance() {
        launch("online")
        app.assertSeparateTaskDock()
        XCTAssertGreaterThanOrEqual(app.productTabs.frame.width, app.frame.width * 0.8 - 0.5, "不能退回额外外边距造成的窄栏")
        XCTAssertLessThanOrEqual(app.buttons["composeTask"].frame.maxX, app.frame.maxX - 1, "独立圆钮须完整在屏内并留边")
        shot("wide-device")
        for title in ["应用", "终端", "活动", "我的", "设备"] { tab(title) }
        app.buttons["composeTask"].tap()
        XCTAssertTrue(app.textFields["intent"].waitForExistence(timeout: 5))
        app.assertTaskDockHidden()
        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "设备")
        XCTAssertEqual(app.productTabs.value as? String, nativeBarID)
        app.assertSeparateTaskDock()
        app.terminate()
    }

    func testMainPagesActionsSearchAndDetailSafeArea() {
        launch("online")
        XCTAssertTrue(app.staticTexts["画面尚未接通"].exists)
        XCTAssertTrue(app.staticTexts["23%"].exists)
        app.assertSeparateTaskDock()
        shot("01-device")
        app.buttons["addDevice"].tap()
        XCTAssertTrue(app.textFields["pairCode"].waitForExistence(timeout: 5))
        shot("02-pairing")
        app.productBack.tap()
        app.buttons["composeTask"].tap()
        XCTAssertTrue(app.textFields["intent"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["sendIntent"].isEnabled)
        XCTAssertFalse(app.productTab("设备").isHittable, "弹层不能操作背后的栏目")
        shot("03-compose")
        app.textFields["intent"].tap(); app.textFields["intent"].typeText("只读检查，不执行")
        XCTAssertTrue(app.buttons["sendIntent"].isEnabled)
        XCTAssertTrue(app.buttons["dismissKeyboard"].isHittable)
        app.buttons["dismissKeyboard"].tap()
        shot("04-compose-filled")
        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "设备", "关闭任务抽屉保留原栏目")
        tab("应用"); shot("05-apps")
        app.textFields["appSearch"].tap(); app.textFields["appSearch"].typeText("Safari\n")
        XCTAssertTrue(app.buttons["app-com.apple.Safari"].exists)
        XCTAssertFalse(app.buttons["app-com.apple.finder"].exists)
        tab("终端"); shot("06-terminal")
        tab("应用")
        XCTAssertEqual(app.textFields["appSearch"].value as? String, "Safari", "切换栏目保留搜索状态")
        app.buttons["app-com.apple.Safari"].tap()
        XCTAssertEqual(app.productTitle.label, "Safari")
        let detailNavigation = NSPredicate { _, _ in
            !self.app.productTabs.isHittable && !self.app.buttons["composeTask"].isHittable
        }
        let hidden = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: detailNavigation, object: nil)], timeout: 5)
        shot("07a-detail-native-navigation")
        app.printTaskDockState()
        XCTAssertEqual(hidden, .completed, "原生push完成后详情必须隐藏整个底栏")
        app.assertTaskDockHidden()
        XCTAssertEqual(app.tabBars.allElementsBoundByIndex.filter(\.isHittable).count, 0)
        app.switches["显示隐藏卡片"].tap()
        XCTAssertEqual(app.switches["显示隐藏卡片"].value as? String, "1")
        bottom(app.staticTexts["gui"])
        shot("07-app-detail")
        // 真实原生边缘返回手势，而不是测试自行改变导航状态。
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).press(forDuration: 0.1,
            thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)))
        XCTAssertTrue(app.productTab("应用").waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["appSearch"].value as? String, "Safari")
        tab("活动"); shot("08-activity")
        app.buttons["执行失败"].tap()
        XCTAssertTrue(app.buttons["history-design-failed"].exists)
        XCTAssertFalse(app.buttons["history-design-history"].exists)
        app.textFields["historySearch"].tap(); app.textFields["historySearch"].typeText("no match\n")
        XCTAssertTrue(app.staticTexts["没有匹配的记录"].exists)
        app.buttons["clearHistoryFilter"].tap()
        XCTAssertTrue(app.buttons["history-design-history"].exists)
        tab("我的"); shot("09-profile")
        bottom(app.buttons["shortcutsSettings"]); app.buttons["shortcutsSettings"].tap()
        XCTAssertEqual(app.productTitle.label, "快捷指令")
        app.assertTaskDockHidden()
        let card = app.otherElements["shortcut-card-design-2"]
        bottom(card)
        XCTAssertGreaterThan(card.frame.minY, app.productHeader.frame.maxY)
        shot("10-shortcuts-bottom")
        app.buttons["addShortcut"].tap()
        XCTAssertTrue(app.textFields["shortcutName"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["saveShortcut"].isEnabled)
        shot("11-shortcut-editor")
        app.terminate()
    }

    func testOfflineEmptyDarkAndLargeText() {
        for mode in ["offline", "empty", "dark", "large"] {
            launch(mode)
            app.assertSeparateTaskDock()
            shot(mode + "-device")
            if mode == "offline" {
                XCTAssertTrue(app.staticTexts["这台 Mac 当前离线"].exists)
                XCTAssertFalse(app.staticTexts["23%"].exists)
            }
            for name in ["应用", "活动", "我的"] {
                tab(name)
                if mode == "offline", name == "应用" {
                    XCTAssertTrue(app.staticTexts["appsOffline"].exists)
                    XCTAssertTrue(app.buttons["app-com.apple.finder"].label.contains("上次运行中"))
                }
                shot(mode + "-" + name)
                if mode == "large", name == "应用" {
                    bottom(app.buttons["app-com.apple.TextEdit"])
                    XCTAssertLessThan(app.buttons["app-com.apple.TextEdit"].frame.maxY, app.productDock.frame.minY)
                    shot("large-apps-bottom")
                }
            }
            app.buttons["composeTask"].tap()
            if mode == "empty" {
                XCTAssertTrue(app.textFields["hubURL"].waitForExistence(timeout: 5))
            } else {
                XCTAssertTrue(app.textFields["intent"].waitForExistence(timeout: 5))
                XCTAssertFalse(app.buttons["sendIntent"].isEnabled)
                XCTAssertTrue(app.textFields["intent"].isHittable)
                XCTAssertTrue(app.productHeader.isHittable)
            }
            shot(mode + "-entry")
            app.productBack.tap()
            XCTAssertEqual(app.productTitle.label, "我的")
            app.assertSeparateTaskDock()
            app.terminate()
        }
    }

    func testWaitingShortcutHeaderActuallyDisabledAndScrollPreserved() {
        launch("waiting")
        bottom(app.buttons["device-design-mac"])
        let position = app.buttons["device-design-mac"].frame.minY
        tab("应用"); tab("设备")
        XCTAssertEqual(app.buttons["device-design-mac"].frame.minY, position, accuracy: 1)
        tab("我的")
        bottom(app.buttons["shortcutsSettings"]); app.buttons["shortcutsSettings"].tap()
        XCTAssertTrue(app.buttons["addShortcut"].exists)
        XCTAssertFalse(app.buttons["addShortcut"].isEnabled)
        XCTAssertFalse(app.buttons["上移 整理下载文件"].isEnabled)
        XCTAssertFalse(app.buttons["下移 整理下载文件"].isEnabled)
        shot("waiting-shortcuts-disabled")
        app.terminate()
    }

    /// 单独录制一次清晰短片；仍走正式页面按钮，不调用模型、设备或发送闭包。
    func testRecordedSeparateTaskWalkthrough() {
        launch("online")
        app.assertSeparateTaskDock()
        print("DESIGN33_RECORD_READY")
        Thread.sleep(forTimeInterval: 3)
        for title in ["应用", "终端", "活动", "我的", "设备"] {
            let button = app.productTab(title)
            button.tap()
            XCTAssertTrue(button.isSelected)
            XCTAssertEqual(app.productTitle.label, title)
            XCTAssertEqual(app.productTabs.value as? String, nativeBarID)
            Thread.sleep(forTimeInterval: 1.5)
        }
        app.swipeUp()
        Thread.sleep(forTimeInterval: 2)
        app.swipeDown()
        app.buttons["composeTask"].tap()
        XCTAssertTrue(app.textFields["intent"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 3)
        shot("record-compose")
        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "设备")
        tab("应用")
        app.buttons["app-com.apple.Safari"].tap()
        XCTAssertEqual(app.productTitle.label, "Safari")
        XCTAssertFalse(app.productTabs.isHittable)
        XCTAssertFalse(app.buttons["composeTask"].isHittable)
        Thread.sleep(forTimeInterval: 3)
        app.productBack.tap()
        XCTAssertEqual(app.productTitle.label, "应用")
        app.assertSeparateTaskDock()
        Thread.sleep(forTimeInterval: 3)
        print("DESIGN33_RECORD_DONE")
        app.terminate()
    }
}
