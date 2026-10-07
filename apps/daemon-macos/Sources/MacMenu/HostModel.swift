import AppKit
import Foundation
import MacLauncher
import NativeSupport
import Observation
import ServiceManagement

@MainActor @Observable
final class HostModel {
    var repository = ProcessInfo.processInfo.environment["CUAREMOTE_REPO"] ?? FileManager.default.currentDirectoryPath
    var bun = ProcessInfo.processInfo.environment["CUAREMOTE_BUN"] ?? NSHomeDirectory() + "/.bun/bin/bun"
    var hub = ProcessInfo.processInfo.environment["CUAREMOTE_HUB_URL"] ?? "ws://127.0.0.1:8788/ws"
    var allowedDirectory = ""
    var stateDirectory = NSHomeDirectory() + "/Library/Application Support/CuaRemote/device"
    var provider = ProcessInfo.processInfo.environment["CUAREMOTE_PROVIDER"] ?? "zenmux:openai/gpt-4.1-mini"
    var token = ""
    var modelKey = ""
    var running = false
    var stopping = false
    private(set) var retrying = false
    private(set) var reconnectAttempts = 0
    private var retryTask: Task<Void, Never>?
    private var currentLaunch: LaunchRequest?
    private var verifiedLaunch: LaunchRequest?
    private(set) var loginStatus = SMAppService.mainApp.status
    var error: String?
    var hostStatus: HostStatus?
    var permissions = Permissions.snapshot()
    var pairingCode: String?
    var pairingExpiry: Date?
    var refreshingPairing = false
    private var process: Process?
    private var input: Pipe?
    private var outputPipe: Pipe?
    private var outputBuffer = Data()
    private var console: FileHandle?
    private var startedAt = Date()
    private var activeState: URL?
    private var polling: Task<Void, Never>?
    private var pairingTimeout: Task<Void, Never>?
    private let executables: URL
    private struct LaunchRequest {
        let config: LaunchConfiguration
        let environment: [String: String]
    }

    init(executables: URL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()) {
        self.executables = executables
    }

    var connectionLabel: String {
        if retrying { return "连接中断，等待第 \(reconnectAttempts)/5 次重新连接" }
        guard running else { return "未连接" }
        switch hostStatus?.connection {
        case .authenticated: return "已向中继完成认证"
        case .connecting: return "正在连接中继"
        case .disconnected: return "连接已断开"
        case nil: return "等待宿主状态，尚未确认连接"
        }
    }

    func start() {
        guard !running, !retrying else { return }
        error = nil; reconnectAttempts = 0
        do {
            guard [repository, bun, allowedDirectory, stateDirectory].allSatisfy({ $0.hasPrefix("/") }) else {
                throw LaunchError.invalid("请选择允许访问的目录，并为所有路径使用绝对路径")
            }
            guard let url = URL(string: hub) else { throw LaunchError.invalid("中继地址无效") }
            let config = try LaunchConfiguration(repository: URL(fileURLWithPath: repository), bun: URL(fileURLWithPath: bun),
                hub: url, allowedDirectory: URL(fileURLWithPath: allowedDirectory),
                stateDirectory: URL(fileURLWithPath: stateDirectory), provider: provider)
            let launcher = executables.appending(path: "cuaremote-macos")
            let helper = executables.appending(path: "cuaremote-native-helper")
            guard FileManager.default.isExecutableFile(atPath: launcher.path), FileManager.default.isExecutableFile(atPath: helper.path) else {
                throw LaunchError.invalid("安装不完整，缺少原生启动器或采集服务")
            }
            var environment = ProcessInfo.processInfo.environment
            if !token.isEmpty { environment["CUAREMOTE_HUB_TOKEN"] = token }
            if !modelKey.isEmpty { environment["ZENMUX_API_KEY"] = modelKey }
            guard !(environment["CUAREMOTE_HUB_TOKEN"] ?? "").isEmpty else { throw LaunchError.invalid("请输入有效账号令牌；当前正式账号登录尚未接入") }
            environment["CUAREMOTE_NATIVE_HELPER"] = helper.path
            try launch(LaunchRequest(config: config, environment: environment))
        } catch { self.error = error.localizedDescription }
    }

    private func launch(_ request: LaunchRequest) throws {
        let config = request.config
        try FileManager.default.createDirectory(at: config.stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: config.stateDirectory.path)
        let log = config.stateDirectory.appending(path: "launcher-console.log")
        // 日志也可能含短期配对码，只写入本机私有目录。
        if !FileManager.default.fileExists(atPath: log.path) {
            guard FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw LaunchError.invalid("无法创建宿主日志") }
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: log.path)
        let output = try FileHandle(forWritingTo: log)
        try output.seekToEnd()
        let child = Process(), pipe = Pipe(), replies = Pipe()
        child.executableURL = executables.appending(path: "cuaremote-macos")
        child.arguments = ["start", "--repo", config.repository.path, "--bun", config.bun.path,
            "--hub", config.hub.absoluteString, "--allow-dir", config.allowedDirectory.path,
            "--state-dir", config.stateDirectory.path, "--provider", config.provider]
        child.currentDirectoryURL = config.repository
        child.environment = request.environment
        child.standardInput = pipe
        child.standardOutput = replies; child.standardError = replies
        startedAt = Date()
        try child.run()
        currentLaunch = request
        process = child; input = pipe; console = output; activeState = config.stateDirectory
        outputPipe = replies; outputBuffer.removeAll()
        replies.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor [weak self] in
                guard self?.process === child else { return }
                self?.consumeOutput(data)
            }
        }
        running = true; hostStatus = nil; pairingCode = nil; pairingExpiry = nil
        // 输入框立即清空，不存 UserDefaults、磁盘配置或命令行。
        token = ""; modelKey = ""
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }

    private func consumeOutput(_ data: Data) {
        try? console?.write(contentsOf: data)
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer.prefix(upTo: newline)
            let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
            outputBuffer.removeSubrange(...newline)
            if object?["type"] as? String == "device.pairing_updated" {
                pairingTimeout?.cancel(); pairingTimeout = nil
                refreshingPairing = false; refresh()
            } else if object?["type"] as? String == "device.command_failed" {
                pairingTimeout?.cancel(); pairingTimeout = nil
                refreshingPairing = false
                error = object?["message"] as? String ?? "设备没有完成控制请求"
            }
        }
    }

    func refreshPairing() {
        guard running, hostStatus?.connection == .authenticated, !refreshingPairing, let input else { return }
        do {
            error = nil; refreshingPairing = true
            try input.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"pairing.refresh\"}\n".utf8))
            pairingTimeout?.cancel()
            pairingTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                if self?.refreshingPairing == true {
                    self?.refreshingPairing = false
                    self?.error = "尚未收到配对码刷新回执，请检查连接后重试"
                }
            }
        } catch { refreshingPairing = false; self.error = "无法向宿主发送配对码刷新请求" }
    }

    func refresh() {
        permissions = Permissions.snapshot()
        guard let process, let directory = activeState else { return }
        running = process.isRunning
        hostStatus = HostStatus.read(from: directory, processRunning: running, startedAt: startedAt)
        if running, hostStatus?.connection == .authenticated { verifiedLaunch = currentLaunch }
        if !running {
            let reconnect = !stopping && hostStatus?.connection == .disconnected && hostStatus?.reconnectable == true
                && verifiedLaunch != nil && reconnectAttempts < 5
            if !stopping && !reconnect { error = "宿主已退出（\(process.terminationStatus)），未获准自动重连或已到重试上限。请检查私有日志后重新连接；不会重发上一次任务。" }
            pairingCode = nil; pairingExpiry = nil; stopping = false; refreshingPairing = false
            pairingTimeout?.cancel(); pairingTimeout = nil
            outputPipe?.fileHandleForReading.readabilityHandler = nil; outputPipe = nil
            try? input?.fileHandleForWriting.close(); input = nil
            try? console?.close(); console = nil
            polling?.cancel(); polling = nil
            self.process = nil; currentLaunch = nil; hostStatus = nil
            if reconnect { scheduleReconnect() }
            else { verifiedLaunch = nil }
            return
        }
        struct Pairing: Decodable { let code: String; let expiresAt: Int }
        let file = directory.appending(path: "pairing.json")
        let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        if hostStatus?.connection == .authenticated, let modified, modified >= startedAt,
           let data = try? Data(contentsOf: file), let offer = try? JSONDecoder().decode(Pairing.self, from: data),
           Date(timeIntervalSince1970: Double(offer.expiresAt)) > Date() {
            pairingCode = offer.code; pairingExpiry = Date(timeIntervalSince1970: Double(offer.expiresAt))
        } else { pairingCode = nil; pairingExpiry = nil }
    }

    func stop() async {
        retryTask?.cancel(); retryTask = nil; retrying = false
        verifiedLaunch = nil; currentLaunch = nil
        guard let process, process.isRunning else { refresh(); return }
        stopping = true
        // 只通知自己创建并仍持有的 CLI；它负责停止持有的 Bun 子进程及释放锁。
        process.terminate()
        for _ in 0..<100 where process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
        refresh()
        if process.isRunning { error = "宿主尚未退出，请等待任务停止；不会强行终止其他进程。" }
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1; retrying = true; error = nil
        let seconds = min(30, 1 << reconnectAttempts)
        retryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            guard let self, self.retrying, let request = self.verifiedLaunch else { return }
            self.retrying = false; self.retryTask = nil
            do { try self.launch(request) }
            catch {
                self.verifiedLaunch = nil
                self.error = "重新连接未启动：\(error.localizedDescription)"
            }
        }
    }

    // 仅用户实际操作开关才注册或删除登录项；启动、测试和状态读取均不调用。
    func setLoginLaunch(_ enabled: Bool) async {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try await SMAppService.mainApp.unregister() }
            loginStatus = SMAppService.mainApp.status
        } catch { self.error = "登录启动设置未完成：\(error.localizedDescription)" }
    }

    func chooseDirectory(_ assign: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { assign(url.path) }
    }
}
