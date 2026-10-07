#if DEBUG && targetEnvironment(simulator)
import CryptoKit
import CuaRemoteProtocol
import Foundation

/// 仅用于模拟器启动测试。不创建连接、身份或 pin；目录只能是本轮 UUID 对应的独立存档。
@MainActor
struct HistoryLaunchFixture {
    let model: PhoneModel
    let label: String
    let receipt: String

    static func requested() -> Self? {
        let environment = ProcessInfo.processInfo.environment
        guard let input = environment["CUA_HISTORY_FIXTURE_ID"] else { return nil }
        let mode = environment["CUA_HISTORY_FIXTURE_MODE"] ?? ""
        do {
            guard let uuid = UUID(uuidString: input), ["seed", "read", "cleanup"].contains(mode) else {
                throw HistoryStore.StoreError.source
            }
            let marker = uuid.uuidString, phone = "fixture-phone-" + marker
            let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true).appendingPathComponent("HistoryUITests", isDirectory: true)
            let root = base.appendingPathComponent(marker, isDirectory: true)
            let exists = FileManager.default.fileExists(atPath: root.path)
            let model: PhoneModel
            if mode == "cleanup" {
                if exists { try FileManager.default.removeItem(at: root) }
                model = PhoneModel(historyFixtureStore: nil, phoneID: phone)
            } else {
                // 第二轮绝不回退到 seed；首轮也不允许覆盖已有目录。
                guard mode == "seed" ? !exists : exists else { throw HistoryStore.StoreError.damaged }
                let store = try HistoryStore(directory: root)
                if mode == "seed" { try seed(store, marker: marker, phone: phone) }
                model = PhoneModel(historyFixtureStore: store, phoneID: phone)
                guard model.historyCacheError == nil, model.devices.count == 1 else { throw HistoryStore.StoreError.damaged }
            }
            var files: [String: String] = [:]
            if let entries = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
                for case let file as URL in entries where file.pathExtension == "json" {
                    files[String(file.path.dropFirst(root.path.count + 1))] = SHA256.hash(data: try Data(contentsOf: file))
                        .map { String(format: "%02x", $0) }.joined()
                }
            }
            let receipt: [String: Any] = ["marker": marker, "mode": mode, "pid": ProcessInfo.processInfo.processIdentifier,
                "rootExists": FileManager.default.fileExists(atPath: root.path), "files": files]
            let json = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
            return Self(model: model, label: "隔离历史补测 · \(marker.prefix(8)) · \(mode)", receipt: String(decoding: json, as: UTF8.self))
        } catch {
            // 即使参数错误也不回退到默认存储或真实身份。
            return Self(model: PhoneModel(historyFixtureStore: nil, phoneID: "invalid-fixture"),
                label: "隔离历史补测失败", receipt: "error: " + error.localizedDescription)
        }
    }

    private static func seed(_ store: HistoryStore, marker: String, phone: String) throws {
        let scope = try HistoryStore.Scope(url: URL(string: "wss://history-ui.example.test/ws")!, phoneID: phone)
        let now = Date(), timestamp = Int(now.timeIntervalSince1970 * 1000)
        let device = DevicesPageDevicesItem(deviceId: "fixture-device", role: .device, platform: .macos,
            name: "离线补测 Mac", online: false, lastSeen: timestamp, paired: true)
        let row = HistoryItem(runId: "cached-" + marker, deviceId: device.deviceId,
            intent: "已缓存长详情 · " + marker.prefix(8), startedAt: timestamp, finishedAt: timestamp + 1200,
            ok: false, status: .cancelled, summary: "隔离数据，未执行真实任务")
        let missing = HistoryItem(runId: "missing-" + marker, deviceId: device.deviceId,
            intent: "未下载详情 · " + marker.prefix(8), startedAt: timestamp - 1000)
        let plan = [
            PlanStep(id: "read", title: "读取报告目录中的文件名，保留原始顺序，不修改或上传任何文件", status: .done),
            PlanStep(id: "compare", title: "比较两份月度报告的列名与日期格式，列出需要人工核对的不一致项目", status: .done),
            PlanStep(id: "review", title: "展示差异摘要与完整目标路径，等待用户确认后才允许写入", status: .awaitingApproval),
            PlanStep(id: "archive", title: "取消未获批准的归档步骤，保留源文件与已读取的原始输出", status: .cancelled)
        ]
        let events: [AnyMessage] = [
            .planUpdated(PlanUpdated(id: "plan", runId: row.runId, plan: plan)),
            .stepPrecheck(StepPrecheck(id: "precheck", runId: row.runId, stepId: "review", staticLevel: .l1,
                level: .l2, intentMatch: true, risk: 0.63, confidence: 0.89, jevMs: 27.5, verdict: .confirm, source: .cache)),
            .stepFinished(StepFinished(id: "output", runId: row.runId, stepId: "read", ok: true, ms: 1234.5,
                dataLeftDevice: false, output: (1...12).map { "隔离输出第 \($0) 行：仅用于检查长历史滚动" }.joined(separator: "\n"))),
            .terminalSuggestion(TerminalSuggestion(id: "suggestion", runId: row.runId,
                command: "find './Reports/Monthly review' -type f -name '*.csv' -print",
                explanation: "只建议列出所选目录的文件名；未建立终端会话，也未执行这条命令。", level: .l1)),
            .stepApprovalRequired(StepApprovalRequired(id: "old-approval", runId: row.runId, stepId: "review", level: .l2,
                action: ConcreteAction(channel: .shell, summary: "过期操作", detail: "printf 'ARCHIVED-ONLY'"),
                reason: "过期的隔离数据，不能再次批准", expiresAt: 1, challenge: "expired-fixture-challenge")),
            .runFinished(RunFinished(id: "end", runId: row.runId, ok: false, status: .cancelled,
                summary: "这是一条从本机存档读回的隔离记录。\n最后一行 · " + marker,
                cost: Cost(inputTokens: 0, outputTokens: 0, usd: 0, unknownPrice: true), stepCount: 4, cancelled: true))
        ]
        let detail = try HistoryStore.validatedDetail(HistoryDetail(id: "cached-detail", item: row,
            events: events.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) }))
        try store.save(.init(scope: scope, device: device, items: [row, missing], listReceivedAt: now,
            nextCursor: nil, details: [row.runId: detail], detailReceivedAt: [row.runId: now]))
        try store.remember(scope)
    }
}
#endif
