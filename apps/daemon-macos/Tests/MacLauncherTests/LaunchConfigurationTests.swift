import XCTest
@testable import MacLauncher

final class LaunchConfigurationTests: XCTestCase {
    func testOnlyOneLauncherCanOwnDeviceDirectoryAndReleaseIsReusable() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var first: DeviceLease? = try DeviceLease(stateDirectory: root)
        XCTAssertNotNil(first)
        XCTAssertThrowsError(try DeviceLease(stateDirectory: root))
        first = nil
        let replacement = try DeviceLease(stateDirectory: root)
        try withExtendedLifetime(replacement) { XCTAssertThrowsError(try DeviceLease(stateDirectory: root)) }
    }

    func testRejectsBroadScopeAndStateInsideReadableDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appending(path: "packages/brain/src"), withIntermediateDirectories: true)
        try Data().write(to: root.appending(path: "packages/brain/src/cli.ts"))
        defer { try? FileManager.default.removeItem(at: root) }
        let bun = URL(fileURLWithPath: "/usr/bin/true")
        let hub = URL(string: "ws://127.0.0.1:8788/ws")!
        XCTAssertThrowsError(try LaunchConfiguration(repository: root, bun: bun, hub: hub,
            allowedDirectory: URL(fileURLWithPath: "/"), stateDirectory: root, provider: "zenmux:openai/gpt-4.1-mini"))
        XCTAssertThrowsError(try LaunchConfiguration(repository: root, bun: bun, hub: hub,
            allowedDirectory: root, stateDirectory: root.appending(path: "private"), provider: "zenmux:openai/gpt-4.1-mini"))
        let config = try LaunchConfiguration(repository: root, bun: bun, hub: hub,
            allowedDirectory: root.appending(path: "packages"), stateDirectory: root.appending(path: "private"), provider: "zenmux:openai/gpt-4.1-mini")
        XCTAssertTrue(config.arguments.contains("--allow-dir"))
        XCTAssertEqual(config.arguments.last, root.appending(path: "private/events.jsonl").resolvingSymlinksInPath().path)
        XCTAssertThrowsError(try LaunchConfiguration(repository: root, bun: bun, hub: URL(string: "ws://remote.example/ws")!,
            allowedDirectory: root.appending(path: "packages"), stateDirectory: root.appending(path: "private"), provider: "zenmux:openai/gpt-4.1-mini"))
    }
}
