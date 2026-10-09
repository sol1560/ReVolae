import Darwin
import Dispatch
import Foundation

final class ProcessGroupChild: @unchecked Sendable {
    private static let maximumWriteBytes = 1_048_576
    private static let maximumQueuedWriteBytes = 4_194_304
    private static let writePollTimeoutMilliseconds: Int32 = 100
    private static let writeTimeout: TimeInterval = 10
    private static let terminationGrace: TimeInterval = 1

    private let pid: pid_t
    private let stdinDescriptor: Int32
    private let stateLock = NSLock()
    private let stdinWriteQueue: DispatchQueue
    private let processQueue: DispatchQueue
    private var processExited = false
    private var stdoutEOF = false
    private var stderrEOF = false
    private var exitStatus: Int32?
    private var stderrBytes = 0
    private var stderrBuffer = Data()
    private var stdoutPending = Data()
    private var stdoutBytes = 0
    private var stdoutOverflowed = false
    private var stdinOpen = true
    private var stdinGeneration: UInt64 = 0
    private var queuedWriteBytes = 0
    private var terminationRequested = false
    private var escalationScheduled = false
    private var leaderReaped = false
    private var exitNotified = false
    private var stdoutHandler: (@Sendable (Data) -> Void)?
    private var exitHandler: (@Sendable (Int32) -> Void)?
    private let stdoutSource: DispatchSourceRead
    private let stderrSource: DispatchSourceRead
    private let processSource: DispatchSourceProcess

    private init(pid: pid_t, stdin: Int32, stdout: Int32, stderr: Int32) {
        self.pid = pid
        self.stdinDescriptor = stdin
        let queue = DispatchQueue(label: "CuaRemoteMac.process.\(pid)", qos: .userInitiated)
        processQueue = queue
        stdinWriteQueue = DispatchQueue(label: "CuaRemoteMac.stdin.\(pid)", qos: .userInitiated)
        stdoutSource = DispatchSource.makeReadSource(fileDescriptor: stdout, queue: queue)
        stderrSource = DispatchSource.makeReadSource(fileDescriptor: stderr, queue: queue)
        processSource = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)

        stdoutSource.setEventHandler { [weak self] in self?.drain(stdout, isStdout: true) }
        stderrSource.setEventHandler { [weak self] in self?.drain(stderr, isStdout: false) }
        stdoutSource.setCancelHandler { Darwin.close(stdout) }
        stderrSource.setCancelHandler { Darwin.close(stderr) }
        processSource.setEventHandler { [weak self] in self?.reap() }
        stdoutSource.resume()
        stderrSource.resume()
        processSource.resume()
    }

    static func spawn(
        executable: String,
        arguments: [String],
        workingDirectory: URL,
        environment: [String: String]
    ) throws -> ProcessGroupChild {
        _ = signal(SIGPIPE, SIG_IGN)
        var stdinPipe = [Int32](repeating: -1, count: 2)
        var stdoutPipe = [Int32](repeating: -1, count: 2)
        var stderrPipe = [Int32](repeating: -1, count: 2)
        guard pipe(&stdinPipe) == 0 else { throw Self.posixError(errno) }
        guard pipe(&stdoutPipe) == 0 else {
            stdinPipe.forEach { close($0) }
            throw Self.posixError(errno)
        }
        guard pipe(&stderrPipe) == 0 else {
            (stdinPipe + stdoutPipe).forEach { close($0) }
            throw Self.posixError(errno)
        }
        var shouldClosePipes = true
        defer {
            if shouldClosePipes {
                for descriptor in stdinPipe + stdoutPipe + stderrPipe where descriptor >= 0 {
                    close(descriptor)
                }
            }
        }
        for descriptor in stdinPipe + stdoutPipe + stderrPipe {
            let flags = fcntl(descriptor, F_GETFD)
            guard flags >= 0, fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) >= 0 else {
                throw Self.posixError(errno)
            }
        }
        for descriptor in [stdinPipe[1], stdoutPipe[0], stderrPipe[0]] {
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) >= 0 else {
                throw Self.posixError(errno)
            }
        }

        var actions: posix_spawn_file_actions_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw Self.posixError(errno) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawn_file_actions_adddup2(&actions, stdinPipe[0], STDIN_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, stdoutPipe[1], STDOUT_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&actions, stderrPipe[1], STDERR_FILENO) == 0 else {
            throw Self.posixError(errno)
        }
        for descriptor in [stdinPipe[0], stdinPipe[1], stdoutPipe[0], stdoutPipe[1], stderrPipe[0], stderrPipe[1]] {
            if descriptor != STDIN_FILENO && descriptor != STDOUT_FILENO && descriptor != STDERR_FILENO {
                guard posix_spawn_file_actions_addclose(&actions, descriptor) == 0 else { throw Self.posixError(errno) }
            }
        }

        var attributes: posix_spawnattr_t?
        guard posix_spawnattr_init(&attributes) == 0 else { throw Self.posixError(errno) }
        defer { posix_spawnattr_destroy(&attributes) }
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0 else {
            throw Self.posixError(errno)
        }

        let launcher = "/bin/sh"
        let launchScript = "cd \"$1\" || exit; shift; exec \"$@\""
        let launchArguments = ["-c", launchScript, "cuaremote-launch", workingDirectory.path, executable] + arguments
        let argvStrings = [launcher] + launchArguments
        let environmentStrings = environment.keys.sorted().map { "\($0)=\(environment[$0] ?? "")" }
        var argv = argvStrings.map { strdup($0) } + [nil]
        var envp = environmentStrings.map { strdup($0) } + [nil]
        defer {
            for pointer in argv where pointer != nil { free(pointer) }
            for pointer in envp where pointer != nil { free(pointer) }
        }

        var child: pid_t = 0
        let spawnResult = argv.withUnsafeMutableBufferPointer { argvBuffer in
            envp.withUnsafeMutableBufferPointer { envBuffer in
                posix_spawn(&child, launcher, &actions, &attributes, argvBuffer.baseAddress, envBuffer.baseAddress)
            }
        }
        guard spawnResult == 0 else {
            errno = spawnResult
            throw Self.posixError(errno)
        }

        close(stdinPipe[0])
        close(stdoutPipe[1])
        close(stderrPipe[1])
        shouldClosePipes = false
        return ProcessGroupChild(pid: child, stdin: stdinPipe[1], stdout: stdoutPipe[0], stderr: stderrPipe[0])
    }

    func write(_ data: Data) async throws {
        guard data.count <= Self.maximumWriteBytes else { throw ProcessGroupError.messageTooLarge }
        try Task.checkCancellation()

        let generation = try reserveWrite(data.count)

        let operation = ChildWriteOperation(data: data)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                operation.install(continuation)
                stdinWriteQueue.async { [weak self] in
                    guard let self else {
                        operation.finish(.failure(ProcessGroupError.closedPipe))
                        return
                    }
                    defer { self.releaseQueuedWriteBytes(data.count) }
                    do {
                        try self.performWrite(operation, generation: generation)
                        operation.finish(.success(()))
                    } catch {
                        operation.finish(.failure(error))
                    }
                }
            }
        } onCancel: {
            operation.cancel()
        }
    }

    func installHandlers(
        onStdout: @escaping @Sendable (Data) -> Void,
        onExit: @escaping @Sendable (Int32) -> Void
    ) {
        stateLock.lock()
        stdoutHandler = onStdout
        exitHandler = onExit
        let pending = stdoutPending
        stdoutPending.removeAll()
        let ready = processExited && stdoutEOF && stderrEOF && !exitNotified
        if ready { exitNotified = true }
        let status = exitStatus
        stateLock.unlock()
        if !pending.isEmpty { onStdout(pending) }
        if ready, let status { onExit(status) }
    }

    func closeInput() {
        _ = closeStdin()
    }

    func terminate() {
        stateLock.lock()
        guard !terminationRequested else {
            stateLock.unlock()
            return
        }
        terminationRequested = true
        guard !leaderReaped else {
            stateLock.unlock()
            closeInput()
            return
        }
        escalationScheduled = true
        stateLock.unlock()
        _ = Darwin.kill(-pid, SIGTERM)
        closeInput()
        processQueue.asyncAfter(deadline: .now() + Self.terminationGrace) { self.escalateTermination() }
    }

    private func escalateTermination() {
        stateLock.lock()
        let groupStillPinned = !leaderReaped
        escalationScheduled = false
        stateLock.unlock()
        if groupStillPinned {
            _ = Darwin.kill(-pid, SIGKILL)
        }
        reap(force: true)
    }

    func stderrSnapshot() -> Data {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stderrBuffer
    }

    var leaderHasExited: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return processExited
    }

    private func closeStdin() -> Int32 {
        stateLock.lock()
        guard stdinOpen else {
            stateLock.unlock()
            return 0
        }
        stdinOpen = false
        stdinGeneration &+= 1
        let result = Darwin.close(stdinDescriptor)
        stateLock.unlock()
        return result
    }

    private func performWrite(_ operation: ChildWriteOperation, generation: UInt64) throws {
        let deadline = Date().addingTimeInterval(Self.writeTimeout)
        var offset = 0
        try operation.data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            while offset < bytes.count {
                if operation.isCancelled { throw CancellationError() }
                guard Date() < deadline else { throw ProcessGroupError.writeTimedOut }
                guard inputIsOpen(generation: generation) else { throw ProcessGroupError.closedPipe }

                var descriptor = pollfd(fd: stdinDescriptor, events: Int16(POLLOUT), revents: 0)
                let ready = Darwin.poll(&descriptor, 1, Self.writePollTimeoutMilliseconds)
                if ready < 0 {
                    let code = errno
                    if code == EINTR { continue }
                    throw Self.posixError(code)
                }
                if ready == 0 { continue }
                if descriptor.revents & Int16(POLLERR | POLLHUP | POLLNVAL) != 0 {
                    throw ProcessGroupError.closedPipe
                }

                stateLock.lock()
                guard stdinOpen, stdinGeneration == generation, !processExited else {
                    stateLock.unlock()
                    throw ProcessGroupError.closedPipe
                }
                let written = Darwin.write(stdinDescriptor, base.advanced(by: offset), bytes.count - offset)
                let code = errno
                stateLock.unlock()
                if written < 0 {
                    if code == EINTR || code == EAGAIN || code == EWOULDBLOCK { continue }
                    throw Self.posixError(code)
                }
                guard written > 0 else { throw ProcessGroupError.closedPipe }
                offset += written
            }
        }
    }

    private func inputIsOpen(generation: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stdinOpen && stdinGeneration == generation && !processExited
    }

    private func releaseQueuedWriteBytes(_ count: Int) {
        stateLock.lock()
        queuedWriteBytes -= count
        stateLock.unlock()
    }

    private func reserveWrite(_ count: Int) throws -> UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard stdinOpen, !processExited else { throw ProcessGroupError.closedPipe }
        guard count <= Self.maximumQueuedWriteBytes - queuedWriteBytes else {
            throw ProcessGroupError.writeQueueFull
        }
        queuedWriteBytes += count
        return stdinGeneration
    }

    private func drain(_ descriptor: Int32, isStdout: Bool) {
        var ended = false
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count > 0 {
                if isStdout {
                    stateLock.lock()
                    let remaining = max(0, 8_388_608 - stdoutBytes)
                    let captured = min(remaining, count)
                    if captured > 0 { result.append(contentsOf: buffer[0..<captured]) }
                    stdoutBytes += captured
                    if captured < count, !stdoutOverflowed {
                        stdoutOverflowed = true
                        result.append(Data(repeating: 0, count: 1_048_577))
                    }
                    stateLock.unlock()
                } else {
                    stateLock.lock()
                    let remaining = max(0, 65_536 - stderrBytes)
                    let captured = min(remaining, count)
                    if captured > 0 { stderrBuffer.append(contentsOf: buffer[0..<captured]) }
                    stderrBytes += captured
                    stateLock.unlock()
                }
                continue
            }
            if count == 0 {
                ended = true
                break
            }
            if errno == EINTR { continue }
            break
        }
        var stdoutCallback: (@Sendable (Data) -> Void)?
        if isStdout, !result.isEmpty {
            stateLock.lock()
            stdoutCallback = stdoutHandler
            if stdoutCallback == nil {
                let remaining = max(0, 1_048_577 - stdoutPending.count)
                stdoutPending.append(contentsOf: result.prefix(remaining))
                if result.count > remaining {
                    stdoutPending.append(Data(repeating: 0, count: 1_048_577))
                }
            }
            stateLock.unlock()
            stdoutCallback?(result)
        }
        if ended {
            if isStdout {
                stateLock.lock()
                stdoutEOF = true
                stateLock.unlock()
                stdoutSource.cancel()
            } else {
                stateLock.lock()
                stderrEOF = true
                stateLock.unlock()
                stderrSource.cancel()
            }
            finishIfReady()
            reapIfDrained()
        }
    }

    private func reap(force: Bool = false) {
        stateLock.lock()
        guard !leaderReaped else {
            stateLock.unlock()
            return
        }
        let drained = stdoutEOF && stderrEOF
        let deferReap = !force && (escalationScheduled || !drained)
        if deferReap {
            var info = siginfo_t()
            let result = waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT)
            if result == 0, info.si_pid != 0 {
                processExited = true
                closeInputAfterLeaderExit()
                stateLock.unlock()
                return
            }
            let code = errno
            if result < 0, code == ECHILD {
                leaderReaped = true
                processExited = true
                exitStatus = code
                closeInputAfterLeaderExit()
                stateLock.unlock()
                processSource.cancel()
                finishIfReady()
                return
            }
            stateLock.unlock()
            scheduleReap(force: force)
            return
        }

        var status: Int32 = 0
        let result = waitpid(pid, &status, WNOHANG)
        if result == 0 || (result < 0 && errno == EINTR) {
            stateLock.unlock()
            scheduleReap(force: force)
            return
        }
        let waitError = result < 0 ? errno : 0
        if result < 0 { status = Int32(waitError) }
        leaderReaped = true
        processExited = true
        exitStatus = status
        closeInputAfterLeaderExit()
        stateLock.unlock()
        processSource.cancel()
        finishIfReady()
    }

    private func scheduleReap(force: Bool) {
        processQueue.asyncAfter(deadline: .now() + .milliseconds(10)) { self.reap(force: force) }
    }

    private func closeInputAfterLeaderExit() {
        guard stdinOpen else { return }
        stdinOpen = false
        stdinGeneration &+= 1
        _ = Darwin.close(stdinDescriptor)
    }

    private func reapIfDrained() {
        stateLock.lock()
        let ready = processExited && stdoutEOF && stderrEOF && !leaderReaped
        stateLock.unlock()
        if ready { reap() }
    }

    private func finishIfReady() {
        stateLock.lock()
        let ready = leaderReaped && stdoutEOF && stderrEOF
        let shouldNotify = ready && !exitNotified && exitHandler != nil
        if shouldNotify { exitNotified = true }
        let status = shouldNotify ? exitStatus : nil
        let callback = exitHandler
        stateLock.unlock()
        if let status { callback?(status) }
    }

    private static func posixError(_ code: Int32) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }

    deinit {
        closeInput()
        stdoutSource.cancel()
        stderrSource.cancel()
        processSource.cancel()
        if !leaderReaped {
            var status: Int32 = 0
            _ = waitpid(pid, &status, WNOHANG)
        }
    }
}

enum ProcessGroupError: Error {
    case messageTooLarge
    case writeQueueFull
    case writeTimedOut
    case closedPipe
}

private final class ChildWriteOperation: @unchecked Sendable {
    let data: Data

    private let lock = NSLock()
    private var cancellationRequested = false
    private var completed = false
    private var continuation: CheckedContinuation<Void, Error>?

    init(data: Data) {
        self.data = data
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancellationRequested
    }

    func install(_ continuation: CheckedContinuation<Void, Error>) {
        lock.lock()
        if cancellationRequested {
            completed = true
            lock.unlock()
            continuation.resume(throwing: CancellationError())
        } else {
            self.continuation = continuation
            lock.unlock()
        }
    }

    func cancel() {
        lock.lock()
        cancellationRequested = true
        let pending = completed ? nil : continuation
        if pending != nil { completed = true }
        continuation = nil
        lock.unlock()
        pending?.resume(throwing: CancellationError())
    }

    func finish(_ result: Result<Void, Error>) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}

func processExitedNormally(_ status: Int32) -> Bool {
    status & 0x7f == 0
}

func processExitCode(_ status: Int32) -> Int32 {
    (status >> 8) & 0xff
}

private func posixError() -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
}
