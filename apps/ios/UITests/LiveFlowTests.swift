import XCTest

/// 需要已启动的真实 hub、Mac 宿主和真实模型。没有配置就失败，不静默跳过。
/// 手机 runner 只断言 UI；磁盘副作用由 Mac runner 的独立检查确认。
@MainActor
final class LiveFlowTests: XCTestCase {
    let app = XCUIApplication()

    func configuration(_ key: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[key], "缺少真实端到端测试配置 \(key)")
    }

    func replace(_ field: XCUIElement, with text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        if let value = field.value as? String, !value.isEmpty, value != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        field.typeText(text)
    }

    func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func submit(_ text: String) {
        returnToRoot()
        XCTAssertTrue(app.buttons["composeTask"].waitForExistence(timeout: 10))
        app.buttons["composeTask"].tap()
        let field = app.textViews["intent"].exists ? app.textViews["intent"] : app.textFields["intent"]
        replace(field, with: text)
        XCTAssertEqual(field.value as? String, text, "实际发送的任务不得残留前一次输入")
        app.buttons["dismissKeyboard"].tap()
        let button = app.buttons["sendIntent"]
        for _ in 0..<5 where !button.isHittable { app.swipeDown() }
        button.tap()
    }

    func waitForResult() -> XCUIElement {
        let result = app.staticTexts["runResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 180), "真实 Mac 应回传完成状态")
        return result
    }

    func testRealMacReadApproveAndDeny() throws {
        continueAfterFailure = false
        let hub = try configuration("E2E_HUB_URL")
        let token = try configuration("E2E_TOKEN")
        let existing = ProcessInfo.processInfo.environment["E2E_CONNECTION_MODE"] == "existing-pairing"
        let readPath = try configuration("E2E_READ_PATH")
        let expected = try configuration("E2E_READ_EXPECTED")
        let approvedPath = try configuration("E2E_APPROVE_PATH")
        let deniedPath = try configuration("E2E_DENY_PATH")
        let content = try configuration("E2E_WRITE_CONTENT")
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        capture("01-connection")
        app.buttons["addDevice"].tap()
        replace(app.textFields["hubURL"], with: hub)
        app.secureTextFields["accountToken"].tap()
        app.secureTextFields["accountToken"].typeText(token)
        app.buttons["dismissKeyboard"].tap()
        app.buttons["connect"].tap()
        XCTAssertTrue(app.textFields["pairCode"].waitForExistence(timeout: 20))
        if existing {
            XCTAssertEqual(app.staticTexts["phoneIdentity"].label, try configuration("E2E_PHONE_ID"))
            app.productBack.tap()
            let device = app.buttons["device-" + (try configuration("E2E_DEVICE_ID"))]
            XCTAssertTrue(device.waitForExistence(timeout: 20))
            XCTAssertTrue(device.label.contains("已配对"))
            // 不写入 pin、不发起配对。后续真实加密读取必须通过原来固定的公钥。
            print("E2E_EXISTING_PAIRING_RECONNECTED")
            capture("02-existing-pairing-reconnected")
        } else {
            replace(app.textFields["pairCode"], with: try configuration("E2E_PAIR_CODE"))
            app.buttons["dismissKeyboard"].tap()
            app.buttons["pair"].tap()
            let waiting = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "等待 Mac 确认配对"), object: app.staticTexts["pairingStatus"])
            XCTAssertEqual(XCTWaiter.wait(for: [waiting], timeout: 10), .completed)
            let outcome = app.staticTexts.matching(NSPredicate(format: "identifier IN %@", ["connectionStatus", "errorMessage"])).firstMatch
            XCTAssertTrue(outcome.waitForExistence(timeout: 100), "Mac 确认应在90秒内接受、拒绝或超时")
            XCTAssertFalse(app.staticTexts["errorMessage"].exists, "真实配对未完成")
            XCTAssertTrue(app.staticTexts["connectionStatus"].exists)
            capture("02-new-pairing-confirmed")
        }
        print("E2E_PAIRED")

        submit("Use fs.read to read the file at \(readPath). Return its exact complete contents. Do not use shell or any other tool, and do not modify anything.")
        _ = waitForResult()
        let output = app.staticTexts["toolOutput"].firstMatch
        for _ in 0..<3 where !output.isHittable { app.swipeUp() }
        XCTAssertEqual(output.label, expected, "必须核对真实工具输出，而不是模型总结")
        capture("03-real-file-read")

        submit("Call shell.run with exactly this command once: printf '%s' '\(content)' > '\(approvedPath)'. The tool will request signed approval automatically. Do not ask for confirmation in text or use another tool. Stop after this command.")
        XCTAssertTrue(app.buttons["approve"].waitForExistence(timeout: 180))
        XCTAssertTrue(app.staticTexts["approvalCommand"].label.contains(approvedPath))
        #if targetEnvironment(simulator)
        XCTAssertEqual(app.staticTexts["signatureMethod"].label, "模拟器软件签名，未验证 Face ID / 设备密码")
        #endif
        XCTAssertFalse(app.staticTexts["runResult"].exists)
        capture("04-awaiting-approval")
        app.buttons["approve"].tap()
        _ = waitForResult()
        XCTAssertEqual(app.staticTexts["runStatus"].label, "任务完成")
        capture("05-approved-result")

        submit("Call shell.run with exactly this command once: printf '%s' '\(content)' > '\(deniedPath)'. The tool will request signed approval automatically. Do not ask for confirmation in text. If rejected, stop immediately without another tool or command.")
        XCTAssertTrue(app.buttons["deny"].waitForExistence(timeout: 180))
        XCTAssertTrue(app.staticTexts["approvalCommand"].label.contains(deniedPath))
        capture("06-awaiting-denial")
        app.buttons["deny"].tap()
        _ = waitForResult()
        XCTAssertEqual(app.staticTexts["runStatus"].label, "已拒绝")
        capture("07-denied-result")
        if ProcessInfo.processInfo.environment["E2E_DEVICE_PAGES"] == "1" { try verifyDevicePages() }
        print("E2E_COMPLETE")
    }

    private func reveal(_ element: XCUIElement) {
        for _ in 0..<7 where !element.isHittable { app.swipeUp() }
        XCTAssertTrue(element.isHittable)
    }

    private func returnToRoot() {
        for _ in 0..<4 where !app.buttons["composeTask"].isHittable && app.productBack.exists {
            app.productBack.tap()
        }
    }

    private func goTab(_ title: String) {
        returnToRoot()
        app.productTab(title).tap()
    }

    private func verifyDevicePages() throws {
        goTab("设备")
        let device = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "device-")).firstMatch
        reveal(device); device.tap()
        let memory = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "已用内存,")).firstMatch
        XCTAssertTrue(memory.waitForExistence(timeout: 20))
        XCTAssertTrue(memory.label.contains("MB"))
        revealAboveAccessory(app.staticTexts["statsLastRow"])
        capture("08-real-device-stats")
        revealAboveAccessory(app.staticTexts["scopeWarning"])
        capture("08b-execution-scope")
        revealAboveAccessory(app.staticTexts["permissionsLastRow"])
        capture("08c-permissions-bottom")

        goTab("应用")
        let search = app.textFields["appSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap(); search.typeText("com.apple.finder\n")
        let finder = app.buttons["app-com.apple.finder"]
        XCTAssertTrue(finder.waitForExistence(timeout: 20)); finder.tap()
        app.buttons["learnApp"].tap()
        let progress = app.staticTexts["learnProgress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 20))
        let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", "done"), object: progress)
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 180), .completed)
        reveal(progress); capture("09-real-readonly-learning")

        goTab("我的")
        reveal(app.buttons["shortcutsSettings"]); app.buttons["shortcutsSettings"].tap()
        XCTAssertTrue(app.staticTexts["尚未保存快捷指令"].waitForExistence(timeout: 20))
        app.buttons["addShortcut"].tap()
        replace(app.textFields["shortcutName"], with: "E2E read only")
        replace(app.textViews["shortcutBody"], with: "Read the allowed working directory. Do not change files.")
        reveal(app.buttons["saveShortcut"]); app.buttons["saveShortcut"].tap()
        XCTAssertTrue(app.staticTexts["E2E read only"].waitForExistence(timeout: 20))
        capture("10-saved-shortcut")
        app.productBack.tap()
        app.buttons["shortcutsSettings"].tap()
        XCTAssertTrue(app.staticTexts["E2E read only"].waitForExistence(timeout: 20), "离开页面后须重新从设备读取已保存指令")
        app.buttons["删除"].tap()
        app.sheets.buttons["删除"].tap()
        XCTAssertTrue(app.staticTexts["尚未保存快捷指令"].waitForExistence(timeout: 20))
        verifyShortcutOrdering()
        app.productBack.tap()
        reveal(app.buttons["privacySettings"]); app.buttons["privacySettings"].tap()
        XCTAssertTrue(app.staticTexts["设备有效设置"].waitForExistence(timeout: 20))
        reveal(app.staticTexts["数据去哪了"]); capture("11-real-privacy")

        goTab("活动")
        let history = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "history-"))
        XCTAssertTrue(history.firstMatch.waitForExistence(timeout: 20))
        let baseline = Int(ProcessInfo.processInfo.environment["E2E_HISTORY_BASELINE"] ?? "0") ?? 0
        XCTAssertEqual(history.count, baseline + 3)
        capture("12-persisted-history")
        history.firstMatch.tap()
        let summary = app.staticTexts["historySummary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 20))
        reveal(summary)
        XCTAssertEqual(app.staticTexts["historyStatus"].label, "已拒绝")
        XCTAssertFalse(app.buttons["approve"].exists)
        XCTAssertFalse(app.buttons["deny"].exists)
        capture("13-readonly-old-approval")
        verifyConnectionAndDeviceManagement()
        print("E2E_DEVICE_PAGES_COMPLETE")
    }

    private func verifyShortcutOrdering() {
        let original = ["E2E Zulu 23", "E2E Alpha 7", "E2E Mike 51"]
        for name in original {
            app.buttons["addShortcut"].tap()
            replace(app.textFields["shortcutName"], with: name)
            replace(app.textViews["shortcutBody"], with: "Read only. Do not change files.")
            reveal(app.buttons["saveShortcut"]); app.buttons["saveShortcut"].tap()
            XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 20))
        }
        waitForShortcutOrder(original)
        for (button, expected) in [
            ("下移 E2E Zulu 23", [original[1], original[0], original[2]]),
            ("上移 E2E Mike 51", [original[1], original[2], original[0]]),
            ("上移 E2E Mike 51", [original[2], original[1], original[0]])
        ] {
            scrollToShortcutTop()
            revealAboveAccessory(app.buttons[button])
            app.buttons[button].tap()
            waitForShortcutOrder(expected)
        }
        scrollToShortcutTop()
        XCTAssertFalse(app.buttons["上移 E2E Mike 51"].isEnabled)
        XCTAssertFalse(app.buttons["下移 E2E Zulu 23"].isEnabled)
        let readback = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "shortcut-readback-")).firstMatch
        let previousReply = readback.identifier
        capture("10b-three-shortcuts-reordered")
        app.productBack.tap()
        app.buttons["shortcutsSettings"].tap()
        XCTAssertTrue(readback.waitForExistence(timeout: 20))
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "identifier != %@", previousReply), object: readback)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 20), .completed, "必须收到另一条设备回执，不能只看到旧缓存")
        waitForShortcutOrder([original[2], original[1], original[0]])
        XCTAssertFalse(app.staticTexts["shortcutOrderError"].exists)
        scrollToShortcutTop(); capture("10c-order-reread-from-mac")
        let lastID = String(app.staticTexts[original[0]].identifier.dropFirst("shortcut-name-".count))
        let lastCard = app.otherElements["shortcut-card-" + lastID]
        let lastActions = app.otherElements["shortcut-actions-" + lastID]
        revealAboveAccessory(lastCard)
        XCTAssertGreaterThan(lastCard.frame.minY, app.productHeader.frame.maxY, "末条卡片顶部也必须完整可见")
        XCTAssertTrue(lastActions.buttons["删除"].isHittable)
        XCTAssertLessThan(lastActions.frame.maxY, lastCard.frame.maxY, "检查实际操作行和卡片底部留白，不能只检查标题")
        capture("10d-order-last-row")
        print("E2E_SHORTCUT_ORDER_REREAD_PASS Mike51_Alpha7_Zulu23")
    }

    private func scrollToShortcutTop() {
        let top = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "shortcut-readback-")).firstMatch
        for _ in 0..<8 where !top.isHittable || top.frame.minY <= app.productHeader.frame.maxY { app.swipeDown() }
    }

    private func waitForShortcutOrder(_ expected: [String]) {
        let names = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "shortcut-name-"))
        let order = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            names.allElementsBoundByIndex.map(\.label) == expected
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [order], timeout: 20), .completed, "设备返回的完整顺序应为 \(expected)")
    }

    private func revealAboveAccessory(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 20))
        for _ in 0..<10 {
            if element.isHittable, element.frame.maxY < app.scrollViews.firstMatch.frame.maxY { break }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThan(element.frame.maxY, app.scrollViews.firstMatch.frame.maxY, "整行必须在实际详情安全区内")
    }

    private func verifyConnectionAndDeviceManagement() {
        goTab("设备")
        app.buttons["addDevice"].tap()
        app.buttons["disconnect"].tap()
        XCTAssertTrue(app.buttons["reconnect"].waitForExistence(timeout: 5))
        app.productBack.tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "device-")).firstMatch
        XCTAssertTrue(app.staticTexts["这台 Mac 当前离线"].exists, "手机断线后不得沿用设备在线标记")
        capture("14-disconnected")
        app.buttons["addDevice"].tap()
        app.buttons["reconnect"].tap()
        XCTAssertTrue(app.buttons["disconnect"].waitForExistence(timeout: 20))
        app.productBack.tap()
        let online = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "在线"), object: app.buttons["deviceSwitcher"])
        XCTAssertEqual(XCTWaiter.wait(for: [online], timeout: 20), .completed)
        goTab("活动")
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "history-")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["historySummary"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["approve"].exists)
        XCTAssertFalse(app.buttons["deny"].exists)
        capture("14b-reconnected-history-readonly")
        goTab("设备")
        reveal(card); card.tap()
        XCTAssertEqual(app.staticTexts["deviceAvailability"].label, "在线，可接收任务")
        let renamed = "E2E Mac " + UUID().uuidString.prefix(8)
        reveal(app.buttons["renameDevice"]); app.buttons["renameDevice"].tap()
        replace(app.alerts.textFields.firstMatch, with: renamed)
        app.alerts.buttons["保存"].tap()
        let name = app.staticTexts[renamed]
        XCTAssertTrue(name.waitForExistence(timeout: 20))
        for _ in 0..<8 where !name.isHittable || name.frame.minY <= app.productHeader.frame.maxY { app.swipeDown() }
        XCTAssertGreaterThan(name.frame.minY, app.productHeader.frame.maxY, "名称须完整离开标题区域")
        capture("15-reconnected-and-renamed")
        revealAboveAccessory(app.buttons["unpairDevice"])
        capture("15b-management-bottom")
        if ProcessInfo.processInfo.environment["E2E_PRESERVE_PAIRING"] == "1" {
            print("E2E_PAIRING_PRESERVED_UNPAIR_NOT_TESTED")
            return
        }
        app.buttons["unpairDevice"].tap()
        app.sheets.buttons["解除配对"].tap()
        XCTAssertTrue(app.staticTexts["设备已不在当前配对列表中。"].waitForExistence(timeout: 20))
        app.productBack.tap()
        XCTAssertTrue(app.staticTexts["把你的 Mac 放进口袋"].waitForExistence(timeout: 10))
        XCTAssertFalse(card.exists)
        capture("16-unpaired")
    }
}
