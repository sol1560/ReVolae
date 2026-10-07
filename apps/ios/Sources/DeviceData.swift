import CuaRemoteProtocol
import Foundation
import Observation

/// 每台 Mac 的回读状态。保存按钮不能先改这些值，必须等设备回复。
@MainActor @Observable
final class DeviceData {
    enum Resource: Hashable { case stats, capabilities, permissions, apps, cards, history, detail, shortcuts, privacy, models, learning }
    var stats: DeviceStats?
    var statsAt: Date?
    var capabilities: Capabilities?
    var permissions: PermissionsStatePermissions?
    var apps: [InstalledApp]?
    var cards: [CapabilityCard]?
    var history: [HistoryItem]?
    var historyCursor: String?
    var historyDetails: [String: HistoryDetail] = [:]
    var historyCachedAt: Date?
    var historyDetailCachedAt: [String: Date] = [:]
    var historyStorageError: String?
    var requestedRunID: String?
    var shortcuts: [Shortcut]?
    var shortcutReplyID: String?
    var shortcutReorderID: String?
    var shortcutOrderError: String?
    var privacy: PrivacyState?
    var models: ModelsCatalog?
    var learning: AppLearnProgress?
    var learningBundle: String?
    var learningMessages: [String] = []
    var pending: [Resource: String] = [:]
    var errors: [Resource: String] = [:]

    func accepts(_ resource: Resource, ref: String?) -> Bool {
        guard let ref else { return false }
        return pending[resource] == ref
    }

    func finish(_ resource: Resource, ref: String?) -> Bool {
        guard accepts(resource, ref: ref) else { return false }
        pending[resource] = nil; errors[resource] = nil
        return true
    }

    func disconnected() {
        if shortcutReorderID != nil { shortcutOrderError = "连接已断开，未确认排序是否保存" }
        shortcutReorderID = nil
        shortcutReplyID = nil
        for key in pending.keys { errors[key] = "连接已断开，未确认操作结果" }
        pending.removeAll()
    }
}

extension PhoneModel {
    func data(for device: String) -> DeviceData {
        if let value = deviceData[device] { return value }
        let value = DeviceData(); deviceData[device] = value
        return value
    }

    func request(_ resource: DeviceData.Resource, device: String, timeout: Duration = .seconds(20),
                 build: (String) -> AnyMessage) async {
        let state = data(for: device)
        guard state.pending[resource] == nil else { return }
        guard connected, devices.contains(where: { $0.deviceId == device && $0.online }), let connection else {
            state.errors[resource] = "设备未连接，无法读取或保存"; return
        }
        let id = UUID().uuidString
        state.pending[resource] = id; state.errors[resource] = nil
        do { try await connection.send(build(id), to: device) }
        catch {
            requestFailed(resource, device: device, ref: id, message: error.localizedDescription)
            return
        }
        Task { @MainActor [weak self] in
            try await Task.sleep(for: timeout)
            self?.requestFailed(resource, device: device, ref: id, message: "设备未及时回复，尚不能确认结果，请刷新检查")
        }
    }

    func requestFailed(_ resource: DeviceData.Resource, device: String, ref: String?, message: String) {
        guard let state = deviceData[device], state.accepts(resource, ref: ref) else { return }
        state.pending[resource] = nil; state.errors[resource] = message
        if resource == .shortcuts, state.shortcutReorderID == ref {
            state.shortcutReorderID = nil; state.shortcutOrderError = message
            // 不猜测失败请求是否曾保存；重新读取，但保留排序错误供用户检查。
            Task { @MainActor [weak self, weak state] in
                guard let self, let state, self.deviceData[device] === state, self.connected else { return }
                await self.request(.shortcuts, device: device) { .shortcutsGet(ShortcutsGet(id: $0)) }
            }
        }
    }

    func moveShortcut(_ shortcut: String, by distance: Int, device: String) async {
        let state = data(for: device)
        guard state.pending[.shortcuts] == nil, let shortcuts = state.shortcuts,
              let index = shortcuts.firstIndex(where: { $0.id == shortcut }),
              [-1, 1].contains(distance), shortcuts.indices.contains(index + distance) else { return }
        var ids = shortcuts.map(\.id)
        ids.swapAt(index, index + distance)
        await request(.shortcuts, device: device) { id in
            state.shortcutReorderID = id; state.shortcutOrderError = nil
            return .shortcutsReorder(ShortcutsReorder(id: id, shortcutIds: ids))
        }
    }

    func refreshDevice(_ device: String) async {
        await request(.stats, device: device) { .statsGet(StatsGet(id: $0)) }
        await request(.capabilities, device: device) { .capabilitiesGet(CapabilitiesGet(id: $0)) }
        await request(.permissions, device: device) { .permissionsGet(PermissionsGet(id: $0)) }
    }

    func refreshApps(_ device: String) async {
        await request(.apps, device: device) { .appsList(AppsList(id: $0)) }
        await request(.cards, device: device) { .appCardsGet(AppCardsGet(id: $0)) }
    }

    func refreshHistory(_ device: String, more: Bool = false) async {
        guard connected, devices.contains(where: { $0.deviceId == device && $0.online }) else { return }
        let state = data(for: device)
        guard state.pending[.history] == nil, !more || state.historyCursor != nil else { return }
        await request(.history, device: device) { .historyList(HistoryList(id: $0, cursor: more ? state.historyCursor : nil, limit: 20)) }
    }

    func loadHistory(_ run: HistoryItem, device: String) async {
        guard run.deviceId == device, connected, devices.contains(where: { $0.deviceId == device && $0.online }) else { return }
        let state = data(for: device)
        guard state.pending[.detail] == nil else { return }
        state.requestedRunID = run.runId
        await request(.detail, device: device) { .historyGet(HistoryGet(id: $0, runId: run.runId)) }
    }

    func startLearning(_ bundle: String, device: String) async {
        let state = data(for: device)
        guard state.pending[.learning] == nil else { return }
        state.learning = nil; state.learningBundle = bundle; state.learningMessages = []
        await request(.learning, device: device, timeout: .seconds(300)) {
            .appLearnStart(AppLearnStart(id: $0, bundleId: bundle, explore: false, deviceId: device))
        }
    }

    func receiveDeviceData(_ message: AnyMessage, peer: String) {
        guard let state = deviceData[peer] else { return }
        switch message {
        case .stats(let value) where value.deviceId == peer && state.finish(.stats, ref: value.ref):
            state.stats = value.stats; state.statsAt = Date()
        case .capabilities(let value) where value.deviceId == peer && state.finish(.capabilities, ref: value.ref):
            state.capabilities = value
        case .permissionsState(let value) where value.deviceId == peer && state.finish(.permissions, ref: value.ref):
            state.permissions = value.permissions
        case .appsPage(let page) where state.finish(.apps, ref: page.ref): state.apps = page.apps
        case .privacyState(let value) where value.deviceId == peer && state.finish(.privacy, ref: value.ref): state.privacy = value
        case .modelsCatalog(let value) where state.finish(.models, ref: value.ref): state.models = value
        case .shortcutsList(let value) where state.finish(.shortcuts, ref: value.ref):
            state.shortcuts = value.shortcuts; state.shortcutReplyID = value.id
            if state.shortcutReorderID == value.ref { state.shortcutReorderID = nil }
        case .historyPage(let page) where page.items.allSatisfy({ $0.deviceId == peer }) && state.finish(.history, ref: page.ref):
            state.history = HistoryStore.merge(state.history ?? [], page.items)
            state.historyCursor = page.nextCursor
            saveHistory(peer, listReceived: Date())
        case .historyDetail(let detail) where detail.item.deviceId == peer && detail.item.runId == state.requestedRunID && state.finish(.detail, ref: detail.ref):
            // 历史单独保存，不进入当前执行会话，也绝不重新显示可签名的旧审批。
            do {
                state.historyDetails[detail.item.runId] = try HistoryStore.validatedDetail(detail)
                state.history = HistoryStore.merge(state.history ?? [], [detail.item])
                saveHistory(peer, detail: (detail.item.runId, Date()))
            } catch { state.errors[.detail] = error.localizedDescription }
        case .appCards(let value) where state.finish(.cards, ref: value.ref): state.cards = value.cards
        case .appCards(let value) where state.accepts(.learning, ref: value.ref):
            state.cards = (state.cards ?? []).filter { $0.appBundleId != state.learningBundle }
                + value.cards.filter { $0.appBundleId == state.learningBundle }
        case .appLearnProgress(let value) where value.bundleId == state.learningBundle && state.accepts(.learning, ref: value.ref):
            state.learning = value
            if let message = value.message { state.learningMessages.append(message) }
            if value.phase == .done || value.phase == .failed {
                _ = state.finish(.learning, ref: value.ref)
                if value.phase == .failed { state.errors[.learning] = value.message ?? "学习未完成" }
            }
        case .errorMsg(let value):
            if let resource = state.pending.first(where: { $0.value == value.ref })?.key {
                requestFailed(resource, device: peer, ref: value.ref, message: value.message)
            }
        default: break
        }
    }
}
