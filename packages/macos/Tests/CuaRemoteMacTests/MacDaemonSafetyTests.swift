import CryptoKit
import CuaRemoteCore
import CuaRemoteProtocol
import Foundation
import XCTest
@testable import CuaRemoteMac

final class MacDaemonSafetyTests: XCTestCase {
    private final class MemoryStore: SecureValueStore {
        private var values: [String: Data] = [:]
        func data(forKey key: String) throws -> Data? { values[key] }
        func set(_ data: Data, forKey key: String) throws { values[key] = data }
        func removeValue(forKey key: String) throws { values[key] = nil }
    }

    private final class LockedData: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Data()

        func append(_ data: Data) {
            lock.lock()
            value.append(data)
            lock.unlock()
        }

        var snapshot: Data {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    func testNonblockingChildWriteDrainsMoreThanPipeCapacity() async throws {
        try await withWorkspace { workspace in
            let child = try ProcessGroupChild.spawn(executable: "/bin/cat", arguments: [], workingDirectory: workspace, environment: [:])
            let output = LockedData()
            let exited = expectation(description: "cat exited after EOF")
            child.installHandlers(
                onStdout: { output.append($0) },
                onExit: { _ in exited.fulfill() }
            )
            let payload = Data(repeating: 0x61, count: 1_048_576)

            try await child.write(payload)
            child.closeInput()
            await fulfillment(of: [exited], timeout: 10)

            XCTAssertEqual(output.snapshot, payload)
        }
    }

    func testBlockedChildWriteIsCancellable() async throws {
        try await withWorkspace { workspace in
            let child = try ProcessGroupChild.spawn(executable: "/bin/sleep", arguments: ["30"], workingDirectory: workspace, environment: [:])
            let exited = expectation(description: "sleep terminated")
            child.installHandlers(onStdout: { _ in }, onExit: { _ in exited.fulfill() })
            defer { child.terminate() }
            let write = Task { try await child.write(Data(repeating: 0x61, count: 1_048_576)) }

            try await Task.sleep(for: .milliseconds(100))
            write.cancel()
            do {
                try await write.value
                XCTFail("cancelled pipe write unexpectedly completed")
            } catch is CancellationError {
            }
            child.terminate()
            await fulfillment(of: [exited], timeout: 5)
        }
    }

    func testChildWriteQueueRejectsExcessBytes() async throws {
        try await withWorkspace { workspace in
            let child = try ProcessGroupChild.spawn(executable: "/bin/sleep", arguments: ["30"], workingDirectory: workspace, environment: [:])
            defer { child.terminate() }
            let payload = Data(repeating: 0x61, count: 1_048_576)
            let writes = [Task { try await child.write(payload) }] + (0..<3).map { _ in
                Task { try await child.write(payload) }
            }

            try await Task.sleep(for: .milliseconds(100))
            do {
                try await child.write(payload)
                XCTFail("write queue accepted more than its configured capacity")
            } catch ProcessGroupError.writeQueueFull {
            }
            writes.forEach { $0.cancel() }
            for write in writes {
                _ = try? await write.value
            }
        }
    }

    func testTerminationKillsStubbornSameGroupChildAfterLeaderExits() async throws {
        try await withWorkspace { workspace in
            let marker = workspace.appendingPathComponent("marker.txt")
            let child = try ProcessGroupChild.spawn(
                executable: "/bin/sh",
                arguments: ["-c", "trap '' TERM; (sleep 3; printf stubborn > \(marker.path)) & exit 0"],
                workingDirectory: workspace,
                environment: [:]
            )
            let exited = expectation(description: "leader and same-group descendants finished")
            child.installHandlers(onStdout: { _ in }, onExit: { _ in exited.fulfill() })

            for _ in 0..<100 where !child.leaderHasExited {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(child.leaderHasExited)
            XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
            child.terminate()
            await fulfillment(of: [exited], timeout: 3)

            try await Task.sleep(for: .seconds(3.5))
            XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        }
    }

    func testCompletedChildrenReleaseDescriptorsAndDispatchSources() async throws {
        try await withWorkspace { workspace in
            let baseline = Self.openDescriptorCount()
            for index in 0..<20 {
                let child = try ProcessGroupChild.spawn(
                    executable: "/bin/echo",
                    arguments: ["run-\(index)"],
                    workingDirectory: workspace,
                    environment: [:]
                )
                let exited = expectation(description: "echo \(index) exited")
                child.installHandlers(onStdout: { _ in }, onExit: { _ in exited.fulfill() })
                child.closeInput()
                await fulfillment(of: [exited], timeout: 10)
            }
            try await Task.sleep(for: .milliseconds(200))

            XCTAssertLessThanOrEqual(Self.openDescriptorCount(), baseline + 4)
        }
    }

    private static func openDescriptorCount() -> Int {
        let limit = min(getdtablesize(), 4_096)
        return (0..<Int32(limit)).reduce(0) { $0 + (fcntl($1, F_GETFD) >= 0 ? 1 : 0) }
    }

    func testSignedApprovalExecutesExactShellWriteOnce() async throws {
        try await withWorkspace { workspace in
            let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
            let trustedPhone = TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys)
            let now = 1_000
            let output = workspace.appendingPathComponent("approved.txt")
            let command = "printf approved > \(output.path)"
            let request = makeRequest(now: now, detail: command, targetPath: workspace.path)
            let decision = try ApprovalSigning.signDecision(for: request, allow: true, identity: phone, now: now)
            var ledger = ApprovalGrantLedger()
            try ledger.stage(request, from: phone.deviceId, now: now)
            XCTAssertTrue(try ledger.authorize(decision, from: phone.deviceId, owner: trustedPhone, now: now))

            let call = ToolsCall(
                id: "tool-result-1",
                callId: "call-1",
                tool: "shell.run",
                args: ["cmd": .string(command), "cwd": .string(workspace.path)],
                timeoutMs: 5_000
            )
            XCTAssertTrue(ledger.consumeGrant(for: call, runId: request.runId, peerId: phone.deviceId, now: now))
            let result = await WorkspaceToolExecutor(workspaceURL: workspace).execute(call, cancellation: RunCancellation())
            XCTAssertTrue(result.ok, result.error ?? "shell tool failed")
            XCTAssertEqual(try String(contentsOf: output, encoding: .utf8), "approved")
            XCTAssertFalse(ledger.consumeGrant(for: call, runId: request.runId, peerId: phone.deviceId, now: now))
        }
    }

    func testDenyExpiryReplayAndForeignSignerDoNotGrantExecution() throws {
        let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let owner = TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys)
        let now = 2_000
        let sideEffect = FileManager.default.temporaryDirectory.appendingPathComponent("CuaRemoteMac-denied-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: sideEffect) }
        let request = makeRequest(now: now)
        var ledger = ApprovalGrantLedger()
        try ledger.stage(request, from: phone.deviceId, now: now)
        let denial = try ApprovalSigning.signDecision(for: request, allow: false, identity: phone, now: now)
        XCTAssertFalse(try ledger.authorize(denial, from: phone.deviceId, owner: owner, now: now))

        let expired = makeRequest(now: now, expiresAt: now)
        XCTAssertThrowsError(try ledger.stage(expired, from: phone.deviceId, now: now))

        let foreign = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let foreignOwner = TrustedPeer(deviceId: foreign.deviceId, name: "Other", pubKeys: try foreign.publicKeys)
        let foreignRequest = makeRequest(now: now, runId: "run-foreign")
        try ledger.stage(foreignRequest, from: phone.deviceId, now: now)
        let foreignDecision = try ApprovalSigning.signDecision(for: foreignRequest, allow: true, identity: foreign, now: now)
        XCTAssertThrowsError(try ledger.authorize(foreignDecision, from: phone.deviceId, owner: foreignOwner, now: now))
        XCTAssertThrowsError(try ledger.authorize(denial, from: phone.deviceId, owner: owner, now: now))
        XCTAssertFalse(ledger.consumeGrant(
            for: shellCall("printf denied > \(sideEffect.path)"),
            runId: request.runId,
            peerId: phone.deviceId,
            now: now
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: sideEffect.path))
    }

    func testCancelledApprovalWaiterCannotCreateAWriteGrant() throws {
        let phone = try DeviceIdentityRepository(store: MemoryStore()).loadOrCreate()
        let owner = TrustedPeer(deviceId: phone.deviceId, name: "iPhone", pubKeys: try phone.publicKeys)
        let now = 3_000
        let sideEffect = FileManager.default.temporaryDirectory.appendingPathComponent("CuaRemoteMac-cancelled-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: sideEffect) }
        let request = makeRequest(now: now, runId: "run-cancelled")
        var ledger = ApprovalGrantLedger()
        try ledger.stage(request, from: phone.deviceId, now: now)
        ledger.clear(runId: request.runId)
        let decision = try ApprovalSigning.signDecision(for: request, allow: true, identity: phone, now: now)

        XCTAssertThrowsError(try ledger.authorize(decision, from: phone.deviceId, owner: owner, now: now))
        XCTAssertFalse(ledger.consumeGrant(
            for: shellCall("printf cancelled > \(sideEffect.path)"),
            runId: request.runId,
            peerId: phone.deviceId,
            now: now
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: sideEffect.path))
    }

    func testRestartMarksActiveRunInterruptedAndKeepsSubmitDeduplication() throws {
        try withWorkspace { workspace in
            let journalURL = workspace.appendingPathComponent("journal/runs.json")
            var journal = try RunJournal(fileURL: journalURL)
            let run = MacRunRecord(
                id: "local-run",
                submitId: "submission-1",
                ownerPeerId: "phone-1",
                deviceId: "mac-1",
                intent: "write a file",
                provider: "locally-selected-provider",
                createdAt: 100,
                status: .running,
                summary: "running"
            )
            try journal.insert(run)

            var restarted = try RunJournal(fileURL: journalURL)
            try restarted.interruptActiveRuns(now: 200)
            let record = try XCTUnwrap(restarted.record(submitId: run.submitId, ownerPeerId: run.ownerPeerId))
            XCTAssertEqual(record.status, .interrupted)
            XCTAssertEqual(record.summary, "interrupted, effects may remain")
            XCTAssertEqual(record.finishedAt, 200)
            XCTAssertEqual(restarted.allRecords().filter { $0.submitId == run.submitId && $0.ownerPeerId == run.ownerPeerId }.count, 1)
        }
    }

    func testScopedReadRejectsSymlinkEscape() async throws {
        try await withWorkspace { workspace in
            let outside = workspace.deletingLastPathComponent().appendingPathComponent("outside-\(UUID().uuidString).txt")
            try Data("outside".utf8).write(to: outside)
            defer { try? FileManager.default.removeItem(at: outside) }
            let link = workspace.appendingPathComponent("escape.txt")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
            let executor = WorkspaceToolExecutor(workspaceURL: workspace)
            let call = ToolsCall(
                id: "read-result",
                callId: "read-call",
                tool: "fs.read",
                args: ["path": .string("escape.txt")]
            )
            let result = await executor.execute(call, cancellation: RunCancellation())
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.error, "path is outside the selected workspace")
        }
    }

    func testFilesystemToolsCheckCancellationAndRejectRoundedIntMax() async throws {
        try await withWorkspace { workspace in
            let file = workspace.appendingPathComponent("input.txt")
            try Data("contents".utf8).write(to: file)
            let executor = WorkspaceToolExecutor(workspaceURL: workspace)
            let cancelled = RunCancellation()
            cancelled.cancel()
            let read = ToolsCall(id: "read-cancelled", callId: "read", tool: "fs.read", args: ["path": .string("input.txt")])
            let list = ToolsCall(id: "list-cancelled", callId: "list", tool: "fs.list", args: ["path": .string(".")])

            let readResult = await executor.execute(read, cancellation: cancelled)
            let listResult = await executor.execute(list, cancellation: cancelled)
            XCTAssertEqual(readResult.error, "execution cancelled")
            XCTAssertEqual(listResult.error, "execution cancelled")

            let overflow = ToolsCall(
                id: "read-overflow",
                callId: "overflow",
                tool: "fs.read",
                args: ["path": .string("input.txt"), "maxBytes": .number(Double(Int.max))]
            )
            let overflowResult = await executor.execute(overflow, cancellation: RunCancellation())
            XCTAssertEqual(overflowResult.error, "unsupported or malformed tool arguments")
        }
    }

    func testJournalInsertAndUpdateLeaveMemoryUnchangedAfterPersistenceFailure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CuaRemoteMacJournal-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journalURL = directory.appendingPathComponent("runs.json")
        var journal = try RunJournal(fileURL: journalURL)
        let record = MacRunRecord(
            id: "journal-run",
            submitId: "journal-submit",
            ownerPeerId: "phone",
            deviceId: "mac",
            intent: "persist a record",
            provider: "fixture",
            createdAt: 100,
            status: .starting,
            summary: "starting"
        )

        try FileManager.default.removeItem(at: directory)
        try Data("block".utf8).write(to: directory)
        XCTAssertThrowsError(try journal.insert(record))
        XCTAssertTrue(journal.allRecords().isEmpty)

        try FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try journal.insert(record)
        try FileManager.default.removeItem(at: directory)
        try Data("block".utf8).write(to: directory)
        var completed = record
        completed.status = .completed
        XCTAssertThrowsError(try journal.update(completed))
        XCTAssertEqual(journal.allRecords().first?.status, .starting)
    }

    private func makeRequest(
        now: Int,
        expiresAt: Int? = nil,
        detail: String = "printf approved > /tmp/approved.txt",
        targetPath: String? = nil,
        runId: String = "run-1"
    ) -> StepApprovalRequired {
        let stepId = "step-1"
        let expiry = expiresAt ?? now + 120
        let digest = SHA256.hash(data: Data(detail.utf8)).map { String(format: "%02x", $0) }.joined()
        let challenge = [
            "cuaremote-approval-v1",
            runId,
            stepId,
            digest,
            "nonce_123",
            String(expiry),
        ].joined(separator: "\n")
        return StepApprovalRequired(
            id: "approval-\(runId)",
            runId: runId,
            stepId: stepId,
            level: .l2,
            action: ConcreteAction(channel: .shell, summary: "Run approved shell command", detail: detail, targetPath: targetPath),
            reason: "Explicit approval required",
            expiresAt: expiry,
            challenge: challenge
        )
    }

    private func shellCall(_ command: String) -> ToolsCall {
        ToolsCall(id: "result", callId: "call", tool: "shell.run", args: ["cmd": .string(command)])
    }

    private func withWorkspace(_ body: (URL) async throws -> Void) async throws {
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("CuaRemoteMacTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workspace) }
        try await body(workspace)
    }

    private func withWorkspace(_ body: (URL) throws -> Void) throws {
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("CuaRemoteMacTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workspace) }
        try body(workspace)
    }
}
