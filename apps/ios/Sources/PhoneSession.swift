import Combine
import CuaRemoteCore
import CuaRemoteProtocol
import Foundation
import LocalAuthentication
import UIKit

struct PhoneEvent: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let failed: Bool
}

@MainActor
final class PhoneSession: ObservableObject {
    let client: RemoteClient
    @Published var selectedPeer = ""
    @Published var error: String?
    @Published var notice = "连接你自己的 Mac，所有执行都在 Mac 本地进行。"
    @Published var events: [PhoneEvent] = []
    @Published var history: [HistoryItem] = []
    @Published var approval: StepApprovalRequired?
    @Published var runId: String?
    @Published var busy = false
    @Published var authorizing = false
    @Published var connecting = false
    @Published var pairing = false
    private var activePeer: String?
    private var submitId: String?
    private var connectionObservation: AnyCancellable?
    private var authentication: LAContext?
    private var approvalGeneration = UUID()

    init() throws {
        client = try RemoteClient(role: .phone, name: UIDevice.current.name)
        connectionObservation = client.objectWillChange.sink { [weak self] in
            Task { @MainActor [weak self] in self?.objectWillChange.send() }
        }
        client.onControl = { [weak self] peer, message in self?.receive(message, from: peer) }
        client.onTransportEnded = { [weak self] in self?.unavailable() }
        client.onPeerUnavailable = { [weak self] peer in
            guard let self else { return }
            if peer == self.activePeer || peer == self.selectedPeer { self.unavailable() }
        }
        client.onSecurityEvent = { [weak self] _ in
            self?.error = "对端身份或加密会话验证失败。不会发送任务；请在 Mac 上检查配对。"
        }
        client.onHubMessage = { [weak self] message in
            guard let self else { return }
            if case .pairResult(let result) = message {
                self.pairing = false
                self.notice = result.ok ? "配对成功，正在建立端到端加密会话。" : "Mac 拒绝了配对。"
            }
            if case .errorMsg(let value) = message { self.error = "Hub：\(value.code)"; self.pairing = false }
        }
    }

    var canSubmit: Bool {
        !busy && !connecting && client.peers[selectedPeer]?.ready == true
    }

    func connect(hub: String, token: String, local: Bool) async {
        guard !connecting else { return }
        connecting = true
        defer { connecting = false }
        do {
            guard let url = URL(string: hub) else { throw PairingError.invalidHubURL }
            try await client.connect(to: url, token: token.isEmpty ? nil : token, allowInsecureLocalDevelopment: local)
            let deadline = Date().addingTimeInterval(15)
            while client.status != .connected && Date() < deadline {
                if case .failed = client.status { throw PhoneError.connection }
                try await Task.sleep(for: .milliseconds(50))
            }
            guard client.status == .connected else { throw PhoneError.connection }
            notice = "已连接 Hub。选择已配对 Mac，或扫描新的配对码。"
        } catch {
            client.disconnect()
            self.error = "连接未完成：\(error.localizedDescription)"
        }
    }

    func pair(json: String) async {
        do {
            let offer = try JSONDecoder().decode(PairOffer.self, from: Data(json.utf8))
            try await client.acceptPairOffer(json: json, phoneName: UIDevice.current.name)
            selectedPeer = offer.deviceId
            pairing = true
            notice = "等待 Mac 本地确认。请核对本机身份指纹。"
        } catch { self.error = "配对失败：\(error.localizedDescription)" }
    }

    func submit(_ text: String) async {
        guard canSubmit, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 16_384 else { return }
        let peer = selectedPeer
        let id = UUID().uuidString.lowercased()
        busy = true
        activePeer = peer
        submitId = id
        runId = nil
        clearApproval()
        events = []
        notice = "指令已发送，等待 Mac 确认。不会自动重试。"
        do {
            try await client.send(.intentSubmit(IntentSubmit(id: id, text: text, deviceId: peer, mode: .agent)), to: peer)
        } catch {
            unavailable()
            self.error = "发送状态不确定；请重新连接并查询记录，不要重复执行。"
        }
    }

    func cancel() async {
        guard let activePeer, let runId else { return }
        clearApproval()
        do {
            try await client.send(.runCancel(RunCancel(id: UUID().uuidString, runId: runId)), to: activePeer)
            notice = "已请求停止；已发生的外部操作无法自动撤销。"
        } catch { unavailable() }
    }

    func decide(allow: Bool) async {
        guard !authorizing, let request = approval, let peer = activePeer else { return }
        authorizing = true
        let generation = approvalGeneration
        defer { authorizing = false; authentication = nil }
        do {
            _ = try ApprovalSigning.validateRequest(request)
            if allow {
                let context = LAContext()
                authentication = context
                guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "批准这一次 Mac 操作") else { return }
            }
            guard generation == approvalGeneration, client.peers[peer]?.ready == true,
                  approval?.challenge == request.challenge, runId == request.runId else { throw PhoneError.staleApproval }
            let decision = try ApprovalSigning.signDecision(for: request, allow: allow, identity: client.identity)
            clearApproval()
            try await client.send(.approvalDecision(decision), to: peer)
            notice = allow ? "本次操作已签名批准，等待执行结果。" : "已签名拒绝，不执行该操作。"
        } catch { self.error = "未能发送审批：\(error.localizedDescription)" }
    }

    func loadHistory() async {
        guard client.peers[selectedPeer]?.ready == true else { return }
        do {
            try await client.send(.historyList(HistoryList(id: UUID().uuidString, limit: 50)), to: selectedPeer)
        } catch { self.error = "无法获取记录。" }
    }

    func unpair(_ peer: String) async {
        do { try await client.unpair(peer) }
        catch { self.error = "撤销配对失败：\(error.localizedDescription)" }
    }

    func disconnect() {
        client.disconnect()
        unavailable()
    }

    private func unavailable() {
        clearApproval()
        pairing = false
        if busy { append("连接已中断", "执行结果不确定，已有副作用可能保留。重新连接后查询 Mac 记录。", failed: true) }
        busy = false
        notice = "连接已中断；任务不会自动重试。"
    }

    private func clearApproval() {
        approvalGeneration = UUID()
        authentication?.invalidate()
        approval = nil
    }

    private func receive(_ message: AnyMessage, from peer: String) {
        if case .historyPage(let page) = message, peer == selectedPeer { history = page.items; return }
        guard peer == activePeer else { return }
        switch message {
        case .runCreated(let event):
            runId = event.runId
            notice = "Mac 正在执行任务。"
            append("任务开始 · \(event.provider)", event.intent)
        case .planUpdated(let event) where event.runId == runId:
            append("执行计划", event.plan.map(\.title).joined(separator: "\n"))
        case .stepStarted(let event) where event.runId == runId:
            append("开始步骤", event.title)
        case .stepApprovalRequired(let request) where request.runId == runId:
            do {
                _ = try ApprovalSigning.validateRequest(request)
                clearApproval()
                approval = request
                notice = "等待你审批；未批准前不会执行。"
            } catch { self.error = "审批请求无效或已过期。" }
        case .stepFinished(let event) where event.runId == runId:
            if approval?.stepId == event.stepId { clearApproval() }
            append(event.ok ? "步骤完成" : "步骤未完成", event.output ?? event.error ?? "无输出", failed: !event.ok)
        case .runFinished(let event) where event.runId == runId:
            clearApproval()
            busy = false
            notice = event.ok ? "Mac 报告任务完成，请核对步骤输出。" : "任务未成功完成。"
            append(notice, event.summary, failed: !event.ok)
        case .errorMsg(let event):
            error = "Mac：\(event.code)"
            if event.ref == submitId { busy = false; clearApproval() }
        default: break
        }
    }

    private func append(_ title: String, _ detail: String, failed: Bool = false) {
        events.append(PhoneEvent(title: title, detail: String(detail.prefix(32_768)), failed: failed))
        if events.count > 100 { events.removeFirst(events.count - 100) }
    }
}

private enum PhoneError: Error { case connection, staleApproval }
