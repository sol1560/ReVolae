import CryptoKit
import CuaRemoteProtocol
import Foundation

/// 历史只在本机保存；不含连接凭据、运行会话或可恢复的批准状态。
final class HistoryStore {
    struct Scope: Codable, Equatable {
        let relay: String
        let sourceID: String
        let phoneID: String
        let privateAddress: Bool

        init(url: URL, phoneID: String) throws {
            guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  ["ws", "wss"].contains(parts.scheme?.lowercased() ?? ""), parts.host != nil else {
                throw StoreError.source
            }
            parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased()
            if parts.port == (parts.scheme == "wss" ? 443 : 80) { parts.port = nil }
            if parts.path.isEmpty { parts.path = "/" }
            guard let address = parts.string, !phoneID.isEmpty else { throw StoreError.source }
            sourceID = SHA256.hash(data: Data(address.utf8)).map { String(format: "%02x", $0) }.joined()
            privateAddress = parts.user != nil || parts.password != nil || parts.query != nil || parts.fragment != nil
            parts.user = nil; parts.password = nil; parts.query = nil; parts.fragment = nil
            guard let relay = parts.string else { throw StoreError.source }
            self.relay = relay; self.phoneID = phoneID
        }
    }

    struct Archive: Codable {
        var version = 1
        let scope: Scope
        var device: DevicesPageDevicesItem
        var items: [HistoryItem]
        var listReceivedAt: Date?
        var nextCursor: String?
        var details: [String: HistoryDetail]
        var detailReceivedAt: [String: Date]
    }

    enum StoreError: LocalizedError {
        case source, damaged, event
        var errorDescription: String? {
            switch self {
            case .source: "无法确定历史所属的中继和手机身份"
            case .damaged: "本地历史文件损坏或来源不符，未将其当作空历史；请保留原文件"
            case .event: "历史包含无法核验的事件，未保存到本机"
            }
        }
    }

    let directory: URL
    init(directory: URL? = nil) throws {
        self.directory = try directory ?? FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("History-v1", isDirectory: true)
        try prepare(self.directory)
    }

    private func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func phoneDirectory(_ phone: String) -> URL { directory.appendingPathComponent(hash(phone), isDirectory: true) }
    private func scopeDirectory(_ scope: Scope) -> URL { phoneDirectory(scope.phoneID).appendingPathComponent(scope.sourceID, isDirectory: true) }
    func fileURL(scope: Scope, deviceID: String) -> URL { scopeDirectory(scope).appendingPathComponent(hash(deviceID) + ".json") }

    private func prepare(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        var resource = URLResourceValues(); resource.isExcludedFromBackup = true
        var path = url; try path.setResourceValues(resource)
    }
    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        try prepare(url.deletingLastPathComponent())
        try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func read<T: Decodable>(_ type: T.Type, at url: URL) throws -> T? {
        let bytes: Data
        do { bytes = try Data(contentsOf: url) }
        catch CocoaError.fileReadNoSuchFile { return nil }
        do { return try JSONDecoder().decode(type, from: bytes) }
        catch { throw StoreError.damaged }
    }

    func lastScope(phoneID: String) throws -> Scope? {
        let scope = try read(Scope.self, at: phoneDirectory(phoneID).appendingPathComponent("active.json"))
        if let scope {
            guard scope.phoneID == phoneID, let url = URL(string: scope.relay),
                  scope.sourceID.count == 64, scope.sourceID.allSatisfy({ $0.isHexDigit }),
                  try Scope(url: url, phoneID: phoneID).relay == scope.relay else { throw StoreError.damaged }
        }
        return scope
    }
    func remember(_ scope: Scope) throws {
        try write(scope, to: phoneDirectory(scope.phoneID).appendingPathComponent("active.json"))
    }
    func load(scope: Scope, deviceID: String) throws -> Archive? {
        guard let archive = try read(Archive.self, at: fileURL(scope: scope, deviceID: deviceID)) else { return nil }
        guard archive.version == 1, archive.scope == scope, archive.device.deviceId == deviceID,
              archive.device.role == .device,
              archive.items.allSatisfy({ $0.deviceId == deviceID }),
              archive.details.allSatisfy({ $0.key == $0.value.item.runId && $0.value.item.deviceId == deviceID }) else { throw StoreError.damaged }
        for detail in archive.details.values { _ = try Self.validatedDetail(detail) }
        return archive
    }
    func restore(_ scope: Scope) throws -> [Archive] {
        let folder = scopeDirectory(scope)
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.map { url in
                guard let decoded = try read(Archive.self, at: url),
                      fileURL(scope: scope, deviceID: decoded.device.deviceId) == url,
                      let archive = try load(scope: scope, deviceID: decoded.device.deviceId) else { throw StoreError.damaged }
                return archive
            }.sorted { $0.device.deviceId < $1.device.deviceId }
    }
    func save(_ archive: Archive) throws {
        // 不用新收到的一页悄悄覆盖损坏文件，也保留已接收的更早记录和详情。
        let previous = try load(scope: archive.scope, deviceID: archive.device.deviceId)
        var value = archive
        value.device.online = false
        value.items = Self.merge(previous?.items ?? [], archive.items)
        value.details = (previous?.details ?? [:]).merging(archive.details) { _, new in new }
        for (run, detail) in value.details { value.details[run] = try Self.validatedDetail(detail) }
        value.detailReceivedAt = (previous?.detailReceivedAt ?? [:]).merging(archive.detailReceivedAt) { _, new in new }
        try write(value, to: fileURL(scope: archive.scope, deviceID: archive.device.deviceId))
    }
    func remove(scope: Scope, deviceID: String) throws {
        let file = fileURL(scope: scope, deviceID: deviceID)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
    func retain(scope: Scope, deviceIDs: Set<String>) throws {
        let folder = scopeDirectory(scope)
        guard FileManager.default.fileExists(atPath: folder.path) else { return }
        let allowed = Set(deviceIDs.map { fileURL(scope: scope, deviceID: $0).lastPathComponent })
        for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            where file.pathExtension == "json" && !allowed.contains(file.lastPathComponent) {
            try FileManager.default.removeItem(at: file)
        }
    }
    static func merge(_ old: [HistoryItem], _ incoming: [HistoryItem]) -> [HistoryItem] {
        var rows: [String: HistoryItem] = [:]
        for item in old + incoming { rows[item.runId] = item }
        return rows.values.sorted { $0.startedAt == $1.startedAt ? $0.runId < $1.runId : $0.startedAt > $1.startedAt }
    }

    static func validatedDetail(_ detail: HistoryDetail) throws -> HistoryDetail {
        var value = detail
        value.events = try detail.events.map { raw in
            let message = try JSONDecoder().decode(AnyMessage.self, from: JSONEncoder().encode(raw))
            let run: String
            switch message {
            case .runCreated(let event): run = event.runId
            case .planUpdated(let event): run = event.runId
            case .stepStarted(let event): run = event.runId
            case .stepPrecheck(let event): run = event.runId
            case .stepApprovalRequired(let event): run = event.runId
            case .stepFinished(let event): run = event.runId
            case .runFinished(let event): run = event.runId
            case .terminalSuggestion(let event): run = event.runId
            default: throw StoreError.event
            }
            guard run == detail.item.runId else { throw StoreError.event }
            // 按已知历史类型重新编码，不将认证消息或未定义的凭据字段原样落盘。
            return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(message))
        }
        return value
    }
}

extension PhoneModel {
    func restoreHistory(_ scope: HistoryStore.Scope) {
        historyScope = scope; historyCacheError = nil
        deviceData.removeAll(); devices = []; selectedDevice = ""
        do {
            for archive in try historyStore?.restore(scope) ?? [] {
                var device = archive.device; device.online = false
                devices.append(device)
                let state = data(for: device.deviceId)
                state.history = archive.items; state.historyCursor = archive.nextCursor
                state.historyDetails = archive.details; state.historyCachedAt = archive.listReceivedAt
                state.historyDetailCachedAt = archive.detailReceivedAt
            }
            selectedDevice = devices.first?.deviceId ?? ""
        } catch { historyCacheError = error.localizedDescription }
    }

    func saveHistory(_ deviceID: String, listReceived: Date? = nil, detail: (String, Date)? = nil) {
        guard let scope = historyScope, let store = historyStore, let state = deviceData[deviceID],
              let device = devices.first(where: { $0.deviceId == deviceID }) else { return }
        var detailDates = state.historyDetailCachedAt
        if let detail { detailDates[detail.0] = detail.1 }
        let archive = HistoryStore.Archive(scope: scope, device: device, items: state.history ?? [],
            listReceivedAt: listReceived ?? state.historyCachedAt, nextCursor: state.historyCursor,
            details: state.historyDetails, detailReceivedAt: detailDates)
        do {
            try store.save(archive)
            state.historyCachedAt = archive.listReceivedAt; state.historyDetailCachedAt = detailDates
            state.historyStorageError = nil
        } catch { state.historyStorageError = "历史未保存到本机：" + error.localizedDescription }
    }
}
