import SwiftUI
import UIKit
import CuaRemoteProtocol

enum AppTab: Int, CaseIterable, Hashable {
    case devices, apps, terminal, activity, me
    var title: String { ["设备", "应用", "终端", "活动", "我的"][rawValue] }
    var icon: String { ["desktopcomputer", "square.grid.2x2", "terminal", "waveform.path", "person.crop.circle"][rawValue] }
}

private struct SystemTabs: UIViewRepresentable {
    @Binding var selection: AppTab
    var isVisible: Bool
    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }
    func makeUIView(context: Context) -> UITabBar {
        let bar = UITabBar()
        bar.items = AppTab.allCases.map { tab in
            let item = UITabBarItem(title: tab.title, image: UIImage(systemName: tab.icon), tag: tab.rawValue)
            item.accessibilityIdentifier = "tab-" + tab.title
            return item
        }
        bar.itemPositioning = .fill
        bar.delegate = context.coordinator
        bar.accessibilityIdentifier = "systemTabs"
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment["CUA_DESIGN_FIXTURE"] != nil {
            bar.accessibilityValue = "native-instance-\(ObjectIdentifier(bar))"
        }
        #endif
        return bar
    }
    func updateUIView(_ bar: UITabBar, context: Context) {
        context.coordinator.selection = $selection
        // SwiftUI透明度不会清除UIKit子按钮的辅助功能可触达状态。
        bar.isHidden = !isVisible
        bar.isUserInteractionEnabled = isVisible
        bar.accessibilityElementsHidden = !isVisible
        let item = bar.items?[selection.rawValue]
        if bar.selectedItem !== item { bar.selectedItem = item }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITabBar, context: Context) -> CGSize? {
        let width = proposal.width ?? uiView.bounds.width
        return CGSize(width: width, height: uiView.sizeThatFits(CGSize(width: width, height: 0)).height)
    }
    final class Coordinator: NSObject, UITabBarDelegate {
        var selection: Binding<AppTab>
        init(selection: Binding<AppTab>) { self.selection = selection }
        func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
            selection.wrappedValue = AppTab.allCases[item.tag]
        }
    }
}

@main
struct CuaRemoteApp: App {
    @State private var model: PhoneModel
    @State private var currentTaskRequest = 0
    @State private var dockHeight: CGFloat = 0
    @State private var rootTabs = Set(AppTab.allCases)
    #if DEBUG && targetEnvironment(simulator)
    private let historyFixture: HistoryLaunchFixture?
    private let cancellationFixture: CancellationLaunchFixture?
    private let activityFixture: ActivityLaunchFixture?
    private let designFixture: DesignLaunchFixture?
    #endif

    init() {
        #if DEBUG && targetEnvironment(simulator)
        let fixture = HistoryLaunchFixture.requested()
        historyFixture = fixture
        let cancellation = CancellationLaunchFixture.requested()
        cancellationFixture = cancellation
        let activity = ActivityLaunchFixture.requested()
        activityFixture = activity
        let design = DesignLaunchFixture.requested()
        designFixture = design
        _model = State(initialValue: design?.model ?? activity?.model ?? cancellation?.model ?? fixture?.model ?? PhoneModel())
        #else
        _model = State(initialValue: PhoneModel())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG && targetEnvironment(simulator)
                if let fixture = designFixture {
                    VStack(spacing: 0) {
                        Text("隔离视觉数据 · \(fixture.mode) · 无设备/模型").font(.caption).padding(6)
                            .accessibilityIdentifier("designFixture")
                        mainContent
                    }
                } else if let fixture = activityFixture {
                    VStack(spacing: 0) {
                        Text("隔离活动步骤补测 · \(fixture.mode) · 无设备/模型").font(.caption).padding(6)
                            .accessibilityIdentifier("activityFixture")
                        mainContent
                    }
                } else if let fixture = cancellationFixture {
                    VStack(spacing: 0) {
                        Text("隔离取消补测 · \(fixture.mode) · 无设备/模型").font(.caption).padding(6)
                            .accessibilityIdentifier("cancelFixture").accessibilityValue("sent=\(fixture.sent)")
                        mainContent
                    }
                } else if let fixture = historyFixture {
                    VStack(spacing: 0) {
                        Text(fixture.label).font(.caption).padding(6)
                            .accessibilityIdentifier("historyFixture").accessibilityValue(fixture.receipt)
                        mainContent
                    }
                } else { mainContent }
                #else
                mainContent
                #endif
            }
            .tint(Design.blue)
            .sheet(isPresented: $model.showConnection) { ConnectionView(model: model) }
            .sheet(isPresented: $model.showCompose) { ComposeView(model: model) }
            .sheet(isPresented: Binding(get: { model.approval != nil }, set: { _ in })) {
                if let approval = model.approval { ApprovalView(model: model, request: approval) }
            }
            #if DEBUG && targetEnvironment(simulator)
            .modifier(DesignFixtureAppearance(mode: designFixture?.mode))
            #endif
        }
    }

    private var mainContent: some View {
        // 保持五个栈的身份；切换栏目不销毁搜索、滚动和导航状态。
        ZStack {
            root(.devices) { DevicesView(model: model) }
            root(.apps) { AppsView(model: model) }
            root(.terminal) { TerminalHomeView(model: model) }
            root(.activity) { HistoryView(model: model, isHome: true, currentTaskRequest: currentTaskRequest) }
            root(.me) { ProfileView(model: model) }
        }
        .overlay(alignment: .bottom) {
            // 单一UITabBar跨栏目保留，让系统完成选中过渡；详情仅隐藏，不重建。
            dock.opacity(rootTabs.contains(model.tab) ? 1 : 0)
                .allowsHitTesting(rootTabs.contains(model.tab))
                .accessibilityHidden(!rootTabs.contains(model.tab))
        }
        .onChange(of: model.tab) { hideKeyboard() }
    }

    private func root<Content: View>(_ tab: AppTab, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            // 只有首页预留底栏空间，push的详情使用完整安全区。
            content().safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: dockHeight).accessibilityHidden(true)
            }
            .onAppear { rootTabs.insert(tab) }
            .onDisappear { rootTabs.remove(tab) }
        }
        .opacity(model.tab == tab ? 1 : 0)
        .allowsHitTesting(model.tab == tab)
        .accessibilityHidden(model.tab != tab)
        .zIndex(model.tab == tab ? 1 : 0)
    }

    private var dock: some View {
        HStack(alignment: .top, spacing: 5) {
            SystemTabs(selection: $model.tab, isVisible: rootTabs.contains(model.tab))
            taskEntry
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain).accessibilityIdentifier("bottomDock")
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { dockHeight = $0 }
    }

    private var taskEntry: some View {
        let button = Button {
            if model.busy { model.tab = .activity; currentTaskRequest += 1 }
            else if model.devices.isEmpty { model.showConnection = true }
            else { model.showCompose = true }
        } label: {
            Image(systemName: model.busy ? "waveform.path" : "sparkles")
                .font(.system(size: 23, weight: .medium)).frame(width: 46, height: 46)
                .foregroundStyle(Design.text)
        }.accessibilityIdentifier("composeTask")
            .accessibilityLabel(model.busy ? "查看正在执行的任务" : "让设备做一件事")
        return Group {
            if #available(iOS 26.0, *) {
                button.buttonStyle(.glass).buttonBorderShape(.circle)
            } else {
                button.buttonStyle(.bordered).buttonBorderShape(.circle)
            }
        }
    }
}

struct ApprovalView: View {
    @Bindable var model: PhoneModel
    let request: StepApprovalRequired
    var body: some View {
        NavigationStack {
            ProductPage {
                ProductCard(tone: .warning) {
                    Label("Mac 需要你的确认", systemImage: "hand.raised").font(.headline)
                        .foregroundStyle(Design.warning)
                    Text(request.reason).foregroundStyle(Design.secondary)
                    Text(model.signatureDescription).font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("signatureMethod")
                }
                ProductCard {
                    Text("将执行的具体操作").font(.headline)
                    HStack {
                        StatusBadge(text: "风险等级 \(request.level.rawValue)", tone: request.level.tone)
                        StatusBadge(text: request.action.channel.rawValue, tone: request.action.channel.rawValue == "gui" ? .info : .neutral)
                    }
                    ProductCode(text: request.action.detail)
                        .accessibilityIdentifier("approvalCommand")
                }
                VStack(spacing: 12) {
                    Button("仅批准这一次") { Task { await model.decide(allow: true) } }
                        .buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("approve")
                        .disabled(model.deciding || model.approvalBlocked).opacity(model.approvalBlocked ? 0.4 : 1)
                    Button("拒绝执行", role: .destructive) { Task { await model.decide(allow: false) } }
                        .frame(maxWidth: .infinity, minHeight: 52).foregroundStyle(Design.danger)
                        .background(Design.dangerWash, in: Capsule()).accessibilityIdentifier("deny")
                        .disabled(model.deciding || model.approvalBlocked).opacity(model.approvalBlocked ? 0.4 : 1)
                    Text(model.approvalBlocked ? "已请求取消整个任务，本次审批不再允许签名。取消不是签名拒绝，仍需等待设备最终结果。" : "签名只适用于上面的操作，不能被用于其他命令。")
                        .font(.footnote).foregroundStyle(Design.secondary)
                    Divider()
                    CancellationControls(model: model, inApproval: true)
                }
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }
            .productNavigation("确认操作", back: false)
        }.interactiveDismissDisabled()
    }
}
