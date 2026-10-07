import CuaRemoteProtocol
import XCTest
@testable import CuaRemote

@MainActor
final class RunCancellationTests: XCTestCase {
    private func model() -> PhoneModel {
        let model = PhoneModel(historyFixtureStore: nil, phoneID: "cancel-fixture")
        model.connected = true
        model.devices = ["mac", "other"].map { DevicesPageDevicesItem(deviceId: $0, role: .device, platform: .macos,
            name: "隔离取消测试", online: true, lastSeen: 1, paired: true) }
        begin(model)
        return model
    }

    private func begin(_ model: PhoneModel, device: String = "mac", request: String = "request", run: String = "run") {
        model.beginFixtureRun(device: device, request: request)
        model.receive(.runCreated(RunCreated(id: "created", runId: run, requestId: request,
            deviceId: device, intent: "隔离测试，不执行", provider: "fixture", plan: [])), peer: device)
    }

    private func finish(_ status: RunStatus, request: String = "request", run: String = "run") -> AnyMessage {
        .runFinished(RunFinished(id: "finished", runId: run, requestId: request, ok: status == .succeeded,
            status: status, summary: "隔离设备最终结果", cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0), stepCount: 0))
    }

    private func requireApproval(_ model: PhoneModel) {
        let expires = Int(Date().timeIntervalSince1970) + 120
        let action = ConcreteAction(channel: .shell, summary: "隔离操作", detail: "printf 'NOT EXECUTED'")
        let request = StepApprovalRequired(id: "approval", runId: "run", stepId: "step", level: .l2,
            action: action, reason: "隔离测试，未执行", expiresAt: expires,
            challenge: approvalChallenge(runId: "run", stepId: "step", actionDetail: action.detail, nonce: "fixture", expiresAt: expires))
        model.receive(.stepApprovalRequired(request), peer: "mac")
        XCTAssertNotNil(model.approval)
    }

    func testCancelWithoutConnectionReportsUnconfirmedAndKeepsRunBusy() async {
        let model = model()
        await model.cancel()
        XCTAssertTrue(model.cancellationMessage?.contains("发送取消失败") == true)
        XCTAssertTrue(model.busy, "发送取消失败不是任务结束")
        XCTAssertNil(model.completion)
        XCTAssertTrue(model.approvalBlocked)
        XCTAssertTrue(model.canCancel, "允许用户手动重试，不能自动重发")
        model.receive(finish(.succeeded), peer: "mac")
        XCTAssertEqual(model.completion?.status, .succeeded)
        XCTAssertNil(model.cancellationMessage)
        XCTAssertNil(model.error, "取消发送错误不应在设备最终完成后残留为任务错误")
    }

    func testDuplicateClicksWhileSendSuspendedAndAckDoesNotFinish() async throws {
        let model = model()
        var sent: [RunCancel] = []
        var release: CheckedContinuation<Void, Never>?
        model.cancelFixtureSend = { request, peer in
            XCTAssertEqual(peer, "mac"); XCTAssertEqual(request.runId, "run")
            sent.append(request)
            await withCheckedContinuation { release = $0 }
        }
        let first = Task { await model.cancel() }
        for _ in 0..<20 where sent.isEmpty { await Task.yield() }
        let request = try XCTUnwrap(sent.first)
        await model.cancel(); await model.cancel()
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(model.canCancel)
        let ack = AnyMessage.ack(Ack(id: "ack", ref: request.id))
        for peer: String? in [nil, "other"] { model.receive(ack, peer: peer) }
        model.receive(.ack(Ack(id: "old", ref: "old-cancel")), peer: "mac")
        XCTAssertTrue(model.cancellationMessage?.contains("等待设备回执") == true)
        model.receive(ack, peer: "mac")
        XCTAssertTrue(model.cancellationMessage?.contains("设备已收到") == true)
        XCTAssertTrue(model.busy); XCTAssertNil(model.completion)
        release?.resume(); await first.value
        await model.cancel()
        XCTAssertEqual(sent.count, 1)
        model.receive(finish(.cancelled), peer: "mac")
        XCTAssertFalse(model.busy); XCTAssertNil(model.cancellationMessage)
    }

    func testFinalResultBeforeAckWinsForAllOutcomes() async throws {
        for status: RunStatus in [.succeeded, .failed, .cancelled, .denied] {
            let model = model()
            var sent: RunCancel?
            model.cancelFixtureSend = { request, _ in sent = request }
            await model.cancel()
            let id = try XCTUnwrap(sent?.id)
            model.receive(finish(status, run: "foreign"), peer: "mac")
            XCTAssertTrue(model.busy)
            model.receive(finish(status), peer: "mac")
            model.receive(.ack(Ack(id: "late", ref: id)), peer: "mac")
            model.receive(.errorMsg(ErrorMsg(id: "late-error", code: "late", message: "迟到", ref: id)), peer: "mac")
            model.cancelTimedOut(ref: id, peer: "mac")
            XCTAssertEqual(model.completion?.status, status)
            XCTAssertNil(model.cancellationMessage); XCTAssertNil(model.error)
            XCTAssertFalse(model.busy); XCTAssertFalse(model.canCancel)
        }
    }

    func testErrorTimeoutRetryAndOldRefCannotChangeCurrentCancel() async throws {
        let model = model()
        var sent: [RunCancel] = []
        model.cancelFixtureSend = { request, _ in sent.append(request) }
        await model.cancel()
        let first = try XCTUnwrap(sent.first).id
        let failure = AnyMessage.errorMsg(ErrorMsg(id: "failure", code: "fixture", message: "设备拒绝请求", ref: first))
        model.receive(failure, peer: nil); model.receive(failure, peer: "other")
        model.cancelTimedOut(ref: first, peer: "other")
        model.cancelTimedOut(ref: "old", peer: "mac")
        XCTAssertFalse(model.canCancel)
        model.receive(failure, peer: "mac")
        XCTAssertTrue(model.cancellationMessage?.contains("设备拒绝请求") == true)
        XCTAssertTrue(model.busy); XCTAssertNil(model.completion); XCTAssertTrue(model.canCancel)
        await model.cancel()
        XCTAssertEqual(sent.count, 2); XCTAssertNotEqual(first, sent[1].id)
        model.receive(failure, peer: "mac")
        model.receive(.ack(Ack(id: "stale", ref: first)), peer: "mac")
        model.cancelTimedOut(ref: first, peer: "mac")
        XCTAssertTrue(model.cancellationMessage?.contains("等待设备回执") == true)
        model.receive(.ack(Ack(id: "current", ref: sent[1].id)), peer: "mac")
        model.cancelTimedOut(ref: sent[1].id, peer: "mac")
        XCTAssertTrue(model.cancellationMessage?.contains("取消未确认") == true)
        XCTAssertTrue(model.busy); XCTAssertTrue(model.approvalBlocked); XCTAssertNil(model.completion)
        model.connectionLost()
    }

    func testActualDeadlineAfterAckDoesNotReportCancelledOrResend() async throws {
        let model = model()
        requireApproval(model)
        var count = 0
        var cancelID: String?
        model.cancelFixtureSend = { [weak model] request, peer in
            count += 1
            cancelID = request.id
            model?.receive(.ack(Ack(id: "received", ref: request.id)), peer: peer)
        }
        let start = ContinuousClock.now
        await model.cancel()
        XCTAssertTrue(model.cancellationMessage?.contains("设备已收到") == true)
        try await Task.sleep(for: .seconds(21))
        XCTAssertGreaterThanOrEqual(start.duration(to: .now), .seconds(20))
        XCTAssertTrue(model.cancellationMessage?.contains("取消未确认") == true)
        XCTAssertTrue(model.busy); XCTAssertNil(model.completion); XCTAssertEqual(count, 1)
        XCTAssertTrue(model.canCancel); XCTAssertTrue(model.approvalBlocked)
        let expired = try XCTUnwrap(cancelID)
        model.receive(.ack(Ack(id: "late-ack", ref: expired)), peer: "mac")
        model.receive(.errorMsg(ErrorMsg(id: "late-error", code: "fixture", message: "迟到拒绝", ref: expired)), peer: "mac")
        XCTAssertTrue(model.approvalBlocked, "超时后的迟到回执不能解锁旧审批")
        XCTAssertEqual(model.approval?.id, "approval")
        XCTAssertTrue(model.cancellationMessage?.contains("取消未确认") == true)
        await model.cancel() // 明确的手动重试；不是自动重发。
        XCTAssertEqual(count, 2); XCTAssertTrue(model.approvalBlocked)
        model.receive(.ack(Ack(id: "old-again", ref: expired)), peer: "mac")
        model.receive(.errorMsg(ErrorMsg(id: "old-error-again", code: "fixture", message: "旧请求", ref: expired)), peer: "mac")
        XCTAssertTrue(model.approvalBlocked, "手动重试也不恢复旧审批签名")
        await model.decide(allow: true); await model.decide(allow: false)
        XCTAssertEqual(model.approval?.id, "approval")
        XCTAssertFalse(model.events.contains { $0.title.contains("已签名") })
        print("CANCEL_REAL_DEADLINE_LATE_RECEIPTS_RETRY_KEEP_APPROVAL_LOCKED_PASS")
        model.connectionLost()
    }

    func testDisconnectAndPresenceLossNeverResendOrRestoreApproval() async throws {
        for global in [true, false] {
            let model = model()
            var sent: RunCancel?
            var count = 0
            model.cancelFixtureSend = { request, _ in sent = request; count += 1 }
            await model.cancel()
            if global { model.connectionLost() }
            else { model.receive(.presence(Presence(id: "offline", deviceId: "mac", online: false, lastSeen: 1)), peer: nil) }
            XCTAssertTrue(model.cancellationMessage?.contains("连接已断开") == true)
            XCTAssertFalse(model.canCancel); XCTAssertNil(model.completion); XCTAssertNil(model.approval)
            model.receive(.authOk(AuthOk(id: "auth", sessionToken: "fixture-only", expiresAt: 1)), peer: nil)
            model.receive(.presence(Presence(id: "online", deviceId: "mac", online: true, lastSeen: 2)), peer: nil)
            model.receive(.ack(Ack(id: "late", ref: try XCTUnwrap(sent?.id))), peer: "mac")
            model.receive(finish(.cancelled), peer: "mac")
            await model.cancel()
            XCTAssertEqual(count, 1); XCTAssertNil(model.completion)
            XCTAssertFalse(model.busy); XCTAssertNil(model.approval)
        }
    }

    func testLateSendFailureTimeoutAndAckCannotAffectNextDeviceRun() async throws {
        let model = model()
        var request: RunCancel?
        var release: CheckedContinuation<Void, Never>?
        model.cancelFixtureSend = { sent, _ in
            request = sent
            await withCheckedContinuation { release = $0 }
            throw ConnectionError.invalid("旧发送失败")
        }
        let old = Task { await model.cancel() }
        for _ in 0..<20 where request == nil { await Task.yield() }
        let id = try XCTUnwrap(request?.id)
        model.receive(finish(.succeeded), peer: "mac")
        begin(model, device: "other", request: "next-request", run: "next-run")
        model.completion = nil
        release?.resume(); await old.value
        model.receive(.ack(Ack(id: "old", ref: id)), peer: "mac")
        model.cancelTimedOut(ref: id, peer: "mac")
        XCTAssertEqual(model.runID, "next-run"); XCTAssertTrue(model.busy)
        XCTAssertNil(model.cancellationMessage); XCTAssertNil(model.error)
        model.connectionLost()
    }

    func testApprovalCancelStaysUnsignedAndClearsOnlyAtFinalResult() async throws {
        let model = model()
        requireApproval(model)
        var sent: [RunCancel] = []
        model.cancelFixtureSend = { request, _ in sent.append(request) }
        await model.cancel()
        XCTAssertTrue(model.approvalBlocked)
        await model.decide(allow: true); await model.decide(allow: false)
        XCTAssertEqual(sent.count, 1); XCTAssertEqual(model.approval?.id, "approval")
        XCTAssertFalse(model.events.contains { $0.title.contains("已签名") })
        model.receive(.ack(Ack(id: "ack", ref: try XCTUnwrap(sent.first?.id))), peer: "mac")
        XCTAssertNotNil(model.approval); XCTAssertTrue(model.busy)
        model.receive(finish(.cancelled), peer: "mac")
        XCTAssertNil(model.approval); XCTAssertFalse(model.busy)
    }
}
