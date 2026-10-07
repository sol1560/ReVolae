#if DEBUG && targetEnvironment(simulator)
import CuaRemoteProtocol
import Foundation
import Observation

/// 显式启动的无网络页面测试：只替换取消发送，不访问身份、pin、存档或设备。
@MainActor @Observable
final class CancellationLaunchFixture {
    let model = PhoneModel(historyFixtureStore: nil, phoneID: "isolated-cancel-ui")
    let mode: String
    var sent = 0

    static func requested() -> CancellationLaunchFixture? {
        guard let mode = ProcessInfo.processInfo.environment["CUA_CANCEL_FIXTURE"] else { return nil }
        return CancellationLaunchFixture(mode: mode)
    }

    private init(mode: String) {
        self.mode = mode
        guard ["waiting", "received", "error", "send-failure", "timeout", "offline", "finished", "activity"].contains(mode) else {
            model.error = "取消页面隔离测试参数错误"; return
        }
        model.connected = true
        model.devices = [DevicesPageDevicesItem(deviceId: "fixture-mac", role: .device, platform: .macos,
            name: "隔离测试 Mac · 非真实连接", online: true, lastSeen: 1, paired: true)]
        model.selectedDevice = "fixture-mac"; model.tab = .activity
        model.beginFixtureRun(device: "fixture-mac", request: "fixture-request")
        model.receive(.runCreated(RunCreated(id: "created", runId: "fixture-run", requestId: "fixture-request",
            deviceId: "fixture-mac", intent: "隔离取消页面测试 · 未执行命令", provider: "固定页面数据，无模型",
            plan: [])), peer: "fixture-mac")
        if mode != "activity" {
            let detail = "printf 'ISOLATED UI ONLY — NOT EXECUTED'"
            let expires = Int(Date().timeIntervalSince1970) + 180
            model.receive(.stepApprovalRequired(StepApprovalRequired(id: "fixture-approval", runId: "fixture-run",
                stepId: "fixture-step", level: .l2, action: ConcreteAction(channel: .shell, summary: "隔离操作", detail: detail),
                reason: "隔离页面数据，没有连接设备，不会签名或执行。", expiresAt: expires,
                challenge: approvalChallenge(runId: "fixture-run", stepId: "fixture-step", actionDetail: detail,
                    nonce: "fixture-nonce", expiresAt: expires))), peer: "fixture-mac")
        }
        model.cancelFixtureSend = { [weak self] request, peer in
            guard let self else { return }
            sent += 1
            if mode == "send-failure" { throw ConnectionError.invalid("隔离发送失败") }
            try await Task.sleep(for: .milliseconds(300))
            switch mode {
            case "received", "activity": model.receive(.ack(Ack(id: "ack", ref: request.id)), peer: peer)
            case "error": model.receive(.errorMsg(ErrorMsg(id: "error", code: "fixture", message: "隔离设备拒绝取消请求", ref: request.id)), peer: peer)
            case "offline": model.connectionLost()
            case "finished":
                model.receive(.runFinished(RunFinished(id: "done", runId: request.runId, requestId: "fixture-request",
                    ok: true, status: .succeeded, summary: "隔离最终结果：任务在取消回执前已成功结束。不是已取消。",
                    cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0), stepCount: 0)), peer: peer)
                model.receive(.ack(Ack(id: "late-ack", ref: request.id)), peer: peer)
            default: break // 等待与超时均使用正式的20秒截止时间。
            }
        }
    }
}
#endif
