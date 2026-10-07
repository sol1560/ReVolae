import CuaRemoteProtocol
import Foundation
import LocalAuthentication
import Observation

@MainActor @Observable
final class PhoneModel {
    struct Event: Identifiable {
        let id = UUID()
        let title: String
        let detail: String
        let success: Bool?
    }
    var hubURL = "ws://127.0.0.1:8788/ws"
    var token = ""
    var pairCode = ""
    var pairJSON = ""
    var intent = ""
    var status = "未连接"
    var error: String?
    var connected = false
    var devices: [DevicesPageDevicesItem] = []
    var selectedDevice = ""
    private var session = RunSession()
    var activeDevice: String { session.deviceID }
    var runID: String? { session.runID }
    var busy: Bool { session.running }
    var canCancel: Bool { connected && session.canCancel && devices.contains { $0.deviceId == activeDevice && $0.online } }
    var approvalBlocked: Bool { session.approvalBlocked }
    var cancellationMessage: String? {
        switch session.cancellation {
        case .waiting: "已请求取消，等待设备回执；任务尚未结束。"
        case .received: "设备已收到取消请求，等待任务最终结果。"
        case .problem(let message): message
        case nil: nil
        }
    }
    @ObservationIgnored private var cancellationDeadline: Task<Void, Never>?
    var approval: StepApprovalRequired?
    var deciding = false
    var events: [Event] = []
    var plan: [PlanStep] = []
    var prechecks: [String: StepPrecheck] = [:]
    var stepResults: [String: StepFinished] = [:]
    var completion: RunFinished?
    var result: String? { completion?.summary }
    var tab = AppTab.devices
    var showCompose = false
    var showConnection = false
    private(set) var connection: PhoneConnection?
    var deviceData: [String: DeviceData] = [:]
    var pendingDeviceChanges: [String: String] = [:]
    var deviceChangeErrors: [String: String] = [:]
    var historyStore: HistoryStore?
    var historyScope: HistoryStore.Scope?
    var historyCacheError: String?

    var signatureDescription: String {
        #if targetEnvironment(simulator)
        "模拟器软件签名，未验证 Face ID / 设备密码"
        #else
        connection?.identity.hardwareBacked == true ? "设备安全芯片签名，需验证设备身份" : "软件密钥签名，未验证 Face ID / 设备密码"
        #endif
    }

    init(historyStore: HistoryStore? = nil) {
        do {
            let connection = try PhoneConnection()
            self.connection = connection
            connection.onStatus = { [weak self] status in
                self?.status = status
                if status == "未连接" { self?.connectionLost() }
            }
            connection.onError = { [weak self] error in self?.error = error.localizedDescription }
            connection.onMessage = { [weak self] message, peer in self?.receive(message, peer: peer) }
            do {
                let store = try historyStore ?? HistoryStore()
                self.historyStore = store
                if let scope = try store.lastScope(phoneID: connection.identity.id) {
                    hubURL = scope.relay
                    restoreHistory(scope)
                }
            } catch { historyCacheError = error.localizedDescription }
        } catch { self.error = error.localizedDescription }
    }

    #if DEBUG && targetEnvironment(simulator)
    @ObservationIgnored var cancelFixtureSend: ((RunCancel, String) async throws -> Void)?
    /// 启动测试仅读独立历史，不访问真实 Keychain 身份、pin 或默认历史目录。
    init(historyFixtureStore store: HistoryStore?, phoneID: String) {
        historyStore = store
        do {
            if let scope = try store?.lastScope(phoneID: phoneID) { restoreHistory(scope) }
        } catch { historyCacheError = error.localizedDescription }
    }

    /// 隔离运行状态测试；不创建身份、连接、pin 或存档。
    func beginFixtureRun(device: String, request: String) {
        session.begin(deviceID: device, requestID: request)
    }
    #endif

    func connectionLost() {
        connected = false
        for index in devices.indices { devices[index].online = false }
        cancellationDeadline?.cancel()
        session.disconnect(); approval = nil
        deviceData.values.forEach { $0.disconnected() }
        for device in pendingDeviceChanges.keys { deviceChangeErrors[device] = "连接已断开，未确认更改结果" }
        pendingDeviceChanges.removeAll()
    }

    func connect() async {
        error = nil
        do {
            guard let connection, let url = URL(string: hubURL) else { throw ConnectionError.invalid("中继地址无效") }
            connection.disconnect()
            session = RunSession(); approval = nil; completion = nil; events = []; plan = []; prechecks = [:]; stepResults = [:]
            try await connection.connect(url: url, token: token)
        } catch { self.error = error.localizedDescription }
    }

    func pair() async {
        error = nil
        do {
            guard let connection else { throw ConnectionError.invalid("安全存储不可用") }
            if pairJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try await connection.claim(code: pairCode)
            } else {
                let offer = try JSONDecoder().decode(PairOffer.self, from: Data(pairJSON.utf8))
                guard URL(string: offer.hubURL) == URL(string: hubURL) else { throw ConnectionError.invalid("配对信息的中继地址不匹配") }
                try await connection.pair(offer)
            }
        } catch { self.error = error.localizedDescription }
    }

    func reconnect() async {
        error = nil
        do { try await connection?.reconnect() }
        catch { self.error = error.localizedDescription }
    }

    func changeDevice(_ device: String, name: String?) async {
        guard connected, devices.contains(where: { $0.deviceId == device }), pendingDeviceChanges[device] == nil else { return }
        let id = UUID().uuidString
        pendingDeviceChanges[device] = id; deviceChangeErrors[device] = nil
        do {
            guard let connection else { throw ConnectionError.invalid("未连接") }
            if let name {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { throw ConnectionError.invalid("设备名称不能为空") }
                try await connection.rename(device: device, name: trimmed, requestID: id)
            } else { try await connection.unpair(device: device, requestID: id) }
            try await Task.sleep(for: .seconds(15))
            if pendingDeviceChanges[device] == id {
                pendingDeviceChanges[device] = nil; deviceChangeErrors[device] = "尚未收到中继确认，请刷新设备列表后检查"
            }
        } catch {
            if pendingDeviceChanges[device] == id {
                pendingDeviceChanges[device] = nil; deviceChangeErrors[device] = error.localizedDescription
            }
        }
    }

    func submit() async {
        guard !busy, !selectedDevice.isEmpty, !intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = intent, device = selectedDevice
        if await sendTask(device: device, build: { .intentSubmit(IntentSubmit(id: $0, text: text, deviceId: device, mode: .agent)) }) { intent = "" }
    }

    func runShortcut(_ shortcut: Shortcut, device: String) async {
        if await sendTask(device: device, build: { .shortcutRun(ShortcutRun(id: $0, shortcutId: shortcut.id, params: [:])) }) { tab = .activity }
    }

    func runCard(_ card: CapabilityCard, params: [String: String], device: String) async {
        if await sendTask(device: device, build: { .appCardRun(AppCardRun(id: $0, cardId: card.id, params: params, deviceId: device)) }) { tab = .activity }
    }

    private func sendTask(device: String, build: (String) -> AnyMessage) async -> Bool {
        guard !busy, connected, devices.contains(where: { $0.deviceId == device && $0.online }) else {
            error = "请先连接在线设备，并等待当前任务结束"; return false
        }
        let id = UUID().uuidString
        error = nil; events.removeAll(); completion = nil
        plan = []; prechecks = [:]; stepResults = [:]
        session.begin(deviceID: device, requestID: id)
        do {
            guard let connection else { throw ConnectionError.invalid("未连接") }
            try await connection.send(build(id), to: device)
            return true
        } catch { _ = session.failed(ref: id, peer: device); self.error = error.localizedDescription; return false }
    }

    func decide(allow: Bool) async {
        guard let request = approval, let connection, !deciding, !approvalBlocked else { return }
        deciding = true
        defer { deciding = false }
        do {
            _ = try validateApproval(request)
            if connection.identity.hardwareBacked {
                let context = LAContext()
                var authError: NSError?
                guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
                    throw ConnectionError.invalid("请先设置设备密码，才能签名确认操作")
                }
                guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: allow ? "批准 Mac 执行显示的操作" : "签名拒绝这次操作") else {
                    throw ConnectionError.invalid("身份验证没有完成")
                }
            }
            guard connected, approval?.id == request.id, !approvalBlocked else { throw ConnectionError.invalid("连接、审批或取消状态已改变，请重新检查任务状态") }
            let decision = try connection.identity.approve(request, allow: allow)
            try await connection.send(decision, to: activeDevice)
            events.append(Event(title: allow ? "已签名批准" : "已签名拒绝", detail: request.action.detail, success: nil))
            approval = nil
        } catch { self.error = error.localizedDescription }
    }

    func cancel() async {
        guard canCancel, let request = session.requestCancellation(id: UUID().uuidString) else { return }
        let peer = activeDevice
        error = nil
        cancellationDeadline?.cancel()
        cancellationDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            self?.cancelTimedOut(ref: request.id, peer: peer)
        }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if let cancelFixtureSend { try await cancelFixtureSend(request, peer); return }
            #endif
            guard let connection else { throw ConnectionError.invalid("未连接") }
            try await connection.send(request, to: peer)
        } catch {
            if session.cancellationFailed(ref: request.id, peer: peer, message: "发送取消失败，未确认任务结束：" + error.localizedDescription) {
                cancellationDeadline?.cancel()
            }
        }
    }

    func cancelTimedOut(ref: String, peer: String) {
        session.cancellationFailed(ref: ref, peer: peer, message: "尚未收到任务最终结果，取消未确认。可手动重试；不会自动重发。")
    }

    func receive(_ message: AnyMessage, peer: String?) {
        // 断线前的回调不能让设备或审批恢复可操作。新的 auth.ok 只恢复账号连接，
        // 在线标记仍须等待新连接的设备列表或 presence。
        if !connected { guard peer == nil, case .authOk = message else { return } }
        if peer == nil { switch message {
        case .authOk:
            connected = true; token = ""; error = nil
            if let connection, let url = connection.authenticatedURL {
                do {
                    let scope = try HistoryStore.Scope(url: url, phoneID: connection.identity.id)
                    if historyScope != scope { restoreHistory(scope) }
                    try historyStore?.remember(scope)
                } catch { historyCacheError = error.localizedDescription }
            }
        case .devicesPage(let page):
            devices = page.devices.filter { $0.role == .device && $0.paired }
            if let scope = historyScope {
                do { try historyStore?.retain(scope: scope, deviceIDs: Set(devices.map(\.deviceId))) }
                catch { historyCacheError = "无法清理已移除设备的本机历史：" + error.localizedDescription }
            }
            for device in devices { _ = data(for: device.deviceId) }
            for (id, state) in deviceData where !devices.contains(where: { $0.deviceId == id }) { state.disconnected() }
            deviceData = deviceData.filter { id, _ in devices.contains { $0.deviceId == id } }
            if !devices.contains(where: { $0.deviceId == selectedDevice }) { selectedDevice = devices.first?.deviceId ?? "" }
        case .pairResult(let result):
            if result.ok { selectedDevice = result.deviceId; pairCode = ""; pairJSON = ""; showConnection = false }
        case .ack(let ack):
            if let device = pendingDeviceChanges.first(where: { $0.value == ack.ref })?.key {
                pendingDeviceChanges[device] = nil
                Task { [weak self] in
                    do { try await self?.connection?.refreshDevices() }
                    catch { self?.deviceChangeErrors[device] = error.localizedDescription }
                }
            }
        case .errorMsg(let failure):
            if let device = pendingDeviceChanges.first(where: { $0.value == failure.ref })?.key {
                pendingDeviceChanges[device] = nil; deviceChangeErrors[device] = failure.message
            }
        case .pairRemoved(let removed):
            if let scope = historyScope {
                do { try historyStore?.remove(scope: scope, deviceID: removed.deviceId) }
                catch { historyCacheError = "无法删除已解绑设备的本机历史：" + error.localizedDescription }
            }
            devices.removeAll { $0.deviceId == removed.deviceId }
            deviceData.removeValue(forKey: removed.deviceId)?.disconnected()
            if activeDevice == removed.deviceId { cancellationDeadline?.cancel(); session.disconnect(); approval = nil }
            if selectedDevice == removed.deviceId { selectedDevice = devices.first?.deviceId ?? "" }
        case .presence(let presence):
            if let index = devices.firstIndex(where: { $0.deviceId == presence.deviceId }) { devices[index].online = presence.online }
            if !presence.online { deviceData[presence.deviceId]?.disconnected() }
            if !presence.online, activeDevice == presence.deviceId, busy {
                cancellationDeadline?.cancel(); session.disconnect(); approval = nil; error = "Mac 已离线，尚不能确认执行结果"
            }
        default: break
        } }
        guard let peer, devices.contains(where: { $0.deviceId == peer && $0.online }) else { return }
        receiveDeviceData(message, peer: peer)
        guard peer == activeDevice, !activeDevice.isEmpty else { return }
        switch message {
        case .runCreated(let run) where session.created(run, peer: peer):
            plan = run.plan
            events.append(Event(title: "Mac 已收到任务", detail: run.intent + "\n" + run.provider, success: nil))
        case .planUpdated(let update) where session.acceptsStep(runID: update.runId, peer: peer):
            plan = update.plan
        case .stepStarted(let step) where session.acceptsStep(runID: step.runId, peer: peer):
            if let index = plan.firstIndex(where: { $0.id == step.stepId }) { plan[index].status = .running }
            events.append(Event(title: step.title, detail: "正在处理", success: nil))
        case .stepPrecheck(let check) where session.acceptsStep(runID: check.runId, peer: peer):
            prechecks[check.stepId] = check
        case .stepApprovalRequired(let request) where session.acceptsStep(runID: request.runId, peer: peer):
            do { _ = try validateApproval(request); approval = request }
            catch { self.error = error.localizedDescription }
        case .stepFinished(let step) where session.acceptsStep(runID: step.runId, peer: peer):
            guard stepResults[step.stepId] == nil else { return }
            stepResults[step.stepId] = step
            if let index = plan.firstIndex(where: { $0.id == step.stepId }) { plan[index].status = step.ok ? .done : .failed }
            events.append(Event(title: step.ok ? "步骤完成" : "步骤未执行或失败", detail: step.output ?? step.error ?? "没有文本输出", success: step.ok))
        case .runFinished(let run) where session.complete(run, peer: peer):
            cancellationDeadline?.cancel(); completion = run; approval = nil
        case .ack(let ack):
            session.acknowledgeCancellation(ref: ack.ref, peer: peer)
        case .errorMsg(let failure) where session.cancellationFailed(ref: failure.ref, peer: peer, message: "设备未确认取消：" + failure.message):
            cancellationDeadline?.cancel()
        case .errorMsg(let failure) where session.failed(ref: failure.ref, peer: peer): error = failure.message
        default: break
        }
    }
}
