import CuaRemoteProtocol
import SwiftUI

extension RunStatus {
    var tone: StatusTone {
        switch self {
        case .succeeded: .success
        case .failed, .denied: .danger
        case .cancelled: .neutral
        }
    }

    var title: String {
        switch self {
        case .succeeded: "任务完成"
        case .failed: "执行失败"
        case .denied: "已拒绝"
        case .cancelled: "已取消"
        }
    }

    var icon: String {
        switch self {
        case .succeeded: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle"
        case .denied: "hand.raised"
        case .cancelled: "stop.circle"
        }
    }
}

extension RunFinished {
    var resultTone: StatusTone { status?.tone ?? (cancelled == true ? .neutral : ok ? .success : .danger) }
    var resultTitle: String { status?.title ?? (cancelled == true ? "已取消" : ok ? "任务完成" : "任务未完成") }
    var resultIcon: String { status?.icon ?? (cancelled == true ? "stop.circle" : ok ? "checkmark.circle.fill" : "xmark.circle") }
    var wasSuccessful: Bool { status.map { $0 == .succeeded } ?? (ok && cancelled != true) }
}

extension HistoryItem {
    var resultTone: StatusTone { status?.tone ?? (finishedAt == nil ? .warning : ok == true ? .success : .danger) }
    var resultTitle: String { status?.title ?? (finishedAt == nil ? "未结束" : ok == true ? "任务完成" : "任务未完成") }
    var resultIcon: String { status?.icon ?? (finishedAt == nil ? "clock" : ok == true ? "checkmark.circle" : "xmark.circle") }
}

extension PlanStepStatus {
    var tone: StatusTone {
        switch self {
        case .done: .success
        case .failed: .danger
        case .awaitingApproval: .warning
        case .pending, .running, .skipped, .cancelled: .neutral
        }
    }

    var label: String {
        switch self {
        case .pending: "待执行"
        case .running: "执行中"
        case .awaitingApproval: "等你确认"
        case .done: "完成"
        case .failed: "未完成"
        case .skipped: "跳过"
        case .cancelled: "已取消"
        }
    }
}

struct StepPrecheckDetails: View {
    let value: StepPrecheck
    var tone: StatusTone { value.verdict == .allow ? .success : value.verdict == .confirm ? .warning : .danger }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("检查结果：" + (value.verdict == .confirm ? "需要确认" : value.verdict == .deny ? "禁止" : "允许"))
                .fontWeight(.semibold).foregroundStyle(tone.foreground)
            Text("检查来源：" + value.source.rawValue)
            Text("静态风险等级：\(value.staticLevel.rawValue) · 最终风险等级：\(value.level.rawValue)")
                .foregroundStyle(value.level.tone.foreground)
            if let match = value.intentMatch { Text("符合任务意图：" + (match ? "是" : "否")) }
            if let risk = value.risk { Text("风险值：" + risk.formatted()) }
            if let confidence = value.confidence { Text("置信度：" + confidence.formatted()) }
            if let ms = value.jevMs { Text("Jev 检查耗时：" + ms.formatted() + " 毫秒") }
        }.font(.footnote)
    }
}

struct StepResultDetails: View {
    let value: StepFinished
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProductCode(text: value.output ?? value.error ?? "没有文本输出")
            Text("实际耗时：" + value.ms.formatted() + " 毫秒").font(.caption)
            Text("数据离机：" + (value.dataLeftDevice ? "是" : "否") + "（设备报告）")
                .font(.caption).foregroundStyle(Design.secondary)
        }
    }
}

struct HistoryView: View {
    @Bindable var model: PhoneModel
    var isHome = false
    var currentTaskRequest = 0
    @State private var search = ""
    @State private var filter = "全部"
    @State private var showCurrent = false
    @State private var openedRunID: String?
    var body: some View {
        let deviceID = model.selectedDevice
        let online = model.connected && model.devices.contains { $0.deviceId == deviceID && $0.online }
        ProductPage {
            if isHome {
                ProductSearch(text: $search, prompt: "搜索历史任务", identifier: "historySearch")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(["全部", "任务完成", "执行失败", "已取消", "已拒绝"], id: \.self) { value in
                            Button(value) { filter = value }
                                .font(.caption.weight(.semibold)).padding(.horizontal, 16).frame(minHeight: 40)
                                .foregroundStyle(filter == value ? Design.inkText : Design.secondary)
                                .background(filter == value ? Design.ink : Design.card, in: Capsule())
                        }
                    }
                }
                if model.busy || model.completion != nil || !model.events.isEmpty {
                    Button { showCurrent = true } label: {
                        ProductList { ProductRow(title: model.busy ? "当前任务正在执行" : "查看本次执行详情",
                            subtitle: model.completion?.resultTitle ?? "等待设备结果", icon: "waveform.path") }
                    }.accessibilityIdentifier("currentActivity")
                }
            }
            DeviceSelector(model: model)
            if let error = model.historyCacheError { Text(error).foregroundStyle(.red).accessibilityIdentifier("historyCacheError") }
            if !deviceID.isEmpty {
                let state = model.data(for: deviceID)
                if isHome {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(online ? "设备在线 · 历史只供查看" : "设备离线 · 本机历史只读")
                            .accessibilityIdentifier("historyAvailability")
                        if let scope = model.historyScope { Text("来源：" + scope.relay) }
                        if let date = state.historyCachedAt {
                            Text("已保存到本机 · 收到于 " + date.formatted(date: .abbreviated, time: .shortened))
                                .accessibilityIdentifier("historySavedAt")
                        }
                        if let error = state.historyStorageError { Text(error).foregroundStyle(.red) }
                    }.font(.caption).foregroundStyle(Design.secondary)
                } else { HistoryStorageNotice(model: model, state: state, online: online, savedAt: state.historyCachedAt) }
                ResourceStatus(state: state, resource: .history)
                if let items = state.history {
                    let matching = items.filter { (filter == "全部" || $0.resultTitle == filter) && (search.isEmpty || $0.intent.localizedCaseInsensitiveContains(search)) }
                    let grouped = Dictionary(grouping: matching) { Calendar.current.startOfDay(for: Date(timeIntervalSince1970: Double($0.startedAt) / 1000)) }
                    if items.isEmpty { ProductEmpty(icon: "clock", title: "还没有执行记录", detail: "设备返回的历史列表为空。新建任务后，在这里查看执行记录。") }
                    if !items.isEmpty && matching.isEmpty {
                        ProductEmpty(icon: "magnifyingglass", title: "没有匹配的记录", detail: "试试其他关键词，或清除筛选条件。")
                        Button("清除搜索与筛选") { search = ""; filter = "全部" }
                            .buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("clearHistoryFilter")
                    }
                    ForEach(grouped.keys.sorted(by: >), id: \.self) { day in
                        ProductSection(title: Calendar.current.isDateInToday(day) ? "今天" : day.formatted(date: .abbreviated, time: .omitted)) {
                            ProductList {
                                ForEach((grouped[day] ?? []).sorted { $0.startedAt > $1.startedAt }, id: \.runId) { item in
                                    NavigationLink { HistoryDetailView(model: model, deviceID: deviceID, item: item) } label: {
                                        ProductRow(title: item.intent,
                                            subtitle: item.resultTitle + " · " + Date(timeIntervalSince1970: Double(item.startedAt) / 1000).formatted(date: .omitted, time: .shortened),
                                            icon: item.resultIcon, tone: item.resultTone)
                                    }.accessibilityIdentifier("history-" + item.runId)
                                    if item.runId != grouped[day]?.last?.runId { Divider().padding(.leading, 74) }
                                }
                            }
                        }
                    }
                    if state.historyCursor != nil {
                        Button("加载更早记录") { Task { await model.refreshHistory(deviceID, more: true) } }
                            .disabled(!online || state.pending[.history] != nil)
                    }
                } else { Text("尚未保存这台设备的历史列表，需要在线获取").foregroundStyle(Design.secondary) }
            } else if model.historyCacheError == nil {
                ProductEmpty(icon: "clock", title: "还没有活动", detail: "连接设备后，在这里查看真实执行记录和保存在手机上的历史。")
            }
        }.productNavigation(isHome ? "活动" : "执行历史", back: !isHome)
            .navigationDestination(isPresented: $showCurrent) { ActivityView(model: model) }
            .onChange(of: currentTaskRequest) { if isHome { showCurrent = true } }
            .onChange(of: model.runID, initial: true) { _, value in
                if isHome, model.busy, let value, value != openedRunID {
                    openedRunID = value; showCurrent = true
                }
            }
            .task(id: deviceID + String(online)) { if online, model.connection != nil { await model.refreshHistory(deviceID) } }
            .refreshable { if online { await model.refreshHistory(deviceID) } }
    }
}

private struct HistoryStorageNotice: View {
    let model: PhoneModel
    let state: DeviceData
    let online: Bool
    let savedAt: Date?
    var body: some View {
        ProductCard {
            Label(online ? "设备在线 · 历史只供查看" : "设备离线 · 本机历史只读", systemImage: online ? "clock" : "wifi.slash")
                .font(.subheadline.weight(.semibold)).accessibilityIdentifier("historyAvailability")
            if let scope = model.historyScope {
                Text("来源：" + scope.relay).font(.caption).textSelection(.enabled)
                Text("来源标识：" + scope.sourceID.prefix(12) + " · 手机：" + scope.phoneID).font(.caption2.monospaced())
                if scope.privateAddress { Text("连接地址含私有参数；重启后如需联网，请重新输入完整地址。").font(.caption) }
            }
            if let savedAt {
                Text("已保存到本机 · 收到于 " + savedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).accessibilityIdentifier("historySavedAt")
            } else { Text("尚未确认保存到本机").font(.caption) }
            if let error = state.historyStorageError { Text(error).font(.footnote).foregroundStyle(.red) }
        }.foregroundStyle(Design.secondary)
    }
}

struct HistoryDetailView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    let item: HistoryItem
    var body: some View {
        let state = model.data(for: deviceID)
        let online = model.connected && model.devices.contains { $0.deviceId == deviceID && $0.online }
        ProductPage {
            HistoryStorageNotice(model: model, state: state, online: online, savedAt: state.historyDetailCachedAt[item.runId])
            ProductCard {
                Text(item.intent).font(.headline)
                Label("历史记录只供查看，不能再次批准旧操作", systemImage: "clock.badge.checkmark")
                    .font(.footnote).foregroundStyle(Design.secondary)
            }
            ResourceStatus(state: state, resource: .detail)
            if let detail = state.historyDetails[item.runId] {
                Label(detail.item.resultTitle, systemImage: detail.item.resultIcon)
                    .font(.headline).foregroundStyle(detail.item.resultTone.foreground).accessibilityIdentifier("historyStatus")
                if let cost = detail.item.cost {
                    ProductCard {
                        LabeledContent("输入 / 输出 token", value: "\(cost.inputTokens) / \(cost.outputTokens)")
                        Text(cost.unknownPrice == false ? "模型调用费：$\(cost.usd.formatted())，不含设备成本，不代表已扣款" : "费用未核实，不作为扣款金额")
                            .font(.caption).foregroundStyle(Design.secondary)
                    }
                }
                ForEach(Array(detail.events.enumerated()), id: \.offset) { index, raw in
                    if let data = try? JSONEncoder().encode(raw),
                       let message = try? JSONDecoder().decode(AnyMessage.self, from: data) {
                        historicalEvent(message)
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("historyEvent-\(index)")
                    } else {
                        Text("这条旧事件暂无法读取，请保留设备上的原始记录").font(.footnote).foregroundStyle(.orange)
                    }
                }
            } else {
                Text("这条记录的详情尚未保存，需要设备在线时获取")
                    .foregroundStyle(Design.secondary).accessibilityIdentifier("historyDetailUnavailable")
            }
        }.productNavigation("任务详情")
            .task(id: String(online)) { if online, model.connection != nil { await model.loadHistory(item, device: deviceID) } }
            .refreshable { if online { await model.loadHistory(item, device: deviceID) } }
    }

    @ViewBuilder func historicalEvent(_ message: AnyMessage) -> some View {
        switch message {
        case .runCreated(let value) where value.runId == item.runId:
            ProductCard {
                Text("任务开始").font(.headline)
                Text(value.provider).font(.caption.monospaced())
                ForEach(value.plan, id: \.id) { Text($0.title).font(.subheadline) }
            }
        case .planUpdated(let value) where value.runId == item.runId:
            ProductCard {
                Text("计划更新").font(.headline)
                ForEach(value.plan, id: \.id) { step in
                    HStack(alignment: .top) {
                        Text(step.title).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        StatusBadge(text: step.status.label, tone: step.status.tone).fixedSize()
                    }.accessibilityElement(children: .combine)
                }
            }
        case .stepStarted(let value) where value.runId == item.runId:
            Text(value.title).font(.headline)
        case .stepPrecheck(let value) where value.runId == item.runId:
            ProductCard(tone: value.verdict == .confirm ? .warning : value.verdict == .deny ? .danger : nil) {
                Text("执行前检查").font(.headline)
                Text("步骤：" + value.stepId).font(.caption.monospaced())
                StepPrecheckDetails(value: value)
            }.font(.footnote)
        case .stepApprovalRequired(let value) where value.runId == item.runId:
            ProductCard(tone: .warning) {
                Text("当时需要确认的操作").font(.headline)
                Text(value.action.detail).font(.footnote.monospaced()).textSelection(.enabled)
                Text("旧请求已不可在此确认").font(.caption).foregroundStyle(Design.secondary)
            }
        case .stepFinished(let value) where value.runId == item.runId:
            ProductCard {
                Text(value.ok ? "步骤完成" : "步骤未完成").font(.headline)
                    .foregroundStyle(value.ok ? Design.green : Design.danger)
                StepResultDetails(value: value)
            }
        case .terminalSuggestion(let value) where value.runId == item.runId:
            ProductCard {
                Text("建议命令").font(.headline)
                Text("只是建议，未因此执行").font(.subheadline.weight(.semibold))
                Text(value.command).font(.footnote.monospaced()).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                Text(value.explanation).font(.footnote).fixedSize(horizontal: false, vertical: true)
                StatusBadge(text: "风险等级：\(value.level.rawValue)", tone: value.level.tone)
            }
        case .runFinished(let value) where value.runId == item.runId:
            ProductCard(tone: value.resultTone) {
                Label(value.resultTitle, systemImage: value.resultIcon).font(.headline).foregroundStyle(value.resultTone.foreground)
                Text(value.summary).textSelection(.enabled).accessibilityIdentifier("historySummary")
            }
        default: EmptyView()
        }
    }
}
