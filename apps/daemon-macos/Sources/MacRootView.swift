import SwiftUI
import AppKit
import ApplicationServices
import CoreImage.CIFilterBuiltins
import CuaRemoteCore
import CuaRemoteMac
import CuaRemoteProtocol

struct MacRootView: View {
    @ObservedObject var session: MacSession
    @AppStorage("hubURL") private var hub = ""
    @AppStorage("localHub") private var local = false
    @AppStorage("repoPath") private var repo = ""
    @AppStorage("bunPath") private var bun = "~/.bun/bin/bun"
    @AppStorage("workspacePath") private var workspace = "~/Documents"
    @AppStorage("provider") private var provider = ""
    @State private var token = ""
    @State private var apiKey = ""
    @State private var tab = 0
    @State private var revoke: RemotePeerState?

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 24) {
                Label("ReVolae", systemImage: "desktopcomputer").font(.title2.bold())
                Text("Mac 执行端").font(.subheadline).foregroundStyle(.secondary)
                sidebar("连接与权限", icon: "network", tag: 0)
                sidebar("配对 iPhone", icon: "qrcode", tag: 1)
                sidebar("任务与记录", icon: "list.bullet.rectangle", tag: 2)
                Spacer()
                ConnectionBadge(status: session.client.status)
                Text("关闭窗口后仍在菜单栏运行。\n退出应用会中断当前任务。").font(.caption).foregroundStyle(.secondary)
                Button("停止当前任务", role: .destructive) { session.daemon?.stopCurrentRun() }
                    .disabled(session.daemon?.currentRun == nil)
            }.padding(24).frame(width: 225, alignment: .leading).frame(maxHeight: .infinity).background(.quaternary)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if tab == 0 { connection }
                    else if tab == 1 { pairing }
                    else { tasks }
                }.padding(30).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .alert("需要注意", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("知道了") { session.error = nil }
        } message: { Text(session.error ?? "") }
        .confirmationDialog("撤销与这台 iPhone 的配对？", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button("撤销配对", role: .destructive) { if let peer = revoke { Task { await session.unpair(peer.id) } }; revoke = nil }
        }
    }

    private func sidebar(_ title: String, icon: String, tag: Int) -> some View {
        Button { tab = tag } label: {
            Label(title, systemImage: icon).font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(tab == tag ? Color.teal.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("让你的 Mac 安全待命").font(.largeTitle.bold())
            Text("原生执行 · 本地授权 · 端到端加密").foregroundStyle(.secondary)
            GroupBox("连接配置") {
                Form {
                    TextField("Hub URL", text: $hub, prompt: Text("wss://你的 Hub/ws"))
                    SecureField("Hub token", text: $token)
                    Toggle("允许本地开发 ws（仅私网）", isOn: $local)
                    pathRow("仓库目录", value: $repo, directory: true)
                    pathRow("Bun 可执行文件", value: $bun, directory: false)
                    pathRow("工作目录", value: $workspace, directory: true)
                    TextField("模型 provider", text: $provider, prompt: Text("provider:model 或 openai-compat:model@URL"))
                    SecureField("模型 API key（本次运行）", text: $apiKey)
                }.textFieldStyle(.roundedBorder).padding()
            }.disabled(session.connecting || session.client.status == .connected)
            NoticeView(text: "模型密钥与 Hub token 仅保存在本次运行内存，不写入偏好或日志。重新启动需重新输入；模型服务可能收到指令和工具输出。")
            if provider.hasPrefix("mock") {
                Label("当前为 mock 测试模型，不代表真实模型验收。", systemImage: "testtube.2").foregroundStyle(.orange)
            }
            HStack {
                Button(session.connecting ? "连接中…" : "启动连接") {
                    Task { await session.connect(hub: hub, token: token, local: local, repo: repo, bun: bun, workspace: workspace, provider: provider, apiKey: apiKey) }
                }.buttonStyle(.borderedProminent).disabled(session.connecting || session.client.status == .connected || provider.isEmpty || repo.isEmpty || hub.isEmpty)
                Button("断开", role: .destructive) { session.disconnect() }
                Spacer()
                ConnectionBadge(status: session.client.status)
            }
            Divider()
            Text("请确认执行权限").font(.headline)
            NoticeView(text: "工作目录限制只读文件工具，不是系统沙盒。经手机签名批准的 Shell、AppleScript、快捷指令具有当前登录用户的完整权限。请核对每条命令；系统权限不足会明确失败，不会自动绕过。")
            HStack {
                Button("辅助功能设置") { openPrivacy("Privacy_Accessibility") }
                Button("自动化设置") { openPrivacy("Privacy_Automation") }
            }
            NoticeView(text: "GUI 操作通过经批准的 AppleScript / System Events 执行。首次操作时按 macOS 提示授权，只有实际操作成功后才能认为权限就绪。公网 Hub 必须启用账户认证与 TLS；不要公网部署无认证开发服务。")
        }
    }

    private var pairing: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("配对你的 iPhone").font(.largeTitle.bold())
            NoticeView(text: "配对必须从此 Mac 本地确认。请核对手机显示的身份指纹，不要确认陌生请求。")
            if let pending = session.client.pendingPairRequest {
                GroupBox("新的配对请求") {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(pending.phoneName, systemImage: "iphone").font(.headline)
                        Text(pending.phoneId).font(.caption.monospaced()).textSelection(.enabled)
                        Text("手机指纹：\(keyFingerprint(pending.phonePubKeys))").font(.caption.monospaced()).textSelection(.enabled)
                        HStack {
                            Button("拒绝", role: .destructive) { Task { await session.confirm(false) } }
                            Button("已核对，确认配对") { Task { await session.confirm(true) } }.buttonStyle(.borderedProminent)
                        }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Button("生成 5 分钟配对码") { session.makeOffer() }
                .disabled(session.client.status != .connected || session.client.pendingPairRequest != nil)
            if let offer = try? JSONDecoder().decode(PairOffer.self, from: Data(session.offer.utf8)) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = max(0, offer.expiresAt - Int(context.date.timeIntervalSince1970))
                    HStack(alignment: .top, spacing: 20) {
                        if remaining > 0, let qr = qrImage(session.offer) {
                            Image(nsImage: qr).interpolation(.none).resizable().frame(width: 230, height: 230)
                                .padding(16).background(.white, in: RoundedRectangle(cornerRadius: 16))
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            Text(remaining > 0 ? "用 iPhone 扫描" : "配对码已过期").font(.title2.bold())
                            Text("\(remaining) 秒后失效").foregroundStyle(.secondary)
                            Text("Mac 指纹：\(keyFingerprint(offer.pubKeys))").font(.caption.monospaced()).textSelection(.enabled)
                            Button("复制配对 JSON") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(session.offer, forType: .string)
                            }.disabled(remaining == 0)
                            NoticeView(text: "配对码含一次性凭据，请勿截图分享或写入日志。模拟器可粘贴 JSON。")
                        }
                    }
                }
            }
            Divider()
            Text("已配对 iPhone").font(.headline)
            ForEach(session.client.peers.values.sorted { $0.name < $1.name }) { peer in
                HStack {
                    Label(peer.name, systemImage: "iphone")
                    Spacer()
                    Text(peer.ready ? "加密就绪" : "离线 / 握手中").font(.caption).foregroundStyle(.secondary)
                    Button("撤销", role: .destructive) { revoke = peer }
                }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private var tasks: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("真实操作，保留记录").font(.largeTitle.bold())
            if let run = session.daemon?.currentRun {
                GroupBox("当前任务") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(run.intent).font(.headline)
                        Text(run.summary ?? "执行中").foregroundStyle(.secondary)
                        Button("立即停止", role: .destructive) { session.daemon?.stopCurrentRun() }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { Label("没有正在执行的任务", systemImage: "pause.circle").foregroundStyle(.secondary) }
            NoticeView(text: "任务中断后不会自动重跑。interrupted 表示外部副作用可能已发生，请检查后再下新指令；completed 是 Brain 的完成报告，应结合文件或应用状态核对。")
            ForEach(session.daemon?.history ?? []) { record in
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text(record.intent).font(.headline); Spacer(); Text(record.status.rawValue).font(.caption.monospaced()) }
                    Text(record.summary ?? "").font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                    Text(record.id).font(.caption2.monospaced()).textSelection(.enabled)
                }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private func pathRow(_ title: String, value: Binding<String>, directory: Bool) -> some View {
        HStack {
            TextField(title, text: value)
            Button("选择") {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = directory
                panel.canChooseFiles = !directory
                panel.allowsMultipleSelection = false
                if panel.runModal() == .OK, let url = panel.url { value.wrappedValue = url.path }
            }
        }
    }

    private func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    private func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
