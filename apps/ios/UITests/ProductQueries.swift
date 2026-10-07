import XCTest

@MainActor
extension XCUIApplication {
    /// 原生弹层过渡中也可能短暂保留下层快照，只定位可触达控件。
    func productElement(_ identifier: String) -> XCUIElement {
        let query = descendants(matching: .any).matching(identifier: identifier)
        let visible = query.allElementsBoundByIndex.filter(\.isHittable)
        XCTAssertLessThanOrEqual(visible.count, 1, "不应有两个同时可操作的 \(identifier)")
        return visible.first ?? query.firstMatch
    }

    var productHeader: XCUIElement {
        let visible = navigationBars.allElementsBoundByIndex.filter(\.isHittable)
        XCTAssertLessThanOrEqual(visible.count, 1, "只能有一个实际可触达的原生导航栏")
        return visible.first ?? navigationBars.firstMatch
    }
    var productTitle: XCUIElement { productHeader.staticTexts.firstMatch }
    var productBack: XCUIElement {
        let close = productHeader.buttons["navigateBack"]
        return close.exists ? close : productHeader.buttons.firstMatch
    }
    var productDock: XCUIElement { productElement("bottomDock") }
    var productTabs: XCUIElement { tabBars["systemTabs"] }
    func productTab(_ title: String) -> XCUIElement { productTabs.buttons["tab-" + title] }

    func printTaskDockState() {
        let elements = [("systemTabs", productTabs)] + ["设备", "应用", "终端", "活动", "我的"].map { ($0, productTab($0)) } + [("composeTask", buttons["composeTask"])]
        for (name, element) in elements {
            let exists = element.exists
            print("DETAIL_DOCK id=\(name) exists=\(exists) hittable=\(element.isHittable) frame=\(exists ? element.frame : .zero)")
        }
    }

    func assertTaskDockHidden() {
        XCTAssertFalse(productTabs.isHittable)
        for title in ["设备", "应用", "终端", "活动", "我的"] { XCTAssertFalse(productTab(title).isHittable) }
        XCTAssertFalse(buttons["composeTask"].isHittable)
    }

    func assertSeparateTaskDock() {
        let group = productTabs, task = productElement("composeTask")
        XCTAssertTrue(group.isHittable)
        XCTAssertTrue(task.isHittable)
        XCTAssertEqual(group.buttons.count, 5, "圆按钮不属于五栏组，不是第六个页签")
        XCTAssertEqual(group.buttons.matching(identifier: "composeTask").count, 0)
        XCTAssertEqual(tabBars.allElementsBoundByIndex.filter(\.isHittable).count, 1, "根页恰好一个可操作的系统UITabBar")
        XCTAssertFalse(productHeader.buttons["composeTask"].exists, "顶部不能再有重复任务入口")
        XCTAssertGreaterThanOrEqual(task.frame.width, 44)
        XCTAssertGreaterThanOrEqual(task.frame.height, 44)
        XCTAssertEqual(task.frame.width, task.frame.height, accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(task.frame.minX - group.frame.maxX, 9.5)
        XCTAssertFalse(task.frame.intersects(group.frame))
        XCTAssertEqual(group.buttons.allElementsBoundByIndex.filter(\.isSelected).count, 1)
        XCTAssertTrue(productTab(productTitle.label).isSelected)
        var centers: [CGFloat] = []
        for title in ["设备", "应用", "终端", "活动", "我的"] {
            let tab = productTab(title)
            XCTAssertTrue(tab.isHittable)
            let frame = tab.frame
            XCTAssertGreaterThanOrEqual(frame.width, 44)
            XCTAssertGreaterThanOrEqual(frame.height, 44)
            centers.append(frame.midX)
        }
        let distances = zip(centers, centers.dropFirst()).map { $1 - $0 }
        print("SEPARATE_TASK_DOCK group=\(group.frame) task=\(task.frame) gap=\(task.frame.minX - group.frame.maxX) centers=\(centers) centerDistances=\(distances)")
    }
}
