import XCTest
import CuaRemoteProtocol
@testable import CuaRemote

final class DashboardRefreshTests: XCTestCase {
    func testMemoryFractionUsesReportedValuesAndRejectsMissingOrInvalidTotals() {
        var stats = DeviceStats(runningApps: [], memUsedMB: 3, memTotalMB: 8)
        XCTAssertEqual(stats.memoryFraction, 0.375)
        stats.memTotalMB = nil; XCTAssertNil(stats.memoryFraction)
        stats.memTotalMB = 0; XCTAssertNil(stats.memoryFraction)
        stats.memTotalMB = 2; XCTAssertNil(stats.memoryFraction)
        stats.memTotalMB = 8; stats.memUsedMB = -1; XCTAssertNil(stats.memoryFraction)
        stats.memUsedMB = nil; XCTAssertNil(stats.memoryFraction)
        stats.memUsedMB = 0; XCTAssertEqual(stats.memoryFraction, 0)
    }

    func testSameDeviceReconnectChangesTaskIdentity() {
        let offline = DeviceDashboardRefresh(deviceID: "same-mac", connected: false, online: false)
        let authenticated = DeviceDashboardRefresh(deviceID: "same-mac", connected: true, online: false)
        let available = DeviceDashboardRefresh(deviceID: "same-mac", connected: true, online: true)
        XCTAssertNotEqual(offline, authenticated)
        XCTAssertNotEqual(authenticated, available)
        XCTAssertNotEqual(offline, available)
        XCTAssertNotEqual(available, DeviceDashboardRefresh(deviceID: "same-mac", connected: false, online: true))
        XCTAssertEqual(available, DeviceDashboardRefresh(deviceID: "same-mac", connected: true, online: true))
    }
}
