import SwiftUI
import CuaRemoteProtocol

struct DevicesView: View {
    @Bindable var model: PhoneModel
    @Environment(\.dynamicTypeSize) private var typeSize
    private var device: DevicesPageDevicesItem? { model.devices.first { $0.deviceId == model.selectedDevice } ?? model.devices.first }
    var body: some View {
        ProductPage {
            if model.devices.isEmpty {
                ProductEmpty(icon: "laptopcomputer.and.iphone", title: "把你的 Mac 放进口袋",
                    detail: "连接你自己的设备，用一句话发起任务；需要确认的操作，由你决定。")
                Button("添加设备") { model.showConnection = true }.buttonStyle(PrimaryButtonStyle())
                    .accessibilityIdentifier("addDevice")
                Label("不会自动扫描或控制其他设备", systemImage: "lock.shield")
                    .font(.footnote).foregroundStyle(Design.secondary)
            } else if let device {
                let online = model.connected && device.online
                let state = model.data(for: device.deviceId)
                Menu {
                    ForEach(model.devices, id: \.deviceId) { value in
                        Button(value.name) { model.selectedDevice = value.deviceId }
                    }
                    Button("添加设备") { model.showConnection = true }
                } label: {
                    HStack {
                        Image(systemName: "desktopcomputer")
                        Text(device.name).font(.subheadline.weight(.semibold))
                        Spacer()
                        StatusBadge(text: online ? "在线" : "未连接", tone: online ? .success : .neutral)
                        Image(systemName: "chevron.down").font(.caption)
                    }.padding(14).background(Design.card, in: RoundedRectangle(cornerRadius: 22))
                        .foregroundStyle(Design.text)
                }.accessibilityIdentifier("deviceSwitcher")
                if model.approval != nil {
                    Label("1 个操作等待你确认", systemImage: "hand.raised")
                        .font(.subheadline.weight(.semibold)).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(Design.warning).background(Design.warningWash, in: RoundedRectangle(cornerRadius: 22))
                }
                if !online {
                    ProductCard {
                        Label("这台 Mac 当前离线", systemImage: "wifi.slash").font(.subheadline.bold())
                        Text("不能读取实时状态或下发操作。指令不会排队，历史仍可在本机查看。")
                            .font(.footnote).foregroundStyle(Design.secondary)
                    }
                }
                VStack(spacing: 0) {
                    VStack(spacing: 10) {
                        Image(systemName: "rectangle.dashed").font(.system(size: 30)).foregroundStyle(Design.secondary)
                        Text("画面尚未接通").font(.subheadline.weight(.semibold))
                        Text("这里不会显示模拟桌面").font(.caption).foregroundStyle(Design.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 154).padding(.vertical, 12).background(Design.well)
                    HStack {
                        Text("设备画面").font(.caption).foregroundStyle(Design.secondary)
                        Spacer()
                        Text("暂不可用").font(.caption.weight(.semibold))
                    }.padding(.horizontal, 14).padding(.vertical, 13).background(Design.card)
                }.clipShape(RoundedRectangle(cornerRadius: 22)).accessibilityIdentifier("devicePreview")
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 12) {
                    StatTile(title: "CPU", value: online ? state.stats?.cpuPercent.map { $0.formatted(.number.precision(.fractionLength(0))) + "%" } : nil,
                        progress: online ? state.stats?.cpuPercent.map { $0 / 100 } : nil)
                    StatTile(title: "内存", value: online ? state.stats?.memUsedMB.map { ($0 / 1024).formatted(.number.precision(.fractionLength(1))) + " GB" } : nil,
                        subtitle: state.stats?.memTotalMB.map { "/ " + ($0 / 1024).formatted(.number.precision(.fractionLength(0))) + " GB" },
                        progress: online ? state.stats?.memoryFraction : nil)
                    StatTile(title: "磁盘", value: online ? state.stats?.diskFreeGB.map { $0.formatted(.number.precision(.fractionLength(0))) + " GB" } : nil, subtitle: "可用空间")
                    StatTile(title: "电源", value: online ? state.stats?.batteryPercent.map { $0.formatted(.number.precision(.fractionLength(0))) + "%" } : nil,
                        subtitle: online && state.stats != nil && state.stats?.batteryPercent == nil ? "设备未提供电池信息" : state.stats?.charging.map { $0 ? "充电中" : "未充电" })
                }
                ProductSection(title: "快捷控制") {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 9) { quickControls }
                        VStack(alignment: .leading, spacing: 9) { quickControls }
                    }
                }
                ProductSection(title: online ? "运行中的应用" : "上次收到的运行应用") {
                    if let apps = state.apps {
                        ProductList {
                            ForEach(apps.filter(\.running), id: \.bundleId) { app in
                                NavigationLink { AppDetailView(model: model, deviceID: device.deviceId, app: app) } label: {
                                    ProductRow(title: app.name, subtitle: app.bundleId, icon: "app", trailing: app.learned ? "已学习" : "未学习")
                                }
                                Divider().padding(.leading, 74)
                            }
                        }
                        if !apps.contains(where: \.running) { Text("没有已回报的运行中应用").font(.footnote).foregroundStyle(Design.secondary) }
                    } else { Text("尚未读取应用清单").font(.footnote).foregroundStyle(Design.secondary) }
                }
                NavigationLink { DeviceDetailView(model: model, deviceID: device.deviceId) } label: {
                    ProductList { ProductRow(title: "设备详情与权限", subtitle: "已配对 · 端到端加密", icon: "slider.horizontal.3") }
                }.accessibilityIdentifier("device-" + device.deviceId)
                Text(online ? "状态来自设备回读，非持续采样。" : "离线状态不会被缓存数据改为在线。")
                    .font(.caption).foregroundStyle(Design.secondary).accessibilityIdentifier("connectionStatus")
                ResourceStatus(state: state, resource: .stats)
            }
            if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("errorMessage") }
        }
        .productNavigation("设备", back: false, actionIcon: model.devices.isEmpty ? nil : "plus", actionLabel: "添加设备", actionID: "addDevice") {
            model.showConnection = true
        }
        .task(id: DeviceDashboardRefresh(deviceID: device?.deviceId, connected: model.connected, online: device?.online == true)) {
            if let device, model.connection != nil, model.connected, device.online {
                await model.refreshDevice(device.deviceId); await model.refreshApps(device.deviceId)
            }
        }
    }

    @ViewBuilder private var quickControls: some View {
        Button { model.showCompose = true } label: { Label("新任务", systemImage: "sparkles") }
            .disabled(model.busy || !model.connected).accessibilityIdentifier("newTask")
            .font(.subheadline.weight(.semibold)).padding(.horizontal, 15).frame(minHeight: 44).background(Design.card, in: Capsule())
        Button { model.tab = .activity } label: { Label("查看活动", systemImage: "clock") }
            .font(.subheadline.weight(.semibold)).padding(.horizontal, 15).frame(minHeight: 44).background(Design.card, in: Capsule())
    }
}

struct DeviceDashboardRefresh: Equatable {
    let deviceID: String?
    let connected: Bool
    let online: Bool
}

extension DeviceStats {
    var memoryFraction: Double? {
        guard let used = memUsedMB, let total = memTotalMB,
              total > 0, used >= 0, used <= total else { return nil }
        return used / total
    }
}

private struct StatTile: View {
    let title: String
    let value: String?
    var subtitle: String?
    var progress: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Design.secondary)
            Text(value ?? "—").font(.title2.bold()).minimumScaleFactor(0.8).lineLimit(1)
            Text(subtitle ?? (value == nil ? "尚未收到" : "设备报告")).font(.caption2).foregroundStyle(Design.secondary)
            if let progress {
                GeometryReader { proxy in
                    Capsule().fill(Design.line).overlay(alignment: .leading) {
                        Capsule().fill(Design.greenFill).frame(width: proxy.size.width * min(1, max(0, progress)))
                    }
                }.frame(height: 5)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 15).padding(.horizontal, 16)
            .background(Design.card, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct DeviceDetailView: View {
    @Bindable var model: PhoneModel
    let deviceID: String
    @State private var showRename = false
    @State private var showUnpair = false
    @State private var name = ""
    private var state: DeviceData { model.data(for: deviceID) }
    var body: some View {
        ProductPage {
            if let device = model.devices.first(where: { $0.deviceId == deviceID }) {
                ProductCard {
                    Label(device.name, systemImage: "desktopcomputer").font(.title2.bold())
                    Text(device.online ? "在线，可接收任务" : "设备离线，指令不会排队执行").foregroundStyle(Design.secondary)
                        .accessibilityIdentifier("deviceAvailability")
                    Button("让这台设备做一件事") {
                        model.selectedDevice = deviceID; model.showCompose = true
                    }.buttonStyle(PrimaryButtonStyle()).disabled(!device.online || model.busy)
                }
                ProductCard {
                    Text("连接安全").font(.headline)
                    Label("已固定设备公钥", systemImage: "lock.shield")
                    Text("任务和结果通过加密连接发送。敏感操作需要单独确认。")
                        .font(.subheadline).foregroundStyle(Design.secondary)
                    Text(device.deviceId).font(.caption.monospaced()).textSelection(.enabled)
                }
                ProductCard {
                    HStack { Text("设备状态").font(.headline); Spacer(); Button("刷新") { Task { await model.refreshDevice(deviceID) } } }
                    ResourceStatus(state: state, resource: .stats)
                    if let stats = state.stats {
                        if let cpu = stats.cpuPercent { LabeledContent("CPU", value: cpu.formatted(.number.precision(.fractionLength(1))) + "%") }
                        if let used = stats.memUsedMB { LabeledContent("已用内存", value: used.formatted(.number.precision(.fractionLength(0))) + " MB") }
                        if let total = stats.memTotalMB { LabeledContent("总内存", value: total.formatted(.number.precision(.fractionLength(0))) + " MB") }
                        if let free = stats.diskFreeGB { LabeledContent("可用磁盘", value: free.formatted(.number.precision(.fractionLength(1))) + " GB") }
                        if let battery = stats.batteryPercent { LabeledContent(stats.charging == true ? "电池 · 充电中" : "电池", value: battery.formatted(.number.precision(.fractionLength(0))) + "%") }
                        if let network = stats.network { LabeledContent("网络", value: network) }
                        LabeledContent("运行中应用", value: String(stats.runningApps.count))
                        if let date = state.statsAt {
                            Text("更新于 \(date.formatted(date: .omitted, time: .standard))，非持续采样")
                                .font(.caption).foregroundStyle(Design.secondary)
                                .accessibilityIdentifier("statsLastRow")
                        }
                    } else if state.pending[.stats] == nil { Text("尚未收到状态数据").foregroundStyle(Design.secondary) }
                }.accessibilityElement(children: .contain).accessibilityIdentifier("deviceStats")
                ProductCard {
                    Text("执行范围").font(.headline)
                    ResourceStatus(state: state, resource: .capabilities)
                    if let caps = state.capabilities {
                        Text(caps.brainAvailable ? "任务引擎可用" : caps.brainUnavailableReason ?? "任务引擎不可用")
                        Text("允许访问的目录").font(.caption).foregroundStyle(Design.secondary)
                        ForEach(caps.scope.allowedDirs, id: \.self) { Text($0).font(.footnote.monospaced()).textSelection(.enabled) }
                        Text("这是应用内范围检查，不是系统沙盒。已批准的终端可拥有当前 Mac 账号的权限。")
                            .font(.footnote).foregroundStyle(Design.secondary)
                            .accessibilityIdentifier("scopeWarning")
                        DisclosureGroup("可用工具（\(caps.tools.count)）") {
                            ForEach(caps.tools, id: \.name) { tool in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(tool.name).font(.footnote.monospaced())
                                    Text(tool.description).font(.caption).foregroundStyle(Design.secondary)
                                }.padding(.vertical, 4)
                            }
                        }
                    }
                }
                ProductCard {
                    Text("Mac 系统权限").font(.headline)
                    ResourceStatus(state: state, resource: .permissions)
                    if let permissions = state.permissions {
                        LabeledContent("辅助功能", value: permissions.accessibility ? "已允许" : "未允许")
                        LabeledContent("屏幕录制", value: permissions.screenCapture ? "已允许" : "未允许")
                        Text("自动化权限需按目标应用单独核验，当前未核验。请在 Mac 的系统设置中自行管理权限，手机不会替你授权。")
                            .font(.footnote).foregroundStyle(Design.secondary)
                            .accessibilityIdentifier("permissionsLastRow")
                    }
                }
                ProductCard {
                    Text("管理设备").font(.headline)
                    Button("重命名设备") { name = device.name; showRename = true }
                        .accessibilityIdentifier("renameDevice")
                    Button("解除配对", role: .destructive) { showUnpair = true }
                        .accessibilityIdentifier("unpairDevice")
                    if model.pendingDeviceChanges[deviceID] != nil { ProgressView("等待中继确认…") }
                    if let error = model.deviceChangeErrors[deviceID] { Text(error).foregroundStyle(.red) }
                }.disabled(!model.connected || model.pendingDeviceChanges[deviceID] != nil)
            } else { Text("设备已不在当前配对列表中。") }
        }.productNavigation("设备详情")
            .task(id: deviceID) { if model.connection != nil { await model.refreshDevice(deviceID) } }
            .alert("重命名设备", isPresented: $showRename) {
                TextField("设备名称", text: $name).accessibilityIdentifier("deviceName")
                Button("取消", role: .cancel) {}
                Button("保存") { Task { await model.changeDevice(deviceID, name: name) } }
            }
            .confirmationDialog("解除与这台 Mac 的配对？", isPresented: $showUnpair, titleVisibility: .visible) {
                Button("解除配对", role: .destructive) { Task { await model.changeDevice(deviceID, name: nil) } }
            } message: { Text("设备会撤销本手机的访问，关闭该手机的终端和待确认任务。重新使用需要再次配对。") }
    }
}

struct ConnectionView: View {
    @Bindable var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ProductPage {
                VStack(spacing: 14) {
                    Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 38))
                        .frame(width: 80, height: 80).background(Design.card, in: RoundedRectangle(cornerRadius: 22))
                    Text(model.connected ? "连接你的 Mac" : "添加你的设备").font(.title2.weight(.semibold))
                    Text("在 Mac 上启动 CuaRemote，再使用短时配对码建立加密连接。")
                        .font(.subheadline).foregroundStyle(Design.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.vertical, 8)
                ProductCard {
                    Label(model.status, systemImage: model.connected ? "lock.shield" : "network")
                        .accessibilityIdentifier("pairingStatus")
                    if let identity = model.connection?.identity {
                        Text(identity.id).font(.caption.monospaced()).textSelection(.enabled)
                            .accessibilityIdentifier("phoneIdentity")
                    }
                    if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("errorMessage") }
                }
                if model.connected || model.connection?.canReconnect == true {
                    ProductCard {
                        if model.connected {
                            Button("断开连接") { model.connection?.disconnect() }.accessibilityIdentifier("disconnect")
                        } else if model.connection?.reconnecting == true {
                            Button("停止自动重连") { model.connection?.disconnect() }.accessibilityIdentifier("stopReconnect")
                        } else {
                            Button("重新连接") { Task { await model.reconnect() } }.accessibilityIdentifier("reconnect")
                        }
                        Text("网络中断后最多重连 5 次；认证失败或主动断开不重试。账号令牌只在本次 App 内存中保留，重启后需重新输入。不会自动重发任务。")
                            .font(.caption).foregroundStyle(Design.secondary)
                    }
                }
                if !model.connected {
                    ProductSection(title: "连接中继") {
                        TextField("wss://你的中继/ws", text: $model.hubURL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .productField().accessibilityIdentifier("hubURL")
                        SecureField("账号令牌", text: $model.token).productField().accessibilityIdentifier("accountToken")
                        Button("连接中继") { hideKeyboard(); Task { await model.connect() } }
                            .buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("connect")
                        Text("正式账号服务尚未接入。当前需要有效账号令牌，仍会验证账号和设备签名。")
                            .font(.caption).foregroundStyle(Design.secondary)
                    }
                }
                if model.connected {
                    ProductSection(title: "输入配对码") {
                        TextField("Mac 上的六位配对码", text: $model.pairCode)
                            .keyboardType(.numberPad).font(.title3.monospaced()).productField().accessibilityIdentifier("pairCode")
                        DisclosureGroup("或粘贴 Mac 的配对信息") {
                            TextEditor(text: $model.pairJSON).frame(minHeight: 90).font(.caption.monospaced())
                                .scrollContentBackground(.hidden).productField()
                                .accessibilityIdentifier("pairJSON")
                        }
                        Button("安全配对") { hideKeyboard(); Task { await model.pair() } }
                            .buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("pair")
                        Text("在 Mac 上启动 CuaRemote，输入它显示的配对码。配对码短时有效且只能使用一次。")
                            .font(.caption).foregroundStyle(Design.secondary)
                    }
                }
            }.productNavigation("添加设备", back: false, close: true)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer(); Button("完成输入") { hideKeyboard() }.accessibilityIdentifier("dismissKeyboard")
                    }
                }
        }
    }
}
