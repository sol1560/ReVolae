import Foundation

public struct LaunchConfiguration: Sendable {
    public let repository: URL
    public let bun: URL
    public let hub: URL
    public let allowedDirectory: URL
    public let stateDirectory: URL
    public let provider: String

    public init(repository: URL, bun: URL, hub: URL, allowedDirectory: URL, stateDirectory: URL, provider: String) throws {
        let manager = FileManager.default
        let repository = repository.standardizedFileURL.resolvingSymlinksInPath()
        let allowed = allowedDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let state = stateDirectory.standardizedFileURL.resolvingSymlinksInPath()
        guard manager.fileExists(atPath: repository.appending(path: "packages/brain/src/cli.ts").path) else {
            throw LaunchError.invalid("找不到仓库的 packages/brain/src/cli.ts")
        }
        guard manager.isExecutableFile(atPath: bun.path) else { throw LaunchError.invalid("Bun 路径不是可执行文件") }
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: allowed.path, isDirectory: &isDirectory), isDirectory.boolValue,
              allowed.path != "/", allowed.path != manager.homeDirectoryForCurrentUser.path else {
            throw LaunchError.invalid("请选择一个具体工作目录，不能允许访问整个磁盘或用户目录")
        }
        guard state.path != allowed.path, !state.path.hasPrefix(allowed.path + "/") else {
            throw LaunchError.invalid("私钥状态目录不能放在模型可读的工作目录中")
        }
        guard ["wss", "ws"].contains(hub.scheme), hub.host != nil,
              hub.scheme == "wss" || ["127.0.0.1", "localhost", "::1"].contains(hub.host!) else {
            throw LaunchError.invalid("远程中继必须使用 wss；本机可以使用 ws")
        }
        guard !provider.isEmpty, provider != "mock", !provider.hasPrefix("mock:") else {
            throw LaunchError.invalid("请选择真实模型")
        }
        self.repository = repository; self.bun = bun; self.hub = hub
        self.allowedDirectory = allowed; self.stateDirectory = state; self.provider = provider
    }

    public var arguments: [String] {
        ["run", repository.appending(path: "packages/brain/src/cli.ts").path, "device", "--hub", hub.absoluteString,
         "--allow-dir", allowedDirectory.path, "--state-dir", stateDirectory.path, "--provider", provider,
         "--log", stateDirectory.appending(path: "events.jsonl").path]
    }
}

public enum LaunchError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? { switch self { case .invalid(let message): message } }
}
