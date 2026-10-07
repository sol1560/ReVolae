import XCTest

@MainActor
final class NavigationTests: XCTestCase {
    func testFiveTabsAndConnectionEntry() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        for label in ["设备", "应用", "终端", "活动", "我的"] {
            let tab = app.productTab(label)
            XCTAssertTrue(tab.waitForExistence(timeout: 10))
            tab.tap()
            XCTAssertTrue(app.productTitle.waitForExistence(timeout: 5))
            XCTAssertEqual(app.productTitle.label, label)
            app.assertSeparateTaskDock()
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "tab-\(label)"; shot.lifetime = .keepAlways; add(shot)
        }
        app.buttons["connectionSettings"].tap()
        XCTAssertTrue(app.textFields["hubURL"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["accountToken"].exists)
        app.productBack.tap()
        XCTAssertTrue(app.buttons["composeTask"].exists)
    }
}
