import CuaRemoteProtocol
import SwiftUI

struct ShortcutsView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    @State private var editing: Shortcut?
    @State private var showEditor = false
    @State private var deleting: Shortcut?
    var body: some View {
        let state = model.data(for: deviceID)
        let online = model.connected && model.devices.contains { $0.deviceId == deviceID && $0.online }
        ProductPage {
            ResourceStatus(state: state, resource: .shortcuts)
            if let failure = state.shortcutOrderError {
                Text("排序尚未确认：\(failure)。请检查设备回读的列表后重试。")
                    .font(.footnote).foregroundStyle(.red).accessibilityIdentifier("shortcutOrderError")
            }
            if let shortcuts = state.shortcuts {
                Text(state.shortcutReplyID == nil ? "上次读取的快捷指令" : "已从 Mac 读取 \(shortcuts.count) 条")
                    .font(.caption).foregroundStyle(Design.secondary)
                    .accessibilityIdentifier("shortcut-readback-" + (state.shortcutReplyID ?? "cached"))
                if shortcuts.isEmpty { Text("尚未保存快捷指令").foregroundStyle(Design.secondary) }
                ForEach(Array(shortcuts.enumerated()), id: \.element.id) { index, shortcut in
                    let upDisabled = index == 0 || state.pending[.shortcuts] != nil || !online
                    let downDisabled = index == shortcuts.count - 1 || state.pending[.shortcuts] != nil || !online
                    ProductCard {
                        HStack {
                            Text(shortcut.name).font(.headline).accessibilityIdentifier("shortcut-name-" + shortcut.id)
                            Spacer()
                            if shortcuts.count > 1 {
                                Button { Task { await model.moveShortcut(shortcut.id, by: -1, device: deviceID) } } label: {
                                    Image(systemName: "arrow.up").frame(width: 44, height: 44)
                                }.accessibilityLabel("上移 " + shortcut.name)
                                    .disabled(upDisabled).opacity(upDisabled ? 0.28 : 1)
                                Button { Task { await model.moveShortcut(shortcut.id, by: 1, device: deviceID) } } label: {
                                    Image(systemName: "arrow.down").frame(width: 44, height: 44)
                                }.accessibilityLabel("下移 " + shortcut.name)
                                    .disabled(downDisabled).opacity(downDisabled ? 0.28 : 1)
                            }
                        }
                        Text(shortcut.body).font(.footnote.monospaced()).textSelection(.enabled)
                        Text(shortcut.runIn == .agent ? "自然语言任务" : shortcut.runIn == .terminal ? "终端命令" : "SSH（需先连接主机）")
                            .font(.caption).foregroundStyle(Design.secondary)
                        HStack {
                            Button("运行") { Task { await model.runShortcut(shortcut, device: deviceID) } }
                                .disabled(model.busy || shortcut.runIn == .ssh)
                            Spacer()
                            Button("编辑") { editing = shortcut; showEditor = true }
                                .disabled(state.pending[.shortcuts] != nil)
                            Button("删除", role: .destructive) { deleting = shortcut }
                                .disabled(state.pending[.shortcuts] != nil)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("shortcut-actions-" + shortcut.id)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("shortcut-card-" + shortcut.id)
                }
            }
        }.productNavigation("快捷指令", actionIcon: "plus", actionLabel: "新建快捷指令", actionID: "addShortcut", actionDisabled: state.pending[.shortcuts] != nil) {
            editing = nil; showEditor = true
        }
            .task { if model.connection != nil { await model.request(.shortcuts, device: deviceID) { .shortcutsGet(ShortcutsGet(id: $0)) } } }
            .refreshable { await model.request(.shortcuts, device: deviceID) { .shortcutsGet(ShortcutsGet(id: $0)) } }
            .onChange(of: online) { _, value in
                if value { Task { await model.request(.shortcuts, device: deviceID) { .shortcutsGet(ShortcutsGet(id: $0)) } } }
            }
            .sheet(isPresented: $showEditor) { ShortcutEditor(model: model, deviceID: deviceID, original: editing) }
            .confirmationDialog("删除这条快捷指令？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("删除", role: .destructive) {
                    if let shortcut = deleting {
                        Task { await model.request(.shortcuts, device: deviceID) { .shortcutDelete(ShortcutDelete(id: $0, shortcutId: shortcut.id)) } }
                    }
                    deleting = nil
                }
            }
    }
}

struct ShortcutEditor: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    let original: Shortcut?
    @Environment(\.dismiss) private var dismiss
    @State private var newID = UUID().uuidString
    @State private var name = ""
    @State private var bodyText = ""
    @State private var runIn = ShortcutRunIn.agent
    @State private var level = Level.l1
    @State private var submitted = false
    private var shortcutID: String { original?.id ?? newID }
    var body: some View {
        let state = model.data(for: deviceID)
        NavigationStack {
            ProductPage {
                ProductSection(title: "名称") {
                    TextField("给指令起个名字", text: $name).productField().accessibilityIdentifier("shortcutName")
                }
                ProductSection(title: "内容") {
                    TextEditor(text: $bodyText).frame(minHeight: 130).font(.body.monospaced())
                        .scrollContentBackground(.hidden).productField()
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("shortcutBody")
                }
                ProductCard {
                    Picker("执行方式", selection: $runIn) {
                        Text("自然语言任务").tag(ShortcutRunIn.agent)
                        Text("终端命令").tag(ShortcutRunIn.terminal)
                        if original?.runIn == .ssh { Text("SSH · 需先连接主机").tag(ShortcutRunIn.ssh) }
                    }
                    Picker("风险标注", selection: $level) {
                        Text("只读").tag(Level.l0); Text("修改内容").tag(Level.l1); Text("高风险").tag(Level.l2)
                    }
                }
                VStack(alignment: .leading, spacing: 14) {
                    ResourceStatus(state: state, resource: .shortcuts)
                    Text("风险标注不是授权。每次执行仍由设备检查实际动作，需要确认时会停下。")
                        .font(.footnote).foregroundStyle(Design.secondary)
                    Button("保存到 Mac") {
                        hideKeyboard(); submitted = true
                        let value = Shortcut(id: shortcutID, name: name, body: bodyText, runIn: runIn, sshHostId: original?.sshHostId, level: level)
                        Task { await model.request(.shortcuts, device: deviceID) { .shortcutPut(ShortcutPut(id: $0, shortcut: value)) } }
                    }.buttonStyle(PrimaryButtonStyle())
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || bodyText.isEmpty || state.pending[.shortcuts] != nil)
                        .accessibilityIdentifier("saveShortcut")
                }
            }.productNavigation(original == nil ? "新建快捷指令" : "编辑快捷指令", back: false, close: true)
                .onAppear {
                    if let original { name = original.name; bodyText = original.body; runIn = original.runIn; level = original.level }
                }
                .onChange(of: state.pending[.shortcuts]) { _, pending in
                    if submitted, pending == nil, state.errors[.shortcuts] == nil,
                       let stored = state.shortcuts?.first(where: { $0.id == shortcutID }), stored.name == name, stored.body == bodyText {
                        dismiss()
                    }
                }
        }
    }
}

struct PrivacyView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    var body: some View {
        let state = model.data(for: deviceID)
        ProductPage {
            ResourceStatus(state: state, resource: .privacy)
            if let saved = state.privacy {
                PrivacyEditor(model: model, deviceID: deviceID, saved: saved).id(saved.id)
                ProductCard {
                    Text("数据去哪了").font(.headline)
                    ForEach(Array(saved.dataFlow.enumerated()), id: \.offset) { _, flow in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(flow.data + " → " + flow.destination).font(.subheadline)
                            Text(flow.reason).font(.caption).foregroundStyle(Design.secondary)
                        }
                    }
                }.accessibilityIdentifier("privacyDataFlow")
            } else if state.pending[.privacy] == nil { Text("尚未读取设备设置，不显示本地猜测值") }
        }.productNavigation("隐私与模型")
            .task {
                guard model.connection != nil else { return }
                await model.request(.privacy, device: deviceID) { .privacyGet(PrivacyGet(id: $0)) }
                await model.request(.models, device: deviceID) { .modelsList(ModelsList(id: $0)) }
            }
    }
}

struct PrivacyEditor: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    let saved: PrivacyState
    @State private var draft: PrivacySettings
    init(model: PhoneModel, deviceID: String, saved: PrivacyState) {
        self.model = model; self.deviceID = deviceID; self.saved = saved
        _draft = State(initialValue: saved.settings)
    }
    var body: some View {
        let state = model.data(for: deviceID)
        ProductCard {
            Text("设备有效设置").font(.headline)
            LabeledContent("任务引擎位置", value: saved.settings.brainLocation == .local ? "此设备" : saved.settings.brainLocation.rawValue)
            Text("引擎在设备运行，不等于模型数据不外发；以下方实际数据去向为准。")
                .font(.caption).foregroundStyle(Design.secondary)
            Picker("自主程度", selection: $draft.autonomy) {
                Text("谨慎确认").tag(PrivacySettingsAutonomy.cautious)
                Text("按风险确认").tag(PrivacySettingsAutonomy.balanced)
                Text("更少确认（高风险仍需确认）").tag(PrivacySettingsAutonomy.handsoff)
            }
            Picker("模型类型", selection: $draft.modelTier) {
                Text("标准模型").tag(ModelTier.standard); Text("本地模型").tag(ModelTier.local)
                Text("自带密钥").tag(ModelTier.byok); Text("零留存（需资格）").tag(ModelTier.zdr)
            }
            if let catalog = state.models {
                ForEach(catalog.models, id: \.id) { entry in
                    Button {
                        draft.modelTier = entry.tier
                        if entry.tier == .local { draft.localBrainModel = entry.id } else { draft.cloudModel = entry.id }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.label)
                            Text(entry.available ? entry.id : entry.unavailableReason ?? "当前不可用").font(.caption)
                            Text(entry.unknownPrice == false
                                 ? "每百万输入 / 输出 token：$\(entry.priceIn.formatted()) / $\(entry.priceOut.formatted())（不含设备成本）"
                                 : "价格未知，不能据此结算").font(.caption).foregroundStyle(Design.secondary)
                        }
                    }.disabled(!entry.available)
                }
            }
            ResourceStatus(state: state, resource: .models)
            Text("已保存模型：\(saved.settings.modelTier == .local ? saved.settings.localBrainModel ?? "未指定" : saved.settings.cloudModel ?? "设备启动时选择的模型")")
                .font(.footnote).foregroundStyle(Design.secondary)
            Text("同步、远程执行和专用评估模型尚未接通，不能在这里开启；价格与余额未核实。")
                .font(.footnote).foregroundStyle(Design.secondary)
            Button("保存设置") { Task { await model.request(.privacy, device: deviceID) { .privacySet(PrivacySet(id: $0, settings: draft)) } } }
                .buttonStyle(PrimaryButtonStyle()).disabled(model.busy || state.pending[.privacy] != nil)
                .accessibilityIdentifier("savePrivacy")
            Text("保存后以设备回读为准，失败不会改动上面的有效设置。")
                .font(.caption).foregroundStyle(Design.secondary)
        }
    }
}
