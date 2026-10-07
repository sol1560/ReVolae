import Darwin
import CuaRemoteProtocol
import Foundation

public enum MacRunStatus: String, Codable, Sendable {
    case starting
    case running
    case completed
    case failed
    case cancelled
    case interrupted
}

public struct MacRunRecord: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var brainRunId: String?
    public var submitId: String
    public var ownerPeerId: String
    public var deviceId: String
    public var intent: String
    public var provider: String
    public var createdAt: Int
    public var finishedAt: Int?
    public var status: MacRunStatus
    public var summary: String?

    public init(
        id: String,
        brainRunId: String? = nil,
        submitId: String,
        ownerPeerId: String,
        deviceId: String,
        intent: String,
        provider: String,
        createdAt: Int,
        finishedAt: Int? = nil,
        status: MacRunStatus,
        summary: String? = nil
    ) {
        self.id = id
        self.brainRunId = brainRunId
        self.submitId = submitId
        self.ownerPeerId = ownerPeerId
        self.deviceId = deviceId
        self.intent = intent
        self.provider = provider
        self.createdAt = createdAt
        self.finishedAt = finishedAt
        self.status = status
        self.summary = summary
    }

    var isActive: Bool { status == .starting || status == .running }

    func historyItem() -> HistoryItem {
        HistoryItem(
            runId: brainRunId ?? id,
            deviceId: deviceId,
            intent: intent,
            startedAt: createdAt,
            finishedAt: finishedAt,
            ok: status == .completed ? true : (status == .failed || status == .cancelled || status == .interrupted ? false : nil),
            summary: summary ?? (status == .running || status == .starting ? "running" : nil)
        )
    }
}

struct RunJournal {
    private struct Snapshot: Codable {
        var version: Int
        var records: [MacRunRecord]
    }

    let fileURL: URL
    private var records: [MacRunRecord]

    init(fileURL: URL? = nil) throws {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let support = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            self.fileURL = support.appendingPathComponent("CuaRemoteMac", isDirectory: true).appendingPathComponent("runs.json")
        }

        let directory = self.fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        if FileManager.default.fileExists(atPath: self.fileURL.path) {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.fileURL.path)
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: self.fileURL))
            guard snapshot.version == 1 else { throw JournalError.unsupportedVersion }
            records = snapshot.records
        } else {
            records = []
        }
    }

    func allRecords() -> [MacRunRecord] {
        records.sorted { $0.createdAt > $1.createdAt }
    }

    func record(submitId: String, ownerPeerId: String) -> MacRunRecord? {
        records.first { $0.submitId == submitId && $0.ownerPeerId == ownerPeerId }
    }

    mutating func insert(_ record: MacRunRecord) throws {
        records.append(record)
        try persist()
    }

    mutating func update(_ record: MacRunRecord) throws {
        guard let index = records.firstIndex(where: { $0.id == record.id }) else {
            throw JournalError.missingRecord
        }
        records[index] = record
        try persist()
    }

    mutating func interruptActiveRuns(now: Int) throws {
        var changed = false
        for index in records.indices where records[index].isActive {
            records[index].status = .interrupted
            records[index].finishedAt = now
            records[index].summary = "interrupted, effects may remain"
            changed = true
        }
        if changed { try persist() }
    }

    private func persist() throws {
        let data = try JSONEncoder().encode(Snapshot(version: 1, records: records))
        let directory = fileURL.deletingLastPathComponent()
        let temporaryURL = directory.appendingPathComponent(".runs-\(UUID().uuidString).tmp")
        let descriptor = open(temporaryURL.path, O_CREAT | O_EXCL | O_WRONLY, mode_t(0o600))
        guard descriptor >= 0 else { throw posixError() }
        var shouldRemoveTemporary = true
        defer {
            close(descriptor)
            if shouldRemoveTemporary { unlink(temporaryURL.path) }
        }

        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    throw posixError()
                }
                guard written > 0 else { throw posixError() }
                offset += written
            }
        }
        guard fsync(descriptor) == 0, fchmod(descriptor, mode_t(0o600)) == 0 else { throw posixError() }
        guard rename(temporaryURL.path, fileURL.path) == 0 else { throw posixError() }
        shouldRemoveTemporary = false
        let directoryDescriptor = open(directory.path, O_RDONLY)
        guard directoryDescriptor >= 0 else { throw posixError() }
        defer { close(directoryDescriptor) }
        guard fsync(directoryDescriptor) == 0 else { throw posixError() }
    }

    private func posixError() -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}

enum JournalError: Error {
    case unsupportedVersion
    case missingRecord
}
