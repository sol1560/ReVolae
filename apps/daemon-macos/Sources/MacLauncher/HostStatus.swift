import Foundation

/// PID 只能说明进程存在，不能证明设备已向中继完成认证。
public struct HostStatus: Codable, Sendable {
    public enum Connection: String, Codable, Sendable { case connecting, authenticated, disconnected }
    public let connection: Connection
    public let updatedAt: Double
    public let activeRunId: String?
    public let reconnectable: Bool?

    public static func read(from directory: URL, processRunning: Bool, startedAt: Date) -> HostStatus? {
        guard let data = try? Data(contentsOf: directory.appending(path: "status.json")),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              processRunning || value.connection == .disconnected,
              value.updatedAt >= startedAt.timeIntervalSince1970 * 1000 else { return nil }
        return value
    }
}
