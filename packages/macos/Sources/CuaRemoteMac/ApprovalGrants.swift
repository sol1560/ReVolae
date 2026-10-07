import CuaRemoteCore
import Foundation
import CuaRemoteProtocol

struct ApprovalGrantLedger {
    private struct Pending {
        let peerId: String
        let request: StepApprovalRequired
    }

    private struct Grant {
        let peerId: String
        let request: StepApprovalRequired
    }

    private var pending: [String: Pending] = [:]
    private var grants: [String: [Grant]] = [:]

    mutating func stage(_ request: StepApprovalRequired, from peerId: String, now: Int = Int(Date().timeIntervalSince1970)) throws {
        guard request.level == .l2,
              [.shell, .applescript, .shortcuts].contains(request.action.channel) else {
            throw ApprovalSigningError.malformedRequest
        }
        _ = try ApprovalSigning.validateRequest(request, now: now)
        let key = Self.key(runId: request.runId, stepId: request.stepId)
        guard pending[key] == nil else { throw ApprovalSigningError.foreignDecision }
        pending[key] = Pending(peerId: peerId, request: request)
    }

    mutating func authorize(
        _ decision: ApprovalDecision,
        from peerId: String,
        owner: TrustedPeer,
        now: Int = Int(Date().timeIntervalSince1970)
    ) throws -> Bool {
        let key = Self.key(runId: decision.runId, stepId: decision.stepId)
        guard let request = pending.removeValue(forKey: key) else {
            throw ApprovalSigningError.foreignDecision
        }
        guard request.peerId == peerId, owner.deviceId == peerId else {
            throw ApprovalSigningError.untrustedSigner
        }
        try ApprovalSigning.verifyDecision(decision, for: request.request, owner: owner, now: now)
        if decision.allow {
            grants[decision.runId, default: []].append(Grant(peerId: peerId, request: request.request))
        }
        return decision.allow
    }

    mutating func consumeGrant(
        for call: ToolsCall,
        runId: String,
        peerId: String,
        now: Int = Int(Date().timeIntervalSince1970)
    ) -> Bool {
        guard var runGrants = grants[runId] else { return false }
        runGrants.removeAll { $0.request.expiresAt <= now }
        guard let index = runGrants.firstIndex(where: {
            $0.peerId == peerId && Self.matches($0.request.action, call: call)
        }) else {
            grants[runId] = runGrants.isEmpty ? nil : runGrants
            return false
        }
        runGrants.remove(at: index)
        grants[runId] = runGrants.isEmpty ? nil : runGrants
        return true
    }

    mutating func clear(runId: String) {
        pending = pending.filter { $0.value.request.runId != runId }
        grants[runId] = nil
    }

    mutating func clear(runId: String, stepId: String) {
        let key = Self.key(runId: runId, stepId: stepId)
        pending[key] = nil
        guard var runGrants = grants[runId] else { return }
        runGrants.removeAll { $0.request.stepId == stepId }
        grants[runId] = runGrants.isEmpty ? nil : runGrants
    }

    mutating func clear(peerId: String) {
        pending = pending.filter { $0.value.peerId != peerId }
        grants = grants.mapValues { $0.filter { $0.peerId != peerId } }.filter { !$0.value.isEmpty }
    }

    mutating func clearAll() {
        pending.removeAll()
        grants.removeAll()
    }

    private static func key(runId: String, stepId: String) -> String {
        "\(runId)\n\(stepId)"
    }

    private static func matches(_ action: ConcreteAction, call: ToolsCall) -> Bool {
        switch call.tool {
        case "shell.run":
            guard action.channel == .shell,
                  case .string(let command) = call.args["cmd"],
                  case .string(let cwd) = call.args["cwd"],
                  !cwd.isEmpty,
                  action.detail == shellApprovalDetail(command: command, cwd: cwd),
                  action.targetPath == cwd,
                  action.targetApp == nil else { return false }
            return Set(call.args.keys).isSubset(of: ["cmd", "cwd"])
        case "applescript.run":
            guard action.channel == .applescript,
                  case .string(let script) = call.args["script"],
                  action.detail == script,
                  action.targetPath == nil else { return false }
            return Set(call.args.keys).isSubset(of: ["script"])
        case "shortcuts.run":
            guard action.channel == .shortcuts,
                  case .string(let name) = call.args["name"],
                  action.detail == "shortcuts run \(name)",
                  action.targetPath == nil,
                  action.targetApp == nil else { return false }
            return Set(call.args.keys).isSubset(of: ["name"])
        default:
            return false
        }
    }

}
