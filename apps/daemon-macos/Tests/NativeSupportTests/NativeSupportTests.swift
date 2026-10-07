import XCTest
import NativeSupport

final class NativeSupportTests: XCTestCase {
    func testSdefRequiredAndOptionalParametersKeepDifferentTypes() throws {
        let xml = Data("""
        <dictionary><suite name="Example"><command name="export" description="Export data">
          <direct-parameter type="file"/><parameter name="quality" type="integer" optional="yes"/>
          <parameter name="overwrite" type="boolean"/>
        </command></suite></dictionary>
        """.utf8)
        let result = try SdefInventory.parse(xml, bundleID: "test.app", appName: "Test")
        XCTAssertEqual(result.items.count, 1)
        XCTAssertEqual(result.items[0].id, "Example/export")
        XCTAssertEqual(result.items[0].params?.map(\.required), [true, false, true])
        XCTAssertEqual(result.items[0].params?.map(\.type), [.file, .number, .bool])
        XCTAssertEqual(result.truncated, false)
    }

    func testInventoryLimitIsExplicit() throws {
        let commands = (0..<301).map { "<command name=\"command\($0)\"/>" }.joined()
        let result = try SdefInventory.parse(Data("<dictionary><suite name=\"Many\">\(commands)</suite></dictionary>".utf8),
            bundleID: "test.app", appName: "Test")
        XCTAssertEqual(result.items.count, 300)
        XCTAssertEqual(result.items.last?.id, "Many/command299")
        XCTAssertEqual(result.truncated, true)
    }

    @MainActor func testInvalidCaptureSizeFailsBeforeAnyScreenRead() async {
        do { _ = try await ScreenCapture.image(maxWidth: 0); XCTFail("必须拒绝无效尺寸") }
        catch { XCTAssertTrue(error.localizedDescription.contains("1 到 4096")) }
    }
}
