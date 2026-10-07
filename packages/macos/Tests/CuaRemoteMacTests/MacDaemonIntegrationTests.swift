import Darwin
import CuaRemoteCore
import CuaRemoteMac
import CuaRemoteProtocol
import Dispatch
import Foundation
import XCTest

@MainActor
final class MacDaemonIntegrationTests: XCTestCase {
    private final class MemoryStore: SecureValueStore {
        private var values: [String: Data] = [:]

        func data(forKey key: String) throws -> Data? { values[key] }
        func set(_ data: Data, forKey key: String) throws { values[key] = data }
        func removeValue(forKey key: String) throws { values[key] = nil }
    }

    @MainActor
    private final class EventRecorder {
        var messages: [AnyMessage] = []
    }

    private struct FixtureState: Decodable {
        var planCalls: [String: Int]
        var toolResults: [String]
    }

    private enum IntegrationError: Error {
        case processFailedToStart
        case timedOut
    }

    private final class ReadyLineBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?

        func set(_ value: String?) {
            lock.lock()
            self.value = value
            lock.unlock()
        }

        func get() -> String? {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    private final class BunServer {
        private let process = Process()
        private let stdout = Pipe()

        init(script: String, port: UInt16, repositoryRoot: URL) throws {
            process.executableURL = try Self.bunURL()
            process.arguments = ["run", script, String(port)]
            process.currentDirectoryURL = repositoryRoot
            let inherited = ProcessInfo.processInfo.environment
            process.environment = [
                "HOME": inherited["HOME"] ?? "/",
                "PATH": inherited["PATH"] ?? "/usr/bin:/bin",
                "TMPDIR": inherited["TMPDIR"] ?? "/tmp",
                "USER": inherited["USER"] ?? "test",
                "LANG": inherited["LANG"] ?? "en_US.UTF-8",
            ]
            process.standardOutput = stdout
            process.standardError = FileHandle.nullDevice
            try process.run()
            guard readReadyLine() == "ready" else {
                stop()
                throw IntegrationError.processFailedToStart
            }
        }

        func stop() {
            guard process.isRunning else { return }
            process.terminate()
            let deadline = Date().addingTimeInterval(3)
            while process.isRunning && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }

        private func readReadyLine() -> String? {
            let semaphore = DispatchSemaphore(value: 0)
            let result = ReadyLineBox()
            let output = stdout
            DispatchQueue.global().async { [output] in
                result.set(Self.readLine(from: output.fileHandleForReading))
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 20) == .success else { return nil }
            return result.get()
        }

        private static func readLine(from handle: FileHandle) -> String? {
            var line = Data()
            while line.count < 64 {
                let byte = handle.readData(ofLength: 1)
                guard let value = byte.first else { return nil }
                if value == 10 { return String(data: line, encoding: .utf8) }
                line.append(value)
            }
            return nil
        }

        fileprivate static func bunURL() throws -> URL {
            let environment = ProcessInfo.processInfo.environment
            let fromPath = (environment["PATH"] ?? "")
                .split(separator: ":")
                .map { String($0) + "/bun" }
            let candidates = [environment["BUN_BIN"], "/Users/devin/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
                .compactMap { $0 } + fromPath
            guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
                throw IntegrationError.processFailedToStart
            }
            return URL(fileURLWithPath: path)
        }
    }

    func testNativeBrainHostExecutesScopedReadApprovalAndDaemonRecoveryThroughLiveHub() async throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let testRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("CuaRemoteMacIntegration-\(UUID().uuidString)", isDirectory: true)
        let workspace = testRoot.appendingPathComponent("workspace", isDirectory: true)
        let home = testRoot.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try Data("daemon scoped read marker".utf8).write(to: workspace.appendingPathComponent("input.txt"))
        defer { try? FileManager.default.removeItem(at: testRoot) }

        let hubPort = try ephemeralPort()
        let hub = try BunServer(script: "apps/hub/test/remote-client-test-server.ts", port: hubPort, repositoryRoot: repositoryRoot)
        defer { hub.stop() }
        let fixturePort = try ephemeralPort()
        let fixture = try BunServer(script: "packages/brain/test/native-host-openai-fixture.ts", port: fixturePort, repositoryRoot: repositoryRoot)
        defer { fixture.stop() }

        let hubURL = URL(string: "ws://127.0.0.1:\(hubPort)/ws")!
        let provider = "openai-compat:daemon-fixture@http://127.0.0.1:\(fixturePort)/v1"
        let store = MemoryStore()
        let device = try RemoteClient(role: .device, name: "Mac", store: store)
        let phone = try RemoteClient(role: .phone, name: "iPhone", store: MemoryStore())
        let configuration = try MacDaemonConfiguration(
            repoURL: repositoryRoot,
            bunURL: try BunServer.bunURL(),
            workspaceURL: workspace,
            provider: provider,
            modelCredentialEnvironment: ["HOME": home.path]
        )
        let effectiveWorkspace = configuration.workspaceURL
        let journalURL = testRoot.appendingPathComponent("journal/runs.json")
        var daemon = try MacDaemon(client: device, configuration: configuration, journalURL: journalURL)
        let recorder = EventRecorder()
        phone.onControl = { peerId, message in
            if peerId == device.identity.deviceId { recorder.messages.append(message) }
        }
        defer {
            phone.disconnect()
            daemon.disconnect()
        }

        try await daemon.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await phone.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil { daemon.state == .ready && phone.status == .connected }
        let offer = try device.makePairOffer()
        try await phone.acceptPairOffer(json: offer, phoneName: "iPhone")
        try await waitUntil { device.pendingPairRequest?.phoneId == phone.identity.deviceId }
        try await device.confirmPair(deviceId: device.identity.deviceId, phoneId: phone.identity.deviceId)
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }

        let approvedCommand = "printf allow > allow.txt"
        try await submit("allow", id: "submit-allow", workspace: effectiveWorkspace, phone: phone, deviceId: device.identity.deviceId)
        let allowRequest = try await waitForApproval(approvedCommand, cwd: effectiveWorkspace.path, recorder: recorder)
        let allowDecision = try ApprovalSigning.signDecision(for: allowRequest, allow: true, identity: phone.identity)
        try await phone.send(.approvalDecision(allowDecision), to: device.identity.deviceId)
        try await waitForStatus(.completed, submitId: "submit-allow", daemon: daemon)
        XCTAssertEqual(try String(contentsOf: workspace.appendingPathComponent("allow.txt"), encoding: .utf8), "allow")
        let fixtureState = try await readFixtureState(port: fixturePort)
        XCTAssertTrue(fixtureState.toolResults.contains { $0.contains("daemon scoped read marker") })

        let deniedCommand = "printf deny > deny.txt"
        try await submit("deny", id: "submit-deny", workspace: effectiveWorkspace, phone: phone, deviceId: device.identity.deviceId)
        let denyRequest = try await waitForApproval(deniedCommand, cwd: effectiveWorkspace.path, recorder: recorder)
        let denyDecision = try ApprovalSigning.signDecision(for: denyRequest, allow: false, identity: phone.identity)
        try await phone.send(.approvalDecision(denyDecision), to: device.identity.deviceId)
        try await waitForStatus(.failed, submitId: "submit-deny", daemon: daemon)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("deny.txt").path))

        try await submit("cancel", id: "submit-cancel", workspace: effectiveWorkspace, phone: phone, deviceId: device.identity.deviceId)
        let cancelRequest = try await waitForApproval("printf cancel > cancel.txt", cwd: effectiveWorkspace.path, recorder: recorder)
        try await phone.send(.runCancel(RunCancel(id: "cancel-request", runId: cancelRequest.runId)), to: device.identity.deviceId)
        try await waitForStatus(.cancelled, submitId: "submit-cancel", daemon: daemon)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("cancel.txt").path))

        try await submit("disconnect", id: "submit-disconnect", workspace: effectiveWorkspace, phone: phone, deviceId: device.identity.deviceId)
        _ = try await waitForApproval("printf disconnect > disconnect.txt", cwd: effectiveWorkspace.path, recorder: recorder)
        phone.disconnect()
        try await waitForStatus(.interrupted, submitId: "submit-disconnect", daemon: daemon)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("disconnect.txt").path))

        try await phone.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }
        try await submit("restart", id: "submit-restart", workspace: effectiveWorkspace, phone: phone, deviceId: device.identity.deviceId)
        let restartRequest = try await waitForApproval("printf restart > restart.txt", cwd: effectiveWorkspace.path, recorder: recorder)
        daemon.disconnect()
        try await waitForStatus(.interrupted, submitId: "submit-restart", daemon: daemon)

        daemon = try MacDaemon(client: device, configuration: configuration, journalURL: journalURL)
        try await daemon.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }
        try await phone.send(
            .intentSubmit(IntentSubmit(
                id: "submit-restart",
                text: "scenario:restart workspace=\(effectiveWorkspace.path)",
                deviceId: device.identity.deviceId,
                mode: .agent
            )),
            to: device.identity.deviceId
        )
        try await waitUntil {
            recorder.messages.contains {
                if case .historyPage(let page) = $0 { return page.id == "submit-restart" }
                return false
            }
        }
        try await waitForStatus(.interrupted, submitId: "submit-restart", daemon: daemon)
        XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.appendingPathComponent("restart.txt").path))
        let recoveredFixtureState = try await readFixtureState(port: fixturePort)
        XCTAssertEqual(recoveredFixtureState.planCalls["restart"], 1)
        XCTAssertEqual(
            try XCTUnwrap(daemon.history.first(where: { $0.submitId == "submit-restart" })?.brainRunId),
            restartRequest.runId
        )

        daemon.disconnect()
        let blockedJournal = testRoot.appendingPathComponent("blocked/runs.json")
        daemon = try MacDaemon(client: device, configuration: configuration, journalURL: blockedJournal)
        try FileManager.default.removeItem(at: blockedJournal.deletingLastPathComponent())
        try Data("not a directory".utf8).write(to: blockedJournal.deletingLastPathComponent())
        try await daemon.connect(to: hubURL, allowInsecureLocalDevelopment: true)
        try await waitUntil {
            device.peers[phone.identity.deviceId]?.ready == true
                && phone.peers[device.identity.deviceId]?.ready == true
        }
        try await phone.send(
            .intentSubmit(IntentSubmit(
                id: "submit-persistence-failure",
                text: "scenario:persistence workspace=\(workspace.path)",
                deviceId: device.identity.deviceId,
                mode: .agent
            )),
            to: device.identity.deviceId
        )
        try await waitUntil { daemon.state == .failed }
        try await waitUntil {
            recorder.messages.contains {
                if case .errorMsg(let error) = $0 {
                    return error.code == "journal_failed" && error.ref == "submit-persistence-failure"
                }
                return false
            }
        }
        XCTAssertNil(daemon.history.first(where: { $0.submitId == "submit-persistence-failure" }))
        let finalFixtureState = try await readFixtureState(port: fixturePort)
        XCTAssertNil(finalFixtureState.planCalls["persistence"])
    }

    private func submit(
        _ scenario: String,
        id: String,
        workspace: URL,
        phone: RemoteClient,
        deviceId: String
    ) async throws {
        try await phone.send(
            .intentSubmit(IntentSubmit(
                id: id,
                text: "scenario:\(scenario) workspace=\(workspace.path)",
                deviceId: deviceId,
                mode: .agent
            )),
            to: deviceId
        )
    }

    private func waitForApproval(_ command: String, cwd: String, recorder: EventRecorder) async throws -> StepApprovalRequired {
        let expectedDetail = shellApprovalDetail(command: command, cwd: cwd)
        try await waitUntil {
            recorder.messages.contains {
                if case .stepApprovalRequired(let request) = $0 {
                    return request.action.detail == expectedDetail && request.action.targetPath == cwd
                }
                return false
            }
        }
        return try XCTUnwrap(recorder.messages.compactMap {
            if case .stepApprovalRequired(let request) = $0 { return request }
            return nil
        }.first(where: { $0.action.detail == expectedDetail && $0.action.targetPath == cwd }))
    }

    private func waitForStatus(_ status: MacRunStatus, submitId: String, daemon: MacDaemon) async throws {
        try await waitUntil(timeout: 20) {
            daemon.history.first(where: { $0.submitId == submitId })?.status == status
        }
    }

    private func readFixtureState(port: UInt16) async throws -> FixtureState {
        let url = URL(string: "http://127.0.0.1:\(port)/state")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    private func waitUntil(
        timeout: TimeInterval = 15,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw IntegrationError.timedOut
    }

    private func ephemeralPort() throws -> UInt16 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw IntegrationError.processFailedToStart }
        defer { close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { throw IntegrationError.processFailedToStart }
        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let resolved = withUnsafeMutablePointer(to: &actual) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        guard resolved == 0, actual.sin_port != 0 else { throw IntegrationError.processFailedToStart }
        return UInt16(bigEndian: actual.sin_port)
    }
}
