import CuaRemoteCore
import Foundation
import CuaRemoteProtocol

final class RunCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var children: [ObjectIdentifier: ProcessGroupChild] = [:]

    func attach(_ child: ProcessGroupChild) {
        lock.lock()
        let alreadyCancelled = cancelled
        if !alreadyCancelled { children[ObjectIdentifier(child)] = child }
        lock.unlock()
        if alreadyCancelled { child.terminate() }
    }

    func detach(_ child: ProcessGroupChild) {
        lock.lock()
        children[ObjectIdentifier(child)] = nil
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let active = Array(children.values)
        children.removeAll()
        lock.unlock()
        active.forEach { $0.terminate() }
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

final class WorkspaceToolExecutor: @unchecked Sendable {
    let workspaceURL: URL

    init(workspaceURL: URL) {
        self.workspaceURL = workspaceURL.resolvingSymlinksInPath().standardizedFileURL
    }

    var descriptors: [ToolDescriptor] {
        [
            descriptor("fs.read", "Read a bounded UTF-8 file inside the selected workspace.", .fs, .l0,
                      properties: ["path": stringSchema, "maxBytes": integerSchema], required: ["path"]),
            descriptor("fs.list", "List a bounded directory tree inside the selected workspace.", .fs, .l0,
                      properties: ["path": stringSchema, "depth": integerSchema], required: ["path"]),
            descriptor("shell.run", "Execute an approved shell command with the signed command and workspace path.", .shell, .l2,
                      properties: ["cmd": stringSchema, "cwd": stringSchema], required: ["cmd"]),
            descriptor("applescript.run", "Execute an approved AppleScript using the user's macOS Automation permissions.", .applescript, .l2,
                      properties: ["script": stringSchema], required: ["script"]),
            descriptor("shortcuts.run", "Run an approved existing macOS Shortcut by its literal name.", .shortcuts, .l2,
                      properties: ["name": stringSchema], required: ["name"]),
        ]
    }

    var scope: Scope {
        Scope(allowedDirs: [workspaceURL.path], allowedApps: [], deniedCommands: [])
    }

    func execute(_ call: ToolsCall, cancellation: RunCancellation) async -> ToolsResult {
        let started = Date()
        do {
            if cancellation.isCancelled { throw ToolExecutionError.cancelled }
            let output: String
            switch call.tool {
            case "fs.read":
                output = try readFile(call.args, cancellation: cancellation)
            case "fs.list":
                output = try listDirectory(call.args, cancellation: cancellation)
            case "shell.run":
                let cmd = try requiredString("cmd", in: call.args)
                try onlyKeys(["cmd", "cwd"], in: call.args)
                let cwd = try requestedDirectory(call.args["cwd"])
                let run = try await run(
                    executable: "/bin/sh",
                    arguments: ["-c", cmd],
                    cwd: cwd,
                    timeoutMs: call.timeoutMs ?? 60_000,
                    cancellation: cancellation
                )
                output = run
            case "applescript.run":
                let script = try requiredString("script", in: call.args)
                try onlyKeys(["script"], in: call.args)
                output = try await run(
                    executable: "/usr/bin/osascript",
                    arguments: ["-e", script],
                    cwd: workspaceURL,
                    timeoutMs: call.timeoutMs ?? 60_000,
                    cancellation: cancellation
                )
            case "shortcuts.run":
                let name = try requiredString("name", in: call.args)
                try onlyKeys(["name"], in: call.args)
                guard !name.isEmpty, !name.utf8.contains(0) else { throw ToolExecutionError.invalidArguments }
                output = try await run(
                    executable: "/usr/bin/shortcuts",
                    arguments: ["run", name],
                    cwd: workspaceURL,
                    timeoutMs: call.timeoutMs ?? 60_000,
                    cancellation: cancellation
                )
            default:
                throw ToolExecutionError.unsupportedTool
            }
            return ToolsResult(id: call.id, callId: call.callId, ok: true, output: output, ms: Date().timeIntervalSince(started) * 1_000)
        } catch {
            return ToolsResult(
                id: call.id,
                callId: call.callId,
                ok: false,
                error: errorMessage(error),
                ms: Date().timeIntervalSince(started) * 1_000
            )
        }
    }

    func canonicalWorkspacePath(_ path: String) throws -> URL {
        guard !path.isEmpty, !path.utf8.contains(0) else { throw ToolExecutionError.invalidPath }
        let candidate = URL(fileURLWithPath: path, relativeTo: workspaceURL).standardizedFileURL.resolvingSymlinksInPath()
        let canonical = candidate.standardizedFileURL
        let root = workspaceURL.path
        guard canonical.path == root || canonical.path.hasPrefix(root + "/") else {
            throw ToolExecutionError.pathOutsideWorkspace
        }
        return canonical
    }

    private func readFile(_ args: [String: JSONValue], cancellation: RunCancellation) throws -> String {
        try checkCancellation(cancellation)
        try onlyKeys(["path", "maxBytes"], in: args)
        let path = try requiredString("path", in: args)
        let maxBytes = try optionalInteger("maxBytes", in: args) ?? 16_384
        guard (1...65_536).contains(maxBytes) else { throw ToolExecutionError.invalidArguments }
        let url = try canonicalWorkspacePath(path)
        try checkCancellation(cancellation)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw ToolExecutionError.notAFile
        }
        try checkCancellation(cancellation)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maxBytes) ?? Data()
        try checkCancellation(cancellation)
        guard let text = String(data: data, encoding: .utf8) else { throw ToolExecutionError.notUTF8 }
        return text
    }

    private func listDirectory(_ args: [String: JSONValue], cancellation: RunCancellation) throws -> String {
        try checkCancellation(cancellation)
        try onlyKeys(["path", "depth"], in: args)
        let path = try requiredString("path", in: args)
        let depth = try optionalInteger("depth", in: args) ?? 1
        guard (1...3).contains(depth) else { throw ToolExecutionError.invalidArguments }
        let root = try canonicalWorkspacePath(path)
        try checkCancellation(cancellation)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ToolExecutionError.notADirectory
        }

        var entries: [String] = []
        try appendEntries(at: root, relativeTo: root, remainingDepth: depth, entries: &entries, cancellation: cancellation)
        return entries.joined(separator: "\n")
    }

    private func appendEntries(
        at directory: URL,
        relativeTo root: URL,
        remainingDepth: Int,
        entries: inout [String],
        cancellation: RunCancellation
    ) throws {
        try checkCancellation(cancellation)
        guard entries.count < 500 else { return }
        let children = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles]
        ).sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }

        for child in children {
            try checkCancellation(cancellation)
            guard entries.count < 500 else { break }
            let canonical = child.resolvingSymlinksInPath().standardizedFileURL
            guard canonical.path == workspaceURL.path || canonical.path.hasPrefix(workspaceURL.path + "/") else { continue }
            let values = try child.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .isSymbolicLinkKey])
            let relative = String(canonical.path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let kind = values.isDirectory == true ? "dir" : "file"
            let size = values.fileSize ?? 0
            entries.append("\(relative)\t\(kind)\t\(size)")
            if values.isDirectory == true, values.isSymbolicLink != true, remainingDepth > 1 {
                try appendEntries(
                    at: canonical,
                    relativeTo: root,
                    remainingDepth: remainingDepth - 1,
                    entries: &entries,
                    cancellation: cancellation
                )
            }
        }
    }

    private func checkCancellation(_ cancellation: RunCancellation) throws {
        if cancellation.isCancelled { throw ToolExecutionError.cancelled }
    }

    private func requestedDirectory(_ value: JSONValue?) throws -> URL {
        guard let value else { return workspaceURL }
        guard case .string(let path) = value else { throw ToolExecutionError.invalidArguments }
        return try canonicalWorkspacePath(path)
    }

    private func run(
        executable: String,
        arguments: [String],
        cwd: URL,
        timeoutMs: Int,
        cancellation: RunCancellation
    ) async throws -> String {
        guard (1...120_000).contains(timeoutMs),
              !executable.utf8.contains(0),
              arguments.allSatisfy({ !$0.utf8.contains(0) }) else {
            throw ToolExecutionError.invalidArguments
        }
        if cancellation.isCancelled { throw ToolExecutionError.cancelled }

        let child = try ProcessGroupChild.spawn(
            executable: executable,
            arguments: arguments,
            workingDirectory: cwd,
            environment: toolEnvironment()
        )
        child.closeInput()
        cancellation.attach(child)
        let captured = BoundedOutput(limit: 1_048_576)
        let timedOut = LockedFlag()
        let timeout = Task.detached {
            try? await Task.sleep(for: .milliseconds(timeoutMs))
            if !Task.isCancelled {
                timedOut.set()
                child.terminate()
            }
        }

        let status = await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            child.installHandlers(
                onStdout: { data in
                    if !captured.append(data) { child.terminate() }
                },
                onExit: { status in continuation.resume(returning: status) }
            )
        }
        timeout.cancel()
        cancellation.detach(child)
        if cancellation.isCancelled { throw ToolExecutionError.cancelled }
        if captured.exceeded { throw ToolExecutionError.outputLimit }
        if timedOut.value { throw ToolExecutionError.timedOut }
        let stdout = captured.string
        let stderr = String(data: child.stderrSnapshot(), encoding: .utf8) ?? ""
        guard processExitedNormally(status), processExitCode(status) == 0 else {
            throw ToolExecutionError.commandFailed((stdout + stderr).prefix(65_536).description)
        }
        return String((stdout + stderr).prefix(1_048_576))
    }

    private func descriptor(
        _ name: String,
        _ description: String,
        _ channel: Channel,
        _ level: Level,
        properties: [String: JSONValue],
        required: [String]
    ) -> ToolDescriptor {
        ToolDescriptor(
            name: name,
            description: description,
            channel: channel,
            staticLevel: level,
            costClass: level == .l2 ? .l2 : .l0,
            dataLeavesDevice: true,
            inputSchema: [
                "type": .string("object"),
                "properties": .object(properties),
                "required": .array(required.map(JSONValue.string)),
            ]
        )
    }

    private var stringSchema: JSONValue { .object(["type": .string("string")]) }
    private var integerSchema: JSONValue { .object(["type": .string("integer")]) }

    private func requiredString(_ key: String, in args: [String: JSONValue]) throws -> String {
        guard case .string(let value) = args[key] else { throw ToolExecutionError.invalidArguments }
        return value
    }

    private func optionalInteger(_ key: String, in args: [String: JSONValue]) throws -> Int? {
        guard let value = args[key] else { return nil }
        guard case .number(let number) = value, let integer = Int(exactly: number) else {
            throw ToolExecutionError.invalidArguments
        }
        return integer
    }

    private func toolEnvironment() -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var environment: [String: String] = [:]
        for key in ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL"] {
            if let value = inherited[key] { environment[key] = value }
        }
        return environment
    }

    private func onlyKeys(_ allowed: Set<String>, in args: [String: JSONValue]) throws {
        guard Set(args.keys).isSubset(of: allowed) else { throw ToolExecutionError.invalidArguments }
    }

    private func onlyKeys(_ allowed: [String], in args: [String: JSONValue]) throws {
        try onlyKeys(Set(allowed), in: args)
    }

    private func errorMessage(_ error: Error) -> String {
        switch error {
        case ToolExecutionError.invalidArguments: "unsupported or malformed tool arguments"
        case ToolExecutionError.invalidPath: "invalid filesystem path"
        case ToolExecutionError.pathOutsideWorkspace: "path is outside the selected workspace"
        case ToolExecutionError.notAFile: "path is not a readable file"
        case ToolExecutionError.notADirectory: "path is not a directory"
        case ToolExecutionError.notUTF8: "file is not valid UTF-8"
        case ToolExecutionError.unsupportedTool: "tool is not supported"
        case ToolExecutionError.cancelled: "execution cancelled"
        case ToolExecutionError.timedOut: "execution timed out"
        case ToolExecutionError.outputLimit: "tool output exceeded the limit"
        case ToolExecutionError.commandFailed(let output): output
        default: "tool execution failed"
        }
    }
}

private final class BoundedOutput: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var data = Data()
    private var overflowed = false

    init(limit: Int) { self.limit = limit }

    func append(_ newData: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let remaining = max(0, limit - data.count)
        let amount = min(remaining, newData.count)
        data.append(newData.prefix(amount))
        if amount < newData.count { overflowed = true }
        return !overflowed
    }

    var exceeded: Bool {
        lock.lock()
        defer { lock.unlock() }
        return overflowed
    }

    var string: String {
        lock.lock()
        defer { lock.unlock() }
        return String(data: data, encoding: .utf8) ?? "tool output was not valid UTF-8"
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }

    func set() {
        lock.lock()
        flag = true
        lock.unlock()
    }
}

enum ToolExecutionError: Error {
    case invalidArguments
    case invalidPath
    case pathOutsideWorkspace
    case notAFile
    case notADirectory
    case notUTF8
    case unsupportedTool
    case cancelled
    case timedOut
    case outputLimit
    case commandFailed(String)
}
