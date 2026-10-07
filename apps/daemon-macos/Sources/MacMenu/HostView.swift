import SwiftUI

struct HostView: View {
    @Bindable var model: HostModel
    @State private var confirmStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "desktopcomputer").font(.system(size: 30))
                VStack(alignment: .leading, spacing: 4) {
                    Text("CuaRemote · 此 Mac").font(.title2.bold())
                    Text("由你选择设备、目录和每一次敏感操作。").foregroundStyle(.secondary)
                }
                Spacer()
                Label(model.retrying ? "等待重新连接" : model.running ? "宿主运行中" : "宿主未启动", systemImage: "circle.fill")
                    .font(.caption).foregroundStyle(model.retrying ? .orange : model.running ? .green : .secondary)
            }.padding(24)
            Form {
                Section("当前状态") {
                    LabeledContent("中继连接", value: model.connectionLabel)
                    if let run = model.hostStatus?.activeRunId {
                        LabeledContent("正在执行的任务", value: run).font(.caption.monospaced())
                    } else { Text("没有已确认正在执行的任务").foregroundStyle(.secondary) }
                    if let code = model.pairingCode, let expiry = model.pairingExpiry {
                        LabeledContent("手机配对码") { Text(code).font(.title.monospacedDigit()).textSelection(.enabled) }
                        Text("有效期至 \(expiry.formatted(date: .omitted, time: .standard))，请求后请在此 Mac 确认手机身份。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text(model.hostStatus?.connection == .authenticated ? "配对码已使用或过期，请重新生成。" : "启动并完成中继认证后显示有效配对码。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button(model.refreshingPairing ? "正在重新生成…" : "重新生成配对码") { model.refreshPairing() }
                        .disabled(model.hostStatus?.connection != .authenticated || model.refreshingPairing)
                }
                Section("连接与执行范围") {
                    TextField("中继地址", text: $model.hub)
                    TextField("模型", text: $model.provider)
                    directory("允许访问的目录", text: $model.allowedDirectory)
                    directory("私有状态目录", text: $model.stateDirectory)
                    DisclosureGroup("开发环境与账号") {
                        directory("源码仓库", text: $model.repository)
                        TextField("Bun 可执行文件", text: $model.bun)
                        SecureField("账号令牌", text: $model.token)
                        SecureField("ZenMux 密钥（也可由环境提供）", text: $model.modelKey)
                        Text("正式账号登录尚未接入。凭据仅留在进程内存，不保存为配置。身份软件密钥存入此 Mac 的钥匙串。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("目录限制是应用侧检查，不是系统沙盒。已批准的终端可使用当前 Mac 账号的权限。")
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(model.running || model.retrying)
                Section("系统权限 · 只读检查") {
                    LabeledContent("辅助功能", value: model.permissions.accessibility ? "已允许" : "未允许")
                    LabeledContent("屏幕录制", value: model.permissions.screenCapture ? "已允许" : "未允许")
                    Text("自动化权限按目标应用分别核验，当前未核验。请在系统设置 → 隐私与安全性中自行授权原生服务；本应用不会代替你修改权限。")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("重新检查权限") { model.refresh() }
                    Text("辅助功能和录屏状态是此 App 的检查结果；设备执行时仍由采集服务再次检查，不因这里显示允许而绕过检查。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("启动与连接恢复") {
                    Toggle("登录 Mac 时打开 CuaRemote", isOn: Binding(
                        get: { model.loginStatus == .enabled || model.loginStatus == .requiresApproval },
                        set: { enabled in Task { await model.setLoginLaunch(enabled) } }))
                    if model.loginStatus == .requiresApproval {
                        Text("等待系统批准，请自行到系统设置 → 通用 → 登录项中确认。")
                            .foregroundStyle(.orange)
                    }
                    Text("登录启动只打开 App，不保存账号令牌，也不会自动开始执行任务。")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("本次运行最多自动恢复 5 次，间隔 2、4、8、16、30 秒；仅恢复设备明确允许的网络中断。停止、认证失败或身份异常不重试，不重发写入任务。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped)
            VStack(alignment: .leading, spacing: 12) {
                if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                HStack {
                    Text("关闭窗口后继续在菜单栏运行").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if model.running || model.retrying {
                        Button(model.stopping ? "正在停止…" : "停止宿主", role: .destructive) { confirmStop = true }.disabled(model.stopping)
                    } else {
                        Button("启动宿主") { model.start() }.buttonStyle(.borderedProminent).tint(Color(red: 22/255, green: 25/255, blue: 29/255))
                    }
                }
            }.padding(20)
        }
        .frame(minWidth: 640, minHeight: 760)
        .confirmationDialog("停止宿主将断开设备并取消正在进行的任务。", isPresented: $confirmStop) {
            Button("停止此宿主", role: .destructive) { Task { await model.stop() } }
        }
    }

    private func directory(_ title: String, text: Binding<String>) -> some View {
        HStack {
            TextField(title, text: text)
            Button("选择") { model.chooseDirectory { text.wrappedValue = $0 } }
        }
    }
}
