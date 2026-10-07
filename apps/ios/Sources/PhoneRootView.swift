import SwiftUI
import CuaRemoteCore
import CuaRemoteProtocol

struct PhoneRootView: View {
    @ObservedObject var session: PhoneSession
    @AppStorage("hubURL") private var hub = ""
    @AppStorage("allowLocalHub") private var local = false
    @State private var token = ""
    @State private var intent = ""
    @State private var offerText = ""
    @State private var scanning = false
    @State private var tab = 0
    @State private var revoke: RemotePeerState?

    var body: some View {
        TabView(selection: $tab) {
            devices.tabItem { Label("设备", systemImage: "desktopcomputer") }.tag(0)
            task.tabItem { Label("任务", systemImage: "sparkles") }.tag(1)
            history.tabItem { Label("记录", systemImage: "clock.arrow.circlepath") }.tag(2)
            settings.tabItem { Label("连接", systemImage: "network") }.tag(3)
        }
        .alert("需要注意", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("知道了") { session.error = nil }
        } message: { Text(session.error ?? "") }
        .sheet(isPresented: $scanning) {
            NavigationStack {
                QRScanner { value in offerText = value; scanning = false }
                    .navigationTitle("扫描 Mac 配对码")
                    .toolbar { Button("取消") { scanning = false } }
            }
        }
        .confirmationDialog("撤销与这台 Mac 的配对？", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button("撤销配对", role: .destructive) {
                if let peer = revoke { Task { await session.unpair(peer.id) } }
                revoke = nil
            }
        } message: { Text("正在执行的任务将中断。再次连接需要重新在 Mac 上确认。") }
    }

    private var devices: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("你的 Mac，随身可控").font(.title3.bold())
                            Text("配对 · 加密 · 每步可见").font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "iphone.and.arrow.forward").font(.largeTitle).foregroundStyle(.teal)
                    }.padding(.vertical, 12)
                    ConnectionBadge(status: session.client.status)
                    NoticeView(text: session.notice)
                }
                Section("已配对设备") {
                    if session.client.peers.isEmpty {
                        ContentUnavailableView("还没有 Mac", systemImage: "desktopcomputer", description: Text("先连接 Hub，再扫描 Mac 的配对码。"))
                    }
                    ForEach(session.client.peers.values.sorted { $0.name < $1.name }) { peer in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: "desktopcomputer").foregroundStyle(.teal)
                                Text(peer.name).font(.headline)
                                Spacer()
                                Text(peer.ready ? "加密就绪" : peer.online ? "握手中" : "离线").font(.caption).foregroundStyle(.secondary)
                            }
                            Text(peer.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                            HStack {
                                Button("控制这台 Mac") { session.selectedPeer = peer.id; tab = 1 }
                                    .buttonStyle(.borderedProminent).disabled(!peer.ready || session.busy)
                                Spacer()
                                Button("撤销", role: .destructive) { revoke = peer }.buttonStyle(.borderless)
                            }
                        }.padding(.vertical, 8)
                    }
                }
                Section("添加 Mac") {
                    Button { scanning = true } label: { Label("扫描配对二维码", systemImage: "qrcode.viewfinder") }
                    TextField("或粘贴 Mac 提供的配对 JSON", text: $offerText, axis: .vertical)
                        .lineLimit(2...5).font(.caption.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("pair-offer")
                    if let offer = parsedOffer {
                        LabeledContent("Mac", value: offer.name)
                        Text(offer.hubURL).font(.caption).textSelection(.enabled)
                        Text("Mac 指纹：\(keyFingerprint(offer.pubKeys))").font(.caption.monospaced())
                        if hub != offer.hubURL {
                            Button("使用此 Hub 地址（先到连接页认证）") { hub = offer.hubURL; tab = 3 }
                        }
                    }
                    Button(session.pairing ? "等待 Mac 确认…" : "请求配对") {
                        Task { await session.pair(json: offerText); offerText = "" }
                    }.disabled(parsedOffer == nil || session.client.status != .connected || session.pairing)
                    Text("本机指纹：\(phoneFingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                    NoticeView(text: "只扫描你自己的 Mac。配对码有效期 5 分钟，请勿分享；Mac 必须本地确认后才能控制。")
                }
            }.navigationTitle("ReVolae")
        }
    }

    private var task: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Label(session.client.peers[session.selectedPeer]?.name ?? "未选择 Mac", systemImage: "desktopcomputer").font(.headline)
                        Spacer()
                        if session.busy { ProgressView() }
                    }
                    NoticeView(text: session.notice)
                    TextField("希望 Mac 做什么？例如：列出工作目录中的文件", text: $intent, axis: .vertical)
                        .lineLimit(3...8).padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                        .accessibilityIdentifier("intent-input")
                    HStack {
                        Button { Task { await session.submit(intent) } } label: { Label("发送任务", systemImage: "arrow.up") }
                            .buttonStyle(.borderedProminent)
                            .disabled(!session.canSubmit || intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("submit-task")
                        Spacer()
                        Button("停止", role: .destructive) { Task { await session.cancel() } }
                            .disabled(!session.busy || session.runId == nil)
                    }
                    if let approval = session.approval { ApprovalCard(request: approval, session: session) }
                    if session.events.isEmpty {
                        ContentUnavailableView("每一步都可追溯", systemImage: "list.bullet.rectangle", description: Text("执行计划、签名审批和实际输出会显示在这里。"))
                    }
                    ForEach(session.events) { event in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(event.title, systemImage: event.failed ? "exclamationmark.circle" : "circle.fill")
                                .font(.subheadline.bold()).foregroundStyle(event.failed ? .orange : .teal)
                            Text(event.detail).font(.footnote.monospaced()).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding()
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                    }
                    NoticeView(text: "离开应用或连接中断时，Mac 将停止当前任务，不会自动重试。已经发生的操作可能保留。")
                }.padding()
            }.navigationTitle("远程任务")
        }
    }

    private var history: some View {
        NavigationStack {
            List {
                NoticeView(text: "记录来自当前选中的 Mac。中断或失败不代表已撤销外部操作。")
                if session.history.isEmpty { ContentUnavailableView("暂无记录", systemImage: "clock", description: Text("选中已连接的 Mac 后点击刷新。")) }
                ForEach(session.history, id: \.runId) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.intent).font(.headline)
                        Text(record.summary ?? "执行中").font(.subheadline).foregroundStyle(.secondary)
                        Text(Date(timeIntervalSince1970: TimeInterval(record.startedAt)), style: .date).font(.caption)
                        Text(record.runId).font(.caption2.monospaced()).textSelection(.enabled)
                    }.padding(.vertical, 6)
                }
            }.navigationTitle("任务记录")
                .toolbar { Button("刷新") { Task { await session.loadHistory() } } }
        }
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section("Hub 中继") {
                    TextField("wss://你的 Hub/ws", text: $hub).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("hub-url")
                    SecureField("Hub token（若启用账户认证）", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("允许本地开发 ws", isOn: $local)
                    NoticeView(text: "公网必须使用 wss。开发 ws 只允许本地/私网地址；不要把无账户认证的开发 Hub 暴露到公网。Token 仅保留在本次应用内存中。")
                    ConnectionBadge(status: session.client.status)
                    Button(session.connecting ? "正在连接…" : "连接 / 重新连接") {
                        Task { await session.connect(hub: hub, token: token, local: local) }
                    }.disabled(session.connecting || session.busy || hub.isEmpty)
                        .accessibilityIdentifier("connect-hub")
                    Button("断开连接", role: .destructive) { session.disconnect() }
                }
                Section("安全边界") {
                    NoticeView(text: "工具输出可能发送到 Mac 本地配置的模型服务。命令、AppleScript 和快捷指令具有 Mac 登录用户的完整权限，工作目录不是沙盒。每次执行前都会展示原文并要求生物识别签名批准。")
                    NoticeView(text: "应用不在后台持续远控，也不会记住“永远批准”。模型选择和密钥只能在 Mac 上配置。")
                }
            }.navigationTitle("连接设置")
        }
    }

    private var parsedOffer: PairOffer? { try? JSONDecoder().decode(PairOffer.self, from: Data(offerText.utf8)) }
    private var phoneFingerprint: String { (try? keyFingerprint(session.client.identity.publicKeys)) ?? "不可用" }
}

private struct ApprovalCard: View {
    let request: StepApprovalRequired
    @ObservedObject var session: PhoneSession

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = max(0, request.expiresAt - Int(context.date.timeIntervalSince1970))
            VStack(alignment: .leading, spacing: 14) {
                Label("需要你的签名批准", systemImage: "hand.raised.fill").font(.headline)
                Text(request.action.summary).font(.subheadline.bold())
                Text("权限：Mac 登录用户完整账户 · \(request.action.channel.rawValue)").font(.caption)
                if let path = request.action.targetPath { Text("工作路径：\(path)").font(.caption.monospaced()) }
                if let app = request.action.targetApp { Text("目标应用：\(app)").font(.caption.monospaced()) }
                ScrollView {
                    Text(request.action.detail).font(.footnote.monospaced()).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }.frame(maxHeight: 260).padding(12).background(.background, in: RoundedRectangle(cornerRadius: 10))
                Text(request.reason).font(.caption)
                Text(remaining == 0 ? "审批已过期，不可执行" : "\(remaining) 秒后过期 · 仅本次有效").font(.caption.bold())
                HStack {
                    Button("拒绝", role: .destructive) { Task { await session.decide(allow: false) } }.buttonStyle(.bordered)
                    Spacer()
                    Button { Task { await session.decide(allow: true) } } label: { Label("验证并批准", systemImage: "faceid") }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("approve-action")
                }.disabled(remaining == 0 || session.authorizing)
            }.padding().background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
        }
    }
}
