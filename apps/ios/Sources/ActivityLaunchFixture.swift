#if DEBUG && targetEnvironment(simulator)
import CuaRemoteProtocol
import Foundation

/// 仅限显式启动的模拟器页面测试；不读身份、pin、存档，不建立连接或调用模型。
@MainActor
struct ActivityLaunchFixture {
    let model: PhoneModel
    let mode: String

    static func requested() -> Self? {
        guard let mode = ProcessInfo.processInfo.environment["CUA_ACTIVITY_FIXTURE"],
              ["steps", "finished"].contains(mode) else { return nil }
        return Self(model: makeModel(finished: mode == "finished"), mode: mode)
    }

    static func makeModel(finished: Bool = false) -> PhoneModel {
        let model = PhoneModel(historyFixtureStore: nil, phoneID: "isolated-activity")
        model.connected = true
        model.devices = ["activity-mac", "other-mac"].map {
            DevicesPageDevicesItem(deviceId: $0, role: .device, platform: .macos,
                name: "隔离步骤数据 · 无设备连接", online: true, lastSeen: 1, paired: true)
        }
        model.selectedDevice = "other-mac" // 所选设备不应改变当前任务所属设备。
        model.tab = .activity
        model.beginFixtureRun(device: "activity-mac", request: "activity-request")
        model.receive(.runCreated(RunCreated(id: "created", runId: "activity-run", requestId: "activity-request",
            deviceId: "activity-mac", intent: "隔离实时步骤补测", provider: "无模型，仅页面数据", plan: [
                PlanStep(id: "local", title: "第一步 · 本机读取", status: .pending),
                PlanStep(id: "remote", title: "第二步 · 长错误输出", status: .pending),
                PlanStep(id: "last", title: "末步 · 可选值未提供", status: .pending)
            ])), peer: "activity-mac")
        let checks = [
            StepPrecheck(id: "check-local", runId: "activity-run", stepId: "local", staticLevel: .l0,
                level: .l1, intentMatch: true, risk: 0.13, confidence: 0.97, jevMs: 17.25, verdict: .allow, source: .jev),
            StepPrecheck(id: "check-remote", runId: "activity-run", stepId: "remote", staticLevel: .l1,
                level: .l2, intentMatch: false, risk: 0.81, confidence: 0.62, jevMs: 39.5, verdict: .confirm, source: .cache),
            StepPrecheck(id: "check-last", runId: "activity-run", stepId: "last", staticLevel: .l2,
                level: .l2, verdict: .deny, source: .fallback)
        ]
        for check in checks { model.receive(.stepPrecheck(check), peer: "activity-mac") }
        model.receive(.stepFinished(StepFinished(id: "result-local", runId: "activity-run", stepId: "local",
            ok: true, ms: 1234.5, dataLeftDevice: false, output: "隔离输出：读取完成，未上传内容。")), peer: "activity-mac")
        model.receive(.stepFinished(StepFinished(id: "result-remote", runId: "activity-run", stepId: "remote",
            ok: false, ms: 87.25, dataLeftDevice: true,
            error: (1...14).map { "隔离错误第 \($0) 行：这是长输出排版数据，不是真实执行。" }.joined(separator: "\n"))), peer: "activity-mac")
        if finished {
            model.receive(.runFinished(RunFinished(id: "finished", runId: "activity-run", requestId: "activity-request",
                ok: false, status: .cancelled, summary: "隔离结束状态 · 不代表真实取消",
                cost: Cost(inputTokens: 0, outputTokens: 0, usd: 0, unknownPrice: true), stepCount: 3)), peer: "activity-mac")
        }
        return model
    }
}
#endif
