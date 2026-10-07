import CuaRemoteProtocol
import SwiftUI

struct AppsView: View {
    @Bindable var model: PhoneModel
    @State private var search = ""
    var body: some View {
        let online = model.connected && model.devices.contains { $0.deviceId == model.selectedDevice && $0.online }
        ProductPage {
            ProductSearch(text: $search, prompt: "搜索设备上的应用", identifier: "appSearch")
            DeviceSelector(model: model)
            if !model.selectedDevice.isEmpty {
                let state = model.data(for: model.selectedDevice)
                ResourceStatus(state: state, resource: .apps)
                if let apps = state.apps {
                    if !online {
                        Text("设备离线，显示上次收到的清单").font(.caption).foregroundStyle(Design.secondary)
                            .accessibilityIdentifier("appsOffline")
                    }
                    let matching = apps.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.bundleId.localizedCaseInsensitiveContains(search) }
                    ForEach([true, false], id: \.self) { learned in
                        let group = matching.filter { $0.learned == learned }
                        if !group.isEmpty {
                            ProductSection(title: (learned ? "已学习" : "未学习") + " · \(group.count)") {
                                ProductList {
                                    ForEach(group, id: \.bundleId) { app in
                                        NavigationLink { AppDetailView(model: model, deviceID: model.selectedDevice, app: app) } label: {
                                            ProductRow(title: app.name, subtitle: app.bundleId, icon: "app",
                                                trailing: online ? (app.running ? "运行中" : "未运行") : (app.running ? "上次运行中" : "上次未运行"))
                                        }.accessibilityIdentifier("app-" + app.bundleId)
                                        if app.bundleId != group.last?.bundleId { Divider().padding(.leading, 74) }
                                    }
                                }
                            }
                        }
                    }
                    if matching.isEmpty { ProductEmpty(icon: "square.grid.2x2", title: "没有匹配的应用", detail: apps.isEmpty ? "设备返回了空应用清单。" : "试试其他名称或 bundle ID。") }
                    Text("清单来自设备回读；学习失败不会成为可用操作。").font(.caption).foregroundStyle(Design.secondary)
                }
            } else {
                ProductEmpty(icon: "square.grid.2x2", title: "连接你的应用", detail: "配对 Mac 后，这里会显示设备实际读取的应用清单。")
            }
        }.productNavigation("应用", back: false)
            .task(id: DeviceDashboardRefresh(deviceID: model.selectedDevice, connected: model.connected, online: online)) {
                if online, model.connection != nil { await model.refreshApps(model.selectedDevice) }
            }
            .refreshable { await model.refreshApps(model.selectedDevice) }
    }
}

struct AppDetailView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    let app: InstalledApp
    @State private var showHidden = false
    var body: some View {
        let state = model.data(for: deviceID)
        ProductPage {
            ProductCard {
                Label(app.name, systemImage: "app").font(.title2.bold())
                Text("只读学习会读取脚本字典和已运行应用的界面结构，再交给当前模型整理。不会自行打开应用或点击按钮。")
                    .font(.subheadline).foregroundStyle(Design.secondary)
                Button("开始只读学习") { Task { await model.startLearning(app.bundleId, device: deviceID) } }
                    .buttonStyle(PrimaryButtonStyle()).disabled(state.pending[.learning] != nil || model.busy)
                    .accessibilityIdentifier("learnApp")
                Text("会操作界面的探索尚未接入").font(.caption).foregroundStyle(Design.secondary)
            }
            if state.learningBundle == app.bundleId {
                ProductCard {
                    ResourceStatus(state: state, resource: .learning)
                    if let progress = state.learning {
                        Text("\(progress.phase.rawValue) · 找到 \(progress.found) 项").font(.headline).accessibilityIdentifier("learnProgress")
                    }
                    ForEach(Array(state.learningMessages.enumerated()), id: \.offset) { _, message in
                        Text(message).font(.footnote).foregroundStyle(Design.secondary)
                    }
                    if state.pending[.learning] != nil {
                        Button("停止学习", role: .destructive) {
                            Task {
                                do { try await model.connection?.send(AppLearnStop(id: UUID().uuidString, bundleId: app.bundleId), to: deviceID) }
                                catch { state.errors[.learning] = error.localizedDescription }
                            }
                        }
                    }
                }
            }
            ResourceStatus(state: state, resource: .cards)
            Toggle("显示隐藏卡片", isOn: $showHidden).tint(Design.greenFill)
            let cards = (state.cards ?? []).filter { $0.appBundleId == app.bundleId && (showHidden || $0.hidden != true) }
            ForEach(cards, id: \.id) { card in
                NavigationLink { AppCardView(model: model, deviceID: deviceID, card: card) } label: {
                    ProductCard {
                        HStack { Text(card.name).font(.headline); Spacer(); Image(systemName: "chevron.right") }
                        Text(card.description).font(.footnote).foregroundStyle(Design.secondary)
                        CapabilityBadges(card: card)
                    }
                }.buttonStyle(.plain)
            }
            if cards.isEmpty { Text("没有可展示的操作卡片。学习失败或不支持的能力不会被当作可用操作。") .foregroundStyle(Design.secondary) }
        }.productNavigation(app.name)
    }
}

struct AppCardView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    let card: CapabilityCard
    @State private var values: [String: String] = [:]
    @State private var name = ""
    @State private var hidden = false
    var body: some View {
        let state = model.data(for: deviceID)
        ProductPage {
            ProductCard {
                Text(card.description).font(.headline)
                CapabilityBadges(card: card)
                Text("检查操作内容后再执行。改名和隐藏只影响展示，不会改变脚本。")
                    .font(.footnote).foregroundStyle(Design.secondary)
                Text(card.action.template).font(.footnote.monospaced()).textSelection(.enabled)
            }
            ProductCard {
                if card.control == .list {
                    Text("此卡片需要先读取实际列表；列表查询尚未接通，不能执行未确认的选项。")
                } else {
                    ForEach(card.fields ?? [], id: \.key) { field in
                        if field.kind == .bool {
                            Toggle(field.label, isOn: Binding(get: { values[field.key] == "true" }, set: { values[field.key] = String($0) }))
                                .tint(Design.greenFill)
                        } else if field.kind == .choice {
                            Picker(field.label, selection: fieldValue(field.key)) {
                                Text("请选择").tag("")
                                ForEach(field.choices ?? [], id: \.self) { Text($0).tag($0) }
                            }
                        } else {
                            TextField(field.label, text: fieldValue(field.key), axis: .vertical)
                                .keyboardType(field.kind == .number ? .decimalPad : .default)
                        }
                    }
                    Button("执行这张卡片") { Task { await model.runCard(card, params: values, device: deviceID) } }
                        .buttonStyle(PrimaryButtonStyle()).disabled(model.busy || card.hidden == true || !valid)
                }
            }
            ProductCard {
                TextField("卡片名称", text: $name)
                Toggle("隐藏卡片", isOn: $hidden).tint(Design.greenFill)
                Button("保存展示设置") {
                    Task { await model.request(.cards, device: deviceID) { .appCardUpdate(AppCardUpdate(id: $0, cardId: card.id, name: name, hidden: hidden)) } }
                }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.pending[.cards] != nil)
                ResourceStatus(state: state, resource: .cards)
                if let saved = state.cards?.first(where: { $0.id == card.id }) {
                    Text("设备当前保存：\(saved.name) · \(saved.hidden == true ? "隐藏" : "显示")").font(.caption).foregroundStyle(Design.secondary)
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.red) }
        }.productNavigation(card.name)
            .onAppear {
                name = card.name; hidden = card.hidden ?? false
                for field in card.fields ?? [] where field.kind == .bool && values[field.key] == nil { values[field.key] = "false" }
            }
    }

    private var valid: Bool { (card.fields ?? []).allSatisfy { $0.required != true || !(values[$0.key] ?? "").isEmpty } }
    private func fieldValue(_ key: String) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { values[key] = $0 })
    }
}

private struct CapabilityBadges: View {
    let card: CapabilityCard
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                StatusBadge(text: "风险等级 \(card.staticLevel.rawValue)", tone: card.staticLevel.tone)
                StatusBadge(text: card.action.kind.rawValue, tone: card.action.kind == .gui ? .info : .neutral)
            }
            Text("来源：" + card.source.rawValue + (card.hidden == true ? " · 已隐藏" : ""))
                .font(.caption).foregroundStyle(card.action.kind == .gui ? Design.blue : Design.secondary)
        }
    }
}
