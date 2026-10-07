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
