import Foundation
import XCTest
@testable import MacLauncher

final class HostStatusTests: XCTestCase {
    func testStatusRequiresLiveProcessAndThisLaunchNotPreviousAuthentication() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appending(path: "status.json")
        try Data(#"{"connection":"authenticated","updatedAt":10001,"activeRunId":"run"}"#.utf8).write(to: file)
        let start = Date(timeIntervalSince1970: 10)
        XCTAssertNil(HostStatus.read(from: root, processRunning: false, startedAt: start))
        XCTAssertNil(HostStatus.read(from: root, processRunning: true, startedAt: Date(timeIntervalSince1970: 11)))
        XCTAssertEqual(HostStatus.read(from: root, processRunning: true, startedAt: start)?.connection, .authenticated)
        XCTAssertEqual(HostStatus.read(from: root, processRunning: true, startedAt: start)?.activeRunId, "run")
        try Data(#"{"connection":"disconnected","updatedAt":11000}"#.utf8).write(to: file)
        XCTAssertEqual(HostStatus.read(from: root, processRunning: true, startedAt: start)?.connection, .disconnected)
        XCTAssertNil(HostStatus.read(from: root, processRunning: false, startedAt: start)?.reconnectable)
        try Data(#"{"connection":"disconnected","updatedAt":11000,"reconnectable":true}"#.utf8).write(to: file)
        XCTAssertEqual(HostStatus.read(from: root, processRunning: false, startedAt: start)?.reconnectable, true)
        XCTAssertNil(HostStatus.read(from: root, processRunning: false, startedAt: Date(timeIntervalSince1970: 12)))
        try Data("incomplete".utf8).write(to: file)
        XCTAssertNil(HostStatus.read(from: root, processRunning: true, startedAt: start))
    }
}
