import Foundation
import Darwin
import MacLauncher

struct Running: Codable {
    let pid: Int32
    let startedAt: Date
    let repository: String
    let allowedDirectory: String
    let provider: String
}

let args = Array(CommandLine.arguments.dropFirst())
func option(_ key: String) throws -> String {
    guard let index = args.firstIndex(of: key), args.indices.contains(index + 1) else {
        throw LaunchError.invalid("缺少参数 \(key)")
    }
    return args[index + 1]
}

do {
    guard let command = args.first, ["start", "status", "stop"].contains(command) else {
        throw LaunchError.invalid("用法：cuaremote-macos start --repo <仓库> --bun <Bun绝对路径> --hub <地址> --allow-dir <工作目录> --state-dir <私有目录> --provider <真实模型>；或 status|stop --state-dir <私有目录>")
    }
    let state = URL(fileURLWithPath: try option("--state-dir"), isDirectory: true)
    let statusURL = state.appending(path: "launcher.json")
    let stopURL = state.appending(path: "stop-request")
    if command == "stop" {
        guard FileManager.default.fileExists(atPath: statusURL.path) else { throw LaunchError.invalid("此目录没有运行中的宿主") }
        try Data("stop".utf8).write(to: stopURL, options: .atomic)
        for _ in 0..<20 where FileManager.default.fileExists(atPath: statusURL.path) { Thread.sleep(forTimeInterval: 0.1) }
        if FileManager.default.fileExists(atPath: statusURL.path) {
            // 启动器崩溃后的恢复：PID 和完整设备入口、私有目录都匹配才结束遗留子进程。
            let record = try JSONDecoder().decode(Running.self, from: Data(contentsOf: statusURL))
            let check = Process(), output = Pipe()
            check.executableURL = URL(fileURLWithPath: "/bin/ps")
            check.arguments = ["-p", String(record.pid), "-o", "command="]
            check.standardOutput = output
            try check.run(); check.waitUntilExit()
            let commandLine = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            guard commandLine.contains("/bun run \(record.repository)/packages/brain/src/cli.ts device --hub "),
                  commandLine.contains(" --allow-dir \(record.allowedDirectory) --state-dir \(state.path) --provider \(record.provider) --log ") else {
                throw LaunchError.invalid("没有找到匹配此私有目录的设备进程；不会终止其他进程")
            }
            guard Darwin.kill(record.pid, SIGTERM) == 0 else { throw LaunchError.invalid("无法停止已核对的设备进程") }
            try? FileManager.default.removeItem(at: statusURL)
            try? FileManager.default.removeItem(at: stopURL)
        }
        print("已请求停止此目录对应的设备进程。")
    } else if command == "status" {
        if let data = try? Data(contentsOf: statusURL) {
            let record = try JSONDecoder().decode(Running.self, from: data)
            let alive = Darwin.kill(record.pid, 0) == 0
            print(alive ? "运行中：PID \(record.pid)；模型 \(record.provider)；工作目录 \(record.allowedDirectory)" : "宿主已退出；没有活跃进程")
            print("状态来自 PID 存活检查；连接与任务结果请查看 events.jsonl。")
        } else { print("未运行：没有此目录的启动记录") }
    } else {
        guard let hub = URL(string: try option("--hub")) else { throw LaunchError.invalid("中继地址无效") }
        let config = try LaunchConfiguration(repository: URL(fileURLWithPath: option("--repo")),
            bun: URL(fileURLWithPath: option("--bun")), hub: hub,
            allowedDirectory: URL(fileURLWithPath: option("--allow-dir")), stateDirectory: state, provider: option("--provider"))
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
        let lease = try DeviceLease(stateDirectory: state)
        if let data = try? Data(contentsOf: statusURL), let record = try? JSONDecoder().decode(Running.self, from: data),
           Darwin.kill(record.pid, 0) == 0 {
            throw LaunchError.invalid("此目录记录的宿主仍在运行，请先使用 stop 核对并停止它")
        }
        let process = Process()
        process.executableURL = config.bun
        process.arguments = config.arguments
        process.currentDirectoryURL = config.repository
        // 凭据仅从父进程环境继承，不写进启动记录或命令行。
        process.environment = ProcessInfo.processInfo.environment
        process.standardInput = FileHandle.standardInput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        try? FileManager.default.removeItem(at: stopURL)
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        let record = Running(pid: process.processIdentifier, startedAt: Date(), repository: config.repository.path,
                             allowedDirectory: config.allowedDirectory.path, provider: config.provider)
        try JSONEncoder().encode(record).write(to: statusURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statusURL.path)
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        let sources = [SIGINT, SIGTERM].map { number in
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { @Sendable in if process.isRunning { process.terminate() } }
            source.resume()
            return source
        }
        let stopRequests = DispatchSource.makeTimerSource(queue: .global())
        stopRequests.schedule(deadline: .now(), repeating: .milliseconds(500))
        stopRequests.setEventHandler { @Sendable in
            if FileManager.default.fileExists(atPath: stopURL.path), process.isRunning { process.terminate() }
        }
        stopRequests.resume()
        process.waitUntilExit()
        stopRequests.cancel()
        for source in sources { source.cancel() }
        try? FileManager.default.removeItem(at: statusURL)
        try? FileManager.default.removeItem(at: stopURL)
        withExtendedLifetime(lease) {}
        exit(process.terminationStatus)
    }
} catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(1)
}
