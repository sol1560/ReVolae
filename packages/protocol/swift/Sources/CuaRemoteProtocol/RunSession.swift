import Foundation

/// 只跟踪此手机当前提交的请求。历史详情不能经此状态机恢复可执行审批。
public struct RunSession: Sendable {
    public private(set) var deviceID = ""
    public private(set) var requestID: String?
    public private(set) var runID: String?
    public private(set) var running = false
    private var finished = false
    public enum Cancellation: Equatable, Sendable {
        case waiting, received, problem(String)
    }
    public private(set) var cancellationID: String?
    public private(set) var cancellation: Cancellation?
    public var cancellationPending: Bool { cancellation == .waiting || cancellation == .received }
    public var canCancel: Bool { running && runID != nil && !cancellationPending }
    // 即使发送失败或超时，也不再允许对同一次审批签名，避免与可能在途的取消相竞。
    public var approvalBlocked: Bool { cancellationID != nil }

    public init() {}

    public mutating func begin(deviceID: String, requestID: String) {
        self.deviceID = deviceID; self.requestID = requestID
        runID = nil; running = true; finished = false
        cancellationID = nil; cancellation = nil
    }

    public mutating func requestCancellation(id: String) -> RunCancel? {
        guard canCancel, let runID else { return nil }
        cancellationID = id; cancellation = .waiting
        return RunCancel(id: id, runId: runID)
    }

    @discardableResult
    public mutating func acknowledgeCancellation(ref: String, peer: String) -> Bool {
        guard running, peer == deviceID, ref == cancellationID, cancellation == .waiting else { return false }
        cancellation = .received
        return true
    }

    @discardableResult
    public mutating func cancellationFailed(ref: String?, peer: String, message: String) -> Bool {
        guard running, peer == deviceID, ref == cancellationID, cancellationPending else { return false }
        cancellation = .problem(message)
        return true
    }

    public mutating func created(_ message: RunCreated, peer: String) -> Bool {
        guard running, runID == nil, peer == deviceID, message.deviceId == deviceID,
              let requestID, message.requestId == requestID else { return false }
        runID = message.runId
        return true
    }

    public func acceptsStep(runID: String, peer: String) -> Bool {
        running && !finished && peer == deviceID && self.runID == runID
    }

    public mutating func complete(_ message: RunFinished, peer: String) -> Bool {
        guard !finished, peer == deviceID, let requestID, message.requestId == requestID,
              runID == nil || runID == message.runId else { return false }
        runID = message.runId; running = false; finished = true
        cancellationID = nil; cancellation = nil
        return true
    }

    public mutating func failed(ref: String?, peer: String) -> Bool {
        guard !finished, peer == deviceID, let requestID, ref == requestID else { return false }
        // 运行中可能有可恢复错误；收到正式完成事件前不允许重复发起任务。
        if runID == nil { running = false }
        return true
    }

    public mutating func disconnect() {
        if cancellationPending { cancellation = .problem("连接已断开，取消结果未确认；重新连接后请查看设备历史，不会自动重发。") }
        running = false; requestID = nil
    }
}
