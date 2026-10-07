import Combine
import CuaRemoteCore
import CuaRemoteProtocol
import Foundation

public struct MacDaemonConfiguration {
    public let repoURL: URL
    public let bunURL: URL
    public let workspaceURL: URL
    public let provider: String
    public let modelCredentialEnvironment: [String: String]

    public init(
        repoURL: URL,
        bunURL: URL,
        workspaceURL: URL,
        provider: String,
        modelCredentialEnvironment: [String: String] = [:]
    ) throws {
        var repositoryIsDirectory: ObjCBool = false
        var workspaceIsDirectory: ObjCBool = false
        guard repoURL.isFileURL, bunURL.isFileURL, workspaceURL.isFileURL,
              FileManager.default.isExecutableFile(atPath: bunURL.path),
              FileManager.default.fileExists(atPath: repoURL.path, isDirectory: &repositoryIsDirectory),
              repositoryIsDirectory.boolValue,
              FileManager.default.fileExists(atPath: workspaceURL.path, isDirectory: &workspaceIsDirectory),
              workspaceIsDirectory.boolValue,
              !provider.isEmpty, !provider.utf8.contains(0),
              modelCredentialEnvironment.allSatisfy({
                  $0.key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil
                      && !$0.value.utf8.contains(0)
              }) else {
            throw MacDaemonError.invalidConfiguration
        }
        self.repoURL = repoURL.resolvingSymlinksInPath().standardizedFileURL
        self.bunURL = bunURL.resolvingSymlinksInPath().standardizedFileURL
        self.workspaceURL = workspaceURL.resolvingSymlinksInPath().standardizedFileURL
        self.provider = provider
        self.modelCredentialEnvironment = modelCredentialEnvironment
    }
}

public enum MacDaemonState: Equatable {
    case idle
    case connecting
    case ready
    case running
    case interrupted
    case failed
}

public enum MacDaemonError: Error {
    case invalidConfiguration
    case wrongRemoteRole
    case lineTooLarge
    case invalidBrainMessage
    case connectionTimeout
    case connectionFailed
}

@MainActor
public final class MacDaemon: ObservableObject {
    public static let executionAuthorityNotice = "shell.run, applescript.run, and shortcuts.run execute as the logged-in user with that user's full account authority; the workspace is a working directory, not a sandbox."

    @Published public private(set) var state: MacDaemonState = .idle
    @Published public private(set) var currentRun: MacRunRecord?
    @Published public private(set) var history: [MacRunRecord]

    public let client: RemoteClient
    public let configuration: MacDaemonConfiguration

    private var journal: RunJournal
    private let tools: WorkspaceToolExecutor
    private var activeChild: ProcessGroupChild?
    private var activeCancellation: RunCancellation?
    private var activeToken: UUID?
    private var brainOutput = Data()
    private var brainOutputQueue: [Data] = []
    private var brainOutputQueueBytes = 0
    private var brainDrainTask: Task<Void, Never>?
    private var brainDrainToken: UUID?
    private var grants = ApprovalGrantLedger()

    public init(
        client: RemoteClient,
        configuration: MacDaemonConfiguration,
        journalURL: URL? = nil
    ) throws {
        guard client.role == .device else { throw MacDaemonError.wrongRemoteRole }
        self.client = client
        self.configuration = configuration
        var loadedJournal = try RunJournal(fileURL: journalURL)
        try loadedJournal.interruptActiveRuns(now: Int(Date().timeIntervalSince1970))
        self.journal = loadedJournal
        self.history = loadedJournal.allRecords()
        self.tools = WorkspaceToolExecutor(workspaceURL: configuration.workspaceURL)

        client.onControl = { [weak self] peerId, message in
            Task { @MainActor [weak self] in
                await self?.handleControl(message, from: peerId)
            }
        }
        client.onPeerUnavailable = { [weak self] peerId in
            self?.peerBecameUnavailable(peerId)
        }
        client.onTransportEnded = { [weak self] in
            self?.transportEnded()
        }
    }

    public func connect(
        to hubURL: URL,
        token: String? = nil,
        allowInsecureLocalDevelopment: Bool = false
    ) async throws {
        state = .connecting
        do {
            try await client.connect(to: hubURL, token: token, allowInsecureLocalDevelopment: allowInsecureLocalDevelopment)
            let deadline = Date().addingTimeInterval(15)
            while client.status != .connected && Date() < deadline {
                if case .failed = client.status { throw MacDaemonError.connectionFailed }
                try await Task.sleep(for: .milliseconds(25))
            }
            guard client.status == .connected else { throw MacDaemonError.connectionTimeout }
            state = .ready
        } catch {
            state = .failed
            throw error
        }
    }

    public func disconnect() {
        interruptActiveRun(summary: "interrupted, effects may remain", status: .interrupted, notifyPeer: false)
        client.disconnect()
        if state != .failed { state = .idle }
    }

    public func stopCurrentRun() {
        interruptActiveRun(summary: "interrupted, effects may remain", status: .interrupted, notifyPeer: true)
    }

    private func handleControl(_ message: AnyMessage, from peerId: String) async {
        guard isReadyOwner(peerId) else {
            await reject(messageId: messageId(message), code: "untrusted_peer", from: peerId)
            return
        }
        switch message {
        case .intentSubmit(let submit):
            await accept(submit, from: peerId)
        case .runCancel(let cancel):
            guard let record = currentRun,
                  record.ownerPeerId == peerId,
                  cancel.runId == record.id || cancel.runId == record.brainRunId else {
                await reject(messageId: cancel.id, code: "unknown_run", from: peerId)
                return
            }
            interruptActiveRun(summary: "interrupted, effects may remain", status: .cancelled, notifyPeer: true)
        case .approvalDecision(let decision):
            await authorize(decision, from: peerId)
        case .historyList(let request):
            await sendHistory(request, to: peerId)
        default:
            await reject(messageId: messageId(message), code: "unsupported_control", from: peerId)
        }
    }

    private func accept(_ submit: IntentSubmit, from peerId: String) async {
        guard submit.deviceId == client.identity.deviceId, submit.mode == .agent else {
            await reject(messageId: submit.id, code: "invalid_submission", from: peerId)
            return
        }
        if let existing = journal.record(submitId: submit.id, ownerPeerId: peerId) {
            await send(.historyPage(HistoryPage(id: submit.id, items: [existing.historyItem()])), to: peerId)
            return
        }
        guard currentRun == nil else {
            await reject(messageId: submit.id, code: "busy", from: peerId)
            return
        }

        let now = Int(Date().timeIntervalSince1970)
        var record = MacRunRecord(
            id: UUID().uuidString.lowercased(),
            submitId: submit.id,
            ownerPeerId: peerId,
            deviceId: client.identity.deviceId,
            intent: submit.text,
            provider: configuration.provider,
            createdAt: now,
            status: .starting,
            summary: "starting"
        )
        do {
            try journal.insert(record)
        } catch {
            persistenceFailed()
            await reject(messageId: submit.id, code: "journal_failed", from: peerId)
            return
        }
        refreshHistory()
        currentRun = record
        state = .running
        let token = UUID()
        activeToken = token
        resetBrainOutput(token: token)
        grants.clearAll()
        let cancellation = RunCancellation()
        activeCancellation = cancellation

        do {
            let script = configuration.repoURL.appendingPathComponent("packages/brain/src/cli.ts").path
            let child = try ProcessGroupChild.spawn(
                executable: configuration.bunURL.path,
                arguments: ["run", script, "--mode", "host", "--native", "--provider", configuration.provider],
                workingDirectory: configuration.workspaceURL,
                environment: childEnvironment()
            )
            activeChild = child
            cancellation.attach(child)
            child.installHandlers(
                onStdout: { [weak self, weak child] data in
                    guard let child else { return }
                    Task { @MainActor [weak self] in
                        self?.enqueueBrainOutput(data, from: child, token: token)
                    }
                },
                onExit: { [weak self] status in
                    Task { @MainActor [weak self] in
                        self?.brainExited(status, token: token)
                    }
                }
            )
            let localSubmit = IntentSubmit(
                id: submit.id,
                text: submit.text,
                deviceId: client.identity.deviceId,
                mode: .agent
            )
            try await child.write(try encodedLine(.intentSubmit(localSubmit)))
        } catch {
            record.status = .failed
            record.finishedAt = Int(Date().timeIntervalSince1970)
            record.summary = "Brain host could not start"
            guard persist(record) else {
                await reject(messageId: submit.id, code: "journal_failed", from: peerId)
                return
            }
            currentRun = nil
            activeToken = nil
            discardBrainOutput(token: token)
            activeChild?.terminate()
            activeChild = nil
            activeCancellation?.cancel()
            activeCancellation = nil
            state = .failed
            await reject(messageId: submit.id, code: "brain_start_failed", from: peerId)
        }
    }

    private func enqueueBrainOutput(_ data: Data, from child: ProcessGroupChild, token: UUID) {
        guard token == activeToken, child === activeChild else { return }
        guard data.count <= 8_388_608 - brainOutputQueueBytes else {
            failBrain(token: token, code: "brain_output_queue_full")
            return
        }
        brainOutputQueue.append(data)
        brainOutputQueueBytes += data.count
        guard brainDrainTask == nil else { return }
        brainDrainToken = token
        brainDrainTask = Task { @MainActor [weak self] in
            await self?.drainBrainOutput(from: child, token: token)
        }
    }

    private func drainBrainOutput(from child: ProcessGroupChild, token: UUID) async {
        defer {
            if brainDrainToken == token {
                brainDrainTask = nil
                brainDrainToken = nil
            }
        }
        while token == activeToken, child === activeChild, brainDrainToken == token {
            guard !brainOutputQueue.isEmpty else { return }
            let data = brainOutputQueue.removeFirst()
            brainOutputQueueBytes -= data.count
            brainOutput.append(data)
            while let newline = brainOutput.firstIndex(of: 10) {
                let line = Data(brainOutput[..<newline])
                brainOutput.removeSubrange(...newline)
                if line.isEmpty { continue }
                guard line.count <= 1_048_576 else {
                    failBrain(token: token, code: "brain_line_too_large")
                    return
                }
                guard let message = try? JSONDecoder().decode(AnyMessage.self, from: line) else {
                    failBrain(token: token, code: "invalid_brain_message")
                    return
                }
                await handleBrainMessage(message, from: child, token: token)
                guard token == activeToken, child === activeChild else { return }
            }
            if brainOutput.count > 1_048_576 {
                failBrain(token: token, code: "brain_line_too_large")
                return
            }
        }
    }

    private func handleBrainMessage(_ message: AnyMessage, from child: ProcessGroupChild, token: UUID) async {
        guard token == activeToken, child === activeChild, let record = currentRun else { return }
        switch message {
        case .toolsList(let request):
            let response = ToolsListResult(id: request.id, tools: tools.descriptors, scope: tools.scope)
            await writeToBrain(.toolsListResult(response), child: child, token: token)
        case .toolsCall(let call):
            await executeToolCall(call, child: child, token: token)
        case .runCreated(let event):
            var updated = record
            updated.brainRunId = event.runId
            updated.status = .running
            updated.summary = "running"
            guard persist(updated) else { return }
            currentRun = updated
            refreshHistory()
            await send(.runCreated(event), to: record.ownerPeerId)
        case .stepApprovalRequired(let request):
            do {
                _ = try ApprovalSigning.validateRequest(request)
                guard request.runId == record.brainRunId,
                      request.level == .l2,
                      [.shell, .applescript, .shortcuts].contains(request.action.channel) else {
                    throw ApprovalSigningError.malformedRequest
                }
                try grants.stage(request, from: record.ownerPeerId)
                await send(.stepApprovalRequired(request), to: record.ownerPeerId)
            } catch {
                failBrain(token: token, code: "invalid_approval_request")
            }
        case .stepFinished(let event):
            grants.clear(runId: event.runId, stepId: event.stepId)
            await send(.stepFinished(event), to: record.ownerPeerId)
        case .planUpdated(_), .stepStarted(_), .stepPrecheck(_), .terminalSuggestion(_):
            await send(message, to: record.ownerPeerId)
        case .runFinished(let event):
            var updated = record
            updated.status = event.ok ? .completed : (event.cancelled == true ? .cancelled : .failed)
            updated.finishedAt = Int(Date().timeIntervalSince1970)
            updated.summary = event.summary
            guard persist(updated) else { return }
            refreshHistory()
            currentRun = nil
            state = .ready
            grants.clear(runId: event.runId)
            activeToken = nil
            discardBrainOutput(token: token)
            activeCancellation?.cancel()
            activeCancellation = nil
            activeChild = nil
            await send(.runFinished(event), to: record.ownerPeerId)
        case .errorMsg(let error):
            await send(.errorMsg(error), to: record.ownerPeerId)
            failBrain(token: token, code: "brain_error")
        default:
            failBrain(token: token, code: "unsupported_brain_message")
        }
    }

    private func executeToolCall(_ call: ToolsCall, child: ProcessGroupChild, token: UUID) async {
        guard token == activeToken, child === activeChild, let record = currentRun,
              let cancellation = activeCancellation else { return }
        if ["shell.run", "applescript.run", "shortcuts.run"].contains(call.tool) {
            guard grants.consumeGrant(
                for: call,
                runId: record.brainRunId ?? record.id,
                peerId: record.ownerPeerId
            ) else {
                let denied = ToolsResult(
                    id: call.id,
                    callId: call.callId,
                    ok: false,
                    error: "no matching single-use signed approval grant",
                    ms: 0
                )
                await writeToBrain(.toolsResult(denied), child: child, token: token)
                return
            }
        }
        let result = await tools.execute(call, cancellation: cancellation)
        guard token == activeToken, child === activeChild else { return }
        await writeToBrain(.toolsResult(result), child: child, token: token)
    }

    private func authorize(_ decision: ApprovalDecision, from peerId: String) async {
        guard let record = currentRun, record.ownerPeerId == peerId,
              let trustedPeer = try? client.trustedPeer(deviceId: peerId) else {
            await reject(messageId: decision.id, code: "foreign_approval", from: peerId)
            return
        }
        do {
            _ = try grants.authorize(decision, from: peerId, owner: trustedPeer)
            guard let child = activeChild, let token = activeToken else {
                grants.clear(runId: decision.runId)
                await reject(messageId: decision.id, code: "run_finished", from: peerId)
                return
            }
            do {
                try await child.write(try encodedLine(.approvalDecision(decision)))
            } catch {
                failBrain(token: token, code: "brain_stdin_failed")
            }
        } catch {
            await reject(messageId: decision.id, code: "invalid_approval", from: peerId)
        }
    }

    private func sendHistory(_ request: HistoryList, to peerId: String) async {
        var records = journal.allRecords().filter { $0.ownerPeerId == peerId }
        if let cursor = request.cursor,
           let index = records.firstIndex(where: { $0.id == cursor || $0.brainRunId == cursor }) {
            records = Array(records.dropFirst(index + 1))
        }
        let limit = min(200, max(1, request.limit ?? 50))
        let page = Array(records.prefix(limit))
        let hasMore = records.count > page.count
        let nextCursor = hasMore ? page.last?.brainRunId ?? page.last?.id : nil
        await send(.historyPage(HistoryPage(id: request.id, items: page.map { $0.historyItem() }, nextCursor: nextCursor)), to: peerId)
    }

    private func isReadyOwner(_ peerId: String) -> Bool {
        client.status == .connected
            && client.peers[peerId]?.ready == true
            && (try? client.trustedPeer(deviceId: peerId)) != nil
    }

    private func peerBecameUnavailable(_ peerId: String) {
        grants.clear(peerId: peerId)
        if currentRun?.ownerPeerId == peerId {
            interruptActiveRun(summary: "interrupted, effects may remain", status: .interrupted, notifyPeer: false)
        }
    }

    private func transportEnded() {
        grants.clearAll()
        if currentRun != nil {
            interruptActiveRun(summary: "interrupted, effects may remain", status: .interrupted, notifyPeer: false)
        }
        if state != .failed { state = .idle }
    }

    private func interruptActiveRun(summary: String, status: MacRunStatus, notifyPeer: Bool) {
        guard var record = currentRun else {
            grants.clearAll()
            return
        }
        let runId = record.brainRunId ?? record.id
        let peerId = record.ownerPeerId
        let token = activeToken
        record.status = status
        record.finishedAt = Int(Date().timeIntervalSince1970)
        record.summary = summary
        guard persist(record) else { return }
        activeToken = nil
        if let token { discardBrainOutput(token: token) }
        refreshHistory()
        currentRun = nil
        grants.clear(runId: runId)
        activeCancellation?.cancel()
        activeCancellation = nil
        activeChild?.terminate()
        activeChild = nil
        state = client.status == .connected ? .ready : .interrupted
        if notifyPeer {
            let ended = RunFinished(
                id: UUID().uuidString.lowercased(),
                runId: runId,
                ok: false,
                summary: summary,
                cost: Cost(inputTokens: 0, outputTokens: 0, jevTokens: 0, usd: 0),
                stepCount: 0,
                cancelled: status == .cancelled
            )
            Task { await send(.runFinished(ended), to: peerId) }
        }
    }

    private func failBrain(token: UUID, code: String) {
        guard token == activeToken, var record = currentRun else { return }
        let peerId = record.ownerPeerId
        record.status = .failed
        record.finishedAt = Int(Date().timeIntervalSince1970)
        record.summary = "Brain host failed"
        guard persist(record) else { return }
        activeToken = nil
        discardBrainOutput(token: token)
        refreshHistory()
        currentRun = nil
        grants.clear(runId: record.brainRunId ?? record.id)
        activeCancellation?.cancel()
        activeCancellation = nil
        activeChild?.terminate()
        activeChild = nil
        state = .failed
        Task { await reject(messageId: record.submitId, code: code, from: peerId) }
    }

    private func brainExited(_ status: Int32, token: UUID) {
        guard token == activeToken, currentRun?.isActive == true else { return }
        failBrain(token: token, code: processExitedNormally(status) && processExitCode(status) == 0 ? "brain_exited_early" : "brain_process_failed")
    }

    private func writeToBrain(_ message: AnyMessage, child: ProcessGroupChild, token: UUID) async {
        do {
            try await child.write(try encodedLine(message))
        } catch {
            if token == activeToken { failBrain(token: token, code: "brain_stdin_failed") }
        }
    }

    @discardableResult
    private func persist(_ record: MacRunRecord) -> Bool {
        do {
            try journal.update(record)
            return true
        } catch {
            persistenceFailed()
            return false
        }
    }

    private func persistenceFailed() {
        state = .failed
        if let token = activeToken { discardBrainOutput(token: token) }
        activeToken = nil
        grants.clearAll()
        activeCancellation?.cancel()
        activeCancellation = nil
        activeChild?.terminate()
        activeChild = nil
    }

    private func resetBrainOutput(token: UUID) {
        brainDrainTask?.cancel()
        brainDrainTask = nil
        brainDrainToken = token
        brainOutput.removeAll(keepingCapacity: true)
        brainOutputQueue.removeAll(keepingCapacity: true)
        brainOutputQueueBytes = 0
    }

    private func discardBrainOutput(token: UUID) {
        guard brainDrainToken == token else { return }
        brainDrainTask?.cancel()
        brainDrainTask = nil
        brainDrainToken = nil
        brainOutput.removeAll(keepingCapacity: false)
        brainOutputQueue.removeAll(keepingCapacity: false)
        brainOutputQueueBytes = 0
    }

    private func refreshHistory() {
        history = journal.allRecords()
    }

    private func childEnvironment() -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [:]
        for key in ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL"] {
            if let value = inherited[key] { environment[key] = value }
        }
        for (key, value) in configuration.modelCredentialEnvironment {
            environment[key] = value
        }
        return environment
    }

    private func send(_ message: AnyMessage, to peerId: String) async {
        guard client.peers[peerId]?.ready == true else { return }
        try? await client.send(message, to: peerId)
    }

    private func reject(messageId: String, code: String, from peerId: String) async {
        await send(
            .errorMsg(ErrorMsg(id: UUID().uuidString.lowercased(), code: code, message: "Request rejected by the local Mac host.", ref: messageId)),
            to: peerId
        )
    }

    private func messageId(_ message: AnyMessage) -> String {
        switch message {
        case .intentSubmit(let value): value.id
        case .runCancel(let value): value.id
        case .approvalDecision(let value): value.id
        case .historyList(let value): value.id
        default: UUID().uuidString.lowercased()
        }
    }

    private func encodedLine(_ message: AnyMessage) throws -> Data {
        var data = try JSONEncoder().encode(message)
        guard data.count <= 1_048_576 else { throw MacDaemonError.lineTooLarge }
        data.append(10)
        return data
    }
}
