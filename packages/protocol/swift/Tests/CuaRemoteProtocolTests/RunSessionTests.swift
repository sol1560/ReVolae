import XCTest
@testable import CuaRemoteProtocol

final class RunSessionTests: XCTestCase {
    private func created(request: String?, device: String = "mac-a", run: String = "run-new") -> RunCreated {
        RunCreated(id: "event", runId: run, requestId: request, deviceId: device, intent: "same intent", provider: "real", plan: [])
    }

    private func finished(request: String?, run: String = "run-new") -> RunFinished {
        RunFinished(id: "done", runId: run, requestId: request, ok: false, summary: "planning failed",
            cost: Cost(inputTokens: 10, outputTokens: 2, jevTokens: 0, usd: 0), stepCount: 0)
    }

    func testLateOrOtherDeviceCreatedCannotClaimNewRequest() {
        var state = RunSession(); state.begin(deviceID: "mac-a", requestID: "request-new")
        XCTAssertFalse(state.created(created(request: "request-old"), peer: "mac-a"))
        XCTAssertFalse(state.created(created(request: "request-new", device: "mac-b"), peer: "mac-b"))
        XCTAssertFalse(state.created(created(request: nil), peer: "mac-a"))
        XCTAssertNil(state.runID)
        XCTAssertTrue(state.created(created(request: "request-new"), peer: "mac-a"))
        XCTAssertFalse(state.created(created(request: "request-new", run: "other-run"), peer: "mac-a"))
        XCTAssertTrue(state.acceptsStep(runID: "run-new", peer: "mac-a"))
        XCTAssertFalse(state.acceptsStep(runID: "run-new", peer: "mac-b"))
    }

    func testUnrelatedErrorDoesNotStopTaskAndFinishedNeedsMatchingRun() {
        var state = RunSession(); state.begin(deviceID: "mac-a", requestID: "request-new")
        XCTAssertTrue(state.created(created(request: "request-new"), peer: "mac-a"))
        XCTAssertFalse(state.failed(ref: "stats-request", peer: "mac-a"))
        XCTAssertTrue(state.running)
        XCTAssertTrue(state.failed(ref: "request-new", peer: "mac-a"))
        XCTAssertTrue(state.running)
        XCTAssertFalse(state.complete(finished(request: "request-new", run: "wrong-run"), peer: "mac-a"))
        XCTAssertTrue(state.complete(finished(request: "request-new"), peer: "mac-a"))
        XCTAssertFalse(state.running)
        XCTAssertFalse(state.acceptsStep(runID: "run-new", peer: "mac-a"))
        XCTAssertFalse(state.complete(finished(request: "request-new"), peer: "mac-a"))
    }

    func testPlanningFailureBeforeCreatedAndDisconnectedEvents() {
        var state = RunSession(); state.begin(deviceID: "mac-a", requestID: "request-new")
        XCTAssertTrue(state.failed(ref: "request-new", peer: "mac-a"))
        XCTAssertFalse(state.running)
        XCTAssertTrue(state.complete(finished(request: "request-new"), peer: "mac-a"))
        state.begin(deviceID: "mac-a", requestID: "next")
        state.disconnect()
        XCTAssertFalse(state.complete(finished(request: "next"), peer: "mac-a"))
        XCTAssertFalse(state.created(created(request: "next"), peer: "mac-a"))
    }

    func testCancellationBelongsToCurrentRunAndNeverCompletesOnReceipt() {
        var state = RunSession(); state.begin(deviceID: "mac-a", requestID: "request-new")
        XCTAssertNil(state.requestCancellation(id: "before-created"))
        XCTAssertTrue(state.created(created(request: "request-new"), peer: "mac-a"))
        XCTAssertEqual(state.requestCancellation(id: "cancel-1")?.runId, "run-new")
        XCTAssertNil(state.requestCancellation(id: "duplicate"))
        XCTAssertFalse(state.acknowledgeCancellation(ref: "cancel-1", peer: "mac-b"))
        XCTAssertTrue(state.acknowledgeCancellation(ref: "cancel-1", peer: "mac-a"))
        XCTAssertTrue(state.running); XCTAssertTrue(state.approvalBlocked)
        XCTAssertFalse(state.canCancel)
        XCTAssertTrue(state.complete(finished(request: "request-new"), peer: "mac-a"))
        XCTAssertNil(state.cancellation)
        state.begin(deviceID: "mac-a", requestID: "next")
        XCTAssertTrue(state.created(created(request: "next", run: "next-run"), peer: "mac-a"))
        XCTAssertNotNil(state.requestCancellation(id: "cancel-2"))
        XCTAssertFalse(state.acknowledgeCancellation(ref: "cancel-1", peer: "mac-a"))
        XCTAssertFalse(state.cancellationFailed(ref: "cancel-1", peer: "mac-a", message: "old timeout"))
        XCTAssertEqual(state.cancellation, .waiting)
        state.disconnect()
        XCTAssertFalse(state.acknowledgeCancellation(ref: "cancel-2", peer: "mac-a"))
        XCTAssertFalse(state.canCancel)
    }
}
