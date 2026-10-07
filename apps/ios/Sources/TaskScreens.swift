import SwiftUI
import CuaRemoteProtocol

struct ComposeView: View {
    @Bindable var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ProductPage {
                ProductCard {
                    TextField("说一句话，描述你想完成的事", text: $model.intent, axis: .vertical)
                        .lineLimit(3...8).disabled(model.busy).accessibilityIdentifier("intent")
                    HStack(alignment: .bottom) {
                        DeviceSelector(model: model)
                        Spacer(minLength: 8)
                        Button {
                            hideKeyboard()
                            Task {
                                await model.submit()
                                if model.busy || model.result != nil { model.tab = .activity; dismiss() }
                            }
                        } label: {
                            Image(systemName: "arrow.up").font(.title3.weight(.semibold)).frame(width: 48, height: 48)
                                .foregroundStyle(Design.inkText).background(Design.ink, in: Circle())
                        }.accessibilityLabel("发送给 Mac").accessibilityIdentifier("sendIntent")
                            .disabled(!canSend).opacity(canSend ? 1 : 0.35)
                    }
                }
                if let shortcuts = model.data(for: model.selectedDevice).shortcuts, !shortcuts.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(shortcuts.filter { $0.runIn == .agent }, id: \.id) { shortcut in
                                Button(shortcut.name) { model.intent = shortcut.body }
                                    .font(.caption).padding(.horizontal, 14).frame(minHeight: 44)
                                    .background(Design.card, in: Capsule()).disabled(model.busy)
                            }
                        }
                    }
                }
                Label("需要确认的操作会先停下，等你批准。", systemImage: "hand.raised")
                    .font(.footnote).foregroundStyle(Design.secondary)
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }.productNavigation("让设备做一件事", back: false, close: true)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer(); Button("完成输入") { hideKeyboard() }.accessibilityIdentifier("dismissKeyboard")
                    }
                }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            .presentationBackground(Design.background).presentationCornerRadius(30)
    }

    private var canSend: Bool {
        !model.busy && model.connected && !model.intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        model.devices.contains { $0.deviceId == model.selectedDevice && $0.online }
    }
}

struct ActivityView: View {
    @Bindable var model: PhoneModel
    var body: some View {
        ProductPage {
            if model.events.isEmpty && model.result == nil && !model.busy {
                ProductCard {
                    Label("还没有活动", systemImage: "clock").font(.title3.bold())
                    Text("新建任务后，在这里查看设备实际执行的每一步。")
                        .foregroundStyle(Design.secondary)
                }
            }
            if let result = model.completion {
                ProductCard(tone: result.resultTone) {
                    Label(result.resultTitle, systemImage: result.resultIcon)
                        .font(.title3.bold()).foregroundStyle(result.resultTone.foreground)
                        .accessibilityIdentifier("runStatus")
                    ForEach(model.events.filter { $0.success == true }) { event in
                        Text("Mac 原始工具输出").font(.caption).foregroundStyle(Design.secondary)
                        Text(event.detail).font(.callout.monospaced()).textSelection(.enabled)
                            .accessibilityIdentifier("toolOutput")
                    }
                    Text(result.summary).textSelection(.enabled).accessibilityIdentifier("runResult")
                }
            }
            if model.busy || model.cancellationMessage != nil {
                ProductCard {
                    if model.busy { HStack { ProgressView(); Text("等待设备执行结果").font(.headline) } }
                    CancellationControls(model: model)
                }
            }
            if !model.plan.isEmpty {
                Text("执行步骤").font(.headline)
                ForEach(model.plan, id: \.id) { step in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(spacing: 7) {
                            Image(systemName: step.status == .done ? "checkmark.circle.fill" : step.status == .failed ? "xmark.circle.fill" : step.status == .awaitingApproval ? "hand.raised.circle.fill" : "circle.dotted")
                                .font(.title3).foregroundStyle(!model.busy && [.pending, .running, .awaitingApproval].contains(step.status) ? Design.secondary : step.status.tone.foreground)
                            Rectangle().fill(Design.line).frame(width: 1)
                        }.frame(width: 24).padding(.top, 18)
                        VStack(alignment: .leading, spacing: 12) {
                        let unfinished = [.pending, .running, .awaitingApproval].contains(step.status)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(step.title).font(.subheadline.weight(.semibold))
                            StatusBadge(text: !model.busy && unfinished ? "步骤结果未确认" : step.status.label,
                                tone: !model.busy && unfinished ? .neutral : step.status.tone)
                        }
                        if let check = model.prechecks[step.id] {
                            StepPrecheckDetails(value: check)
                                .foregroundStyle(Design.secondary).padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(check.verdict == .confirm ? Design.warningWash : check.verdict == .deny ? Design.dangerWash : Design.well, in: RoundedRectangle(cornerRadius: 12))
                        }
                        if let result = model.stepResults[step.id] {
                            StepResultDetails(value: result)
                        }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                            .background(Design.card, in: RoundedRectangle(cornerRadius: 22))
                    }.accessibilityElement(children: .contain)
                        .accessibilityIdentifier("activityStep-" + step.id)
                }
            } else if !model.events.isEmpty {
                Text("执行记录").font(.headline)
                ForEach(model.events) { event in
                    ProductCard {
                        Label(event.title, systemImage: event.success == true ? "checkmark.circle" : event.success == false ? "xmark.circle" : "circle.dotted")
                            .font(.headline).foregroundStyle(event.success == true ? Design.green : event.success == false ? Design.danger : Design.secondary)
                        Text(event.detail).font(.footnote.monospaced()).textSelection(.enabled)
                            .foregroundStyle(Design.secondary)
                    }
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("errorMessage") }
        }.productNavigation("执行详情")
    }
}

struct CancellationControls: View {
    @Bindable var model: PhoneModel
    var inApproval = false
    var body: some View {
        if let message = model.cancellationMessage {
            Text(message).font(.footnote).foregroundStyle(Design.secondary)
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Design.warningWash, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier(inApproval ? "cancelApprovalStatus" : "cancelStatus")
        }
        Text("已开始的操作可能继续完成；取消不会撤销此前的修改。")
            .font(.footnote).foregroundStyle(Design.secondary)
        if model.busy, model.runID != nil {
            Button(role: .destructive) {
                Task { await model.cancel() }
            } label: {
                Text(model.approvalBlocked ? "重新请求取消任务" : "取消整个任务")
                    .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    .foregroundStyle(Design.danger).background(Design.dangerWash, in: Capsule())
            }
                .disabled(!model.canCancel).opacity(model.canCancel ? 1 : 0.4)
                .accessibilityIdentifier(inApproval ? "cancelApprovalRun" : "cancelRun")
        }
    }
}

struct TerminalHomeView: View {
    @Bindable var model: PhoneModel
    var body: some View {
        ProductPage {
            ProductEmpty(icon: "terminal", title: "还没有终端会话",
                detail: "配对设备终端和 SSH 尚未接通。这里不会显示模拟命令，也不会自动执行历史中的建议。")
        }.productNavigation("终端", back: false)
    }
}

struct ProfileView: View {
    @Bindable var model: PhoneModel
    var body: some View {
        ProductPage {
            ProductCard {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle").font(.system(size: 38)).frame(width: 58, height: 58)
                        .background(Design.well, in: RoundedRectangle(cornerRadius: 18))
                    VStack(alignment: .leading, spacing: 6) {
                        Text("我的设备空间").font(.headline)
                        Text(model.status).font(.caption).foregroundStyle(Design.secondary)
                    }
                }
                Divider()
                HStack {
                    Text("已配对设备").font(.subheadline).foregroundStyle(Design.secondary)
                    Spacer(); Text("\(model.devices.count)").font(.title2.bold())
                }
                Text("账号资料、余额和用量尚未接入，不显示估计值。").font(.caption).foregroundStyle(Design.secondary)
            }
            ProductSection(title: "设备与连接") {
                ProductList {
                Button { model.showConnection = true } label: {
                    ProductRow(title: "连接与配对", subtitle: "添加设备 · 管理中继连接", icon: "link")
                }.frame(minHeight: 44).accessibilityIdentifier("connectionSettings")
                }
            }
            ProductSection(title: "设备设置") {
                DeviceSelector(model: model)
                if !model.selectedDevice.isEmpty {
                    ProductList {
                    NavigationLink { PrivacyView(model: model, deviceID: model.selectedDevice) } label: {
                        ProductRow(title: "隐私、模型与数据去向", icon: "lock.shield")
                    }.frame(minHeight: 44).accessibilityIdentifier("privacySettings")
                    Divider().padding(.leading, 74)
                    NavigationLink { ShortcutsView(model: model, deviceID: model.selectedDevice) } label: {
                        ProductRow(title: "快捷指令", icon: "bolt")
                    }.frame(minHeight: 44).accessibilityIdentifier("shortcutsSettings")
                    }
                }
            }
            Text("密钥保存在本机 Keychain。" + model.signatureDescription + "，审批仅适用于显示的具体操作。")
                .font(.footnote).foregroundStyle(Design.secondary)
        }.productNavigation("我的", back: false)
    }
}
