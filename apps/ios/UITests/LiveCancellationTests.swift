import XCTest

/// 正式PhoneConnection/设备，仅模型为本地固定响应。绝不启用CUA_CANCEL_FIXTURE。
@MainActor
final class LiveCancellationTests: XCTestCase {
    private let app = XCUIApplication()
    private func value(_ key: String) throws -> String { try XCTUnwrap(ProcessInfo.processInfo.environment[key], "缺少取消专项配置") }
    private func replace(_ field: XCUIElement, _ text: String) {
        XCTAssertTrue(field.waitForExistence(timeout: 10)); field.tap()
        if let old = field.value as? String, old != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        field.typeText(text)
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "existing-pairing-local-fixed-model-" + name; shot.lifetime = .keepAlways; add(shot)
    }
    private func control(_ path: String, post: Bool = false) async throws -> [String: Any] {
        var request = URLRequest(url: try XCTUnwrap(URL(string: value("E2E_CANCEL_CONTROL_URL") + "/control/" + path)))
        request.httpMethod = post ? "POST" : "GET"
        request.setValue("Bearer " + (try value("E2E_CANCEL_CONTROL")), forHTTPHeaderField: "Authorization")
        let (bytes, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }
    private func reveal(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        for _ in 0..<10 {
            let dock = app.productDock
            let bottom = app.productTabs.isHittable
                ? min(dock.frame.minY, app.scrollViews.firstMatch.frame.maxY)
                : app.scrollViews.firstMatch.frame.maxY
            if element.isHittable && element.frame.maxY < bottom { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
                .press(forDuration: 0.15, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.43)))
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThan(element.frame.maxY, app.scrollViews.firstMatch.frame.maxY)
        if app.productTabs.isHittable {
            XCTAssertLessThan(element.frame.maxY, app.productDock.frame.minY)
        }
    }

    func testFormalPhoneConnectionCancelsPendingWriteAndReadsDeviceHistory() async throws {
        continueAfterFailure = false
        XCTAssertNil(ProcessInfo.processInfo.environment["CUA_CANCEL_FIXTURE"])
        XCTAssertEqual(try value("E2E_CONNECTION_MODE"), "existing-pairing")
        app.launchArguments = ["-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchEnvironment = [:]
        app.launch()
        XCTAssertFalse(app.staticTexts["cancelFixture"].exists)
        XCTAssertFalse(app.staticTexts["historyFixture"].exists)
        XCTAssertTrue(app.buttons["addDevice"].waitForExistence(timeout: 10)); app.buttons["addDevice"].tap()
        replace(app.textFields["hubURL"], try value("E2E_HUB_URL"))
        app.secureTextFields["accountToken"].tap(); app.secureTextFields["accountToken"].typeText(try value("E2E_TOKEN"))
        app.buttons["dismissKeyboard"].tap(); app.buttons["connect"].tap()
        XCTAssertTrue(app.textFields["pairCode"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["phoneIdentity"].label, try value("E2E_PHONE_ID"))
        app.productBack.tap() // 不操作pair按钮，不写pin。
        let device = app.buttons["device-" + (try value("E2E_DEVICE_ID"))]
        XCTAssertTrue(device.waitForExistence(timeout: 20)); XCTAssertTrue(device.label.contains("已配对"))
        capture("01-existing-pairing")

        app.buttons["composeTask"].tap()
        let field = app.textViews["intent"].exists ? app.textViews["intent"] : app.textFields["intent"]
        let intent = try value("E2E_CANCEL_INTENT")
        replace(field, intent); XCTAssertEqual(field.value as? String, intent)
        app.buttons["dismissKeyboard"].tap(); app.buttons["sendIntent"].tap()
        XCTAssertTrue(app.buttons["approve"].waitForExistence(timeout: 60), "必须由真实设备回传写入审批")
        XCTAssertTrue(app.staticTexts["approvalCommand"].label.contains(try value("E2E_CANCEL_TARGET")))
        XCTAssertTrue(app.buttons["approve"].isEnabled); XCTAssertTrue(app.buttons["deny"].isEnabled)
        let before = try await control("before-cancel", post: true)
        XCTAssertEqual(before["targetExists"] as? Bool, false)
        XCTAssertEqual(before["everExisted"] as? Bool, false)
        XCTAssertEqual(before["finishedEvents"] as? Int, 0)
        XCTAssertEqual(before["approvalEvents"] as? Int, 1)
        XCTAssertEqual(before["intentMatches"] as? Bool, true)
        let run = try XCTUnwrap(before["runId"] as? String)
        capture("02-real-pending-write-file-absent")
        let cancel = app.buttons["cancelApprovalRun"]
        reveal(cancel); XCTAssertTrue(cancel.isEnabled)
        capture("03-before-single-cancel-tap")
        cancel.tap() // 本测试唯一一次取消点击，不点允许或拒绝。
        XCTAssertTrue(app.staticTexts["runResult"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.staticTexts["runStatus"].label, "已取消")
        XCTAssertFalse(app.staticTexts["执行中"].exists, "最终取消后不能把缺少结果的步骤显示为仍在执行")
        XCTAssertTrue(app.staticTexts["步骤结果未确认"].exists)
        XCTAssertFalse(app.buttons["approve"].exists); XCTAssertFalse(app.buttons["deny"].exists)
        capture("04-real-cancelled")
        let after = try await control("state")
        XCTAssertEqual(after["runId"] as? String, run)
        XCTAssertEqual(after["status"] as? String, "cancelled")
        XCTAssertEqual(after["finishedEvents"] as? Int, 1)
        XCTAssertEqual(after["targetExists"] as? Bool, false)
        XCTAssertEqual(after["targetEvents"] as? Int, 0)
        XCTAssertEqual(after["modelCalls"] as? Int, 2)

        app.productBack.tap()
        app.productTab("设备").tap(); app.productTab("活动").tap()
        let record = app.buttons["history-" + run]
        XCTAssertTrue(record.waitForExistence(timeout: 20)); capture("05-device-history-list")
        record.tap()
        XCTAssertTrue(app.staticTexts["historyStatus"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["historyStatus"].label, "已取消")
        let oldApproval = app.staticTexts["旧请求已不可在此确认"]
        reveal(oldApproval)
        XCTAssertFalse(app.buttons["approve"].exists); XCTAssertFalse(app.buttons["deny"].exists)
        XCTAssertFalse(app.buttons["cancelApprovalRun"].exists)
        capture("06-persisted-approval-readonly")
        reveal(app.staticTexts["historySummary"]); capture("07-persisted-final-result")
        let receipt = XCTAttachment(data: try JSONSerialization.data(withJSONObject: after, options: [.sortedKeys, .prettyPrinted]), uniformTypeIdentifier: "public.json")
        receipt.name = "live-cancel-device-readback"; receipt.lifetime = .keepAlways; add(receipt)
        app.terminate()
        print("FORMAL_PHONE_SINGLE_CANCEL_PERSISTED_HISTORY_PASS existing-pairing local-fixed-model")
    }
}
