import CuaRemoteProtocol
import XCTest
@testable import CuaRemote

@MainActor
final class ActivityStepTests: XCTestCase {
    func testCurrentRunPeerAndStepRemainIsolated() throws {
        let model = ActivityLaunchFixture.makeModel()
        XCTAssertEqual(model.activeDevice, "activity-mac")
        XCTAssertEqual(model.selectedDevice, "other-mac")
        XCTAssertEqual(model.prechecks["local"]?.risk, 0.13)
        XCTAssertEqual(model.prechecks["remote"]?.risk, 0.81)
        XCTAssertEqual(model.stepResults["local"]?.ms, 1234.5)
        XCTAssertEqual(model.stepResults["remote"]?.ms, 87.25)
        XCTAssertEqual(model.stepResults["local"]?.dataLeftDevice, false)
        XCTAssertEqual(model.stepResults["remote"]?.dataLeftDevice, true)
        let missing = try XCTUnwrap(model.prechecks["last"])
        XCTAssertNil(missing.intentMatch); XCTAssertNil(missing.risk)
        XCTAssertNil(missing.confidence); XCTAssertNil(missing.jevMs)
        XCTAssertNil(model.stepResults["last"])
        for (peer, run) in [("other-mac", "activity-run"), ("activity-mac", "foreign-run")] {
            model.receive(.stepPrecheck(StepPrecheck(id: "foreign-check", runId: run, stepId: "local",
                staticLevel: .l2, level: .l2, risk: 0.99, verdict: .deny, source: .fallback)), peer: peer)
            model.receive(.stepFinished(StepFinished(id: "foreign-result", runId: run, stepId: "last",
                ok: true, ms: 999, dataLeftDevice: true, output: "不得串入")), peer: peer)
        }
        XCTAssertEqual(model.prechecks["local"]?.risk, 0.13)
        XCTAssertNil(model.stepResults["last"])
        XCTAssertFalse(model.events.contains { $0.detail.contains("不得串入") })
        XCTAssertTrue(model.busy); XCTAssertNil(model.completion); XCTAssertNil(model.approval)
    }

    func testFinalRunOutcomeDoesNotInferEgressOrInventMissingStepResult() {
        let model = ActivityLaunchFixture.makeModel(finished: true)
        XCTAssertFalse(model.busy); XCTAssertEqual(model.completion?.status, .cancelled)
        XCTAssertEqual(model.stepResults["local"]?.ok, true)
        XCTAssertEqual(model.stepResults["local"]?.dataLeftDevice, false)
        XCTAssertEqual(model.stepResults["remote"]?.ok, false)
        XCTAssertEqual(model.stepResults["remote"]?.dataLeftDevice, true)
        XCTAssertNil(model.stepResults["last"])
        XCTAssertEqual(model.plan.last?.status, .pending)
        model.receive(.stepFinished(StepFinished(id: "late", runId: "activity-run", stepId: "last",
            ok: true, ms: 99, dataLeftDevice: true)), peer: "activity-mac")
        XCTAssertNil(model.stepResults["last"], "任务结束后的迟到事件不能补写当前步骤")
    }
}
