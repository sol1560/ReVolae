# CuaRemoteMac

`CuaRemoteMac` 是基于 `CuaRemoteCore` 与 `CuaRemoteProtocol` 的非 UI macOS 15 守护进程包。每个已接受任务只启动一个 Brain native host 子进程；provider 与凭据由 Mac 本地配置。

```swift
import CuaRemoteCore
import CuaRemoteMac

let client = try RemoteClient(role: .device, name: "Mac")
let configuration = try MacDaemonConfiguration(
    repoURL: repoURL,
    bunURL: bunURL,
    workspaceURL: workspaceURL,
    provider: "anthropic:claude",
    modelCredentialEnvironment: ["ANTHROPIC_API_KEY": locallySuppliedKey]
)
let daemon = try MacDaemon(client: client, configuration: configuration)
try await daemon.connect(to: hubURL, token: token)
```

运行守护进程包测试：

```sh
swift test --package-path packages/macos
```

## 公开 API

- `MacDaemon.init(client:configuration:journalURL:)` 要求传入 device 角色的 `RemoteClient`。
- `MacDaemon.client`、`configuration`、`state`、`currentRun` 与 `history` 为只读可观察状态。
- `MacDaemon.connect(to:token:allowInsecureLocalDevelopment:)`、`disconnect()` 与 `stopCurrentRun()` 控制生命周期。
- `MacDaemonConfiguration.init(repoURL:bunURL:workspaceURL:provider:modelCredentialEnvironment:)` 接收本地路径、provider 选择和本地提供的凭据环境变量。
- `MacDaemon.executionAuthorityNotice` 提供命令工具的权限提示。
- `MacRunRecord` 和 `MacRunStatus` 描述持久化的运行历史。

守护进程只接受来自已配对且 ready 的 owner、面向本机设备的 `intent.submit`（仅 `agent` 模式）、owner 的 `run.cancel`、签名 `approval.decision` 与 `history.list`。手机提供的 provider、隐私设置、工具清单和宿主响应不会转发给 Brain。Brain 子进程只接收本地 provider 配置及经过接受的任务/审批消息。任一时刻最多运行一个任务；相同 owner 与 submit ID 的重复请求返回 journal 中记录的状态，不会再次启动子进程。

Journal 位于 Application Support，使用受限目录/文件权限和原子替换持久化。重启时，活动记录会标记为 `interrupted, effects may remain`，不会自动恢复执行。传输/peer 丢失或本地停止会清理审批和 grants，并向进程组发送 SIGTERM，必要时再发送 SIGKILL。终止进程不能撤销既有副作用，也不能保证已分离进程退出。

## 工具与权限

- `fs.read` 和 `fs.list` 会规范化符号链接，只允许访问所选 workspace 内的路径；读取大小、目录深度、条目数和协议输出均有限制，并会在文件操作前检查取消状态。
- `shell.run`、`applescript.run` 和 `shortcuts.run` 始终是静态 L2，必须经过签名、单次使用的审批；授权与活动 run 及精确操作详情/目标路径绑定。未声明的参数会被拒绝。
- Shell、AppleScript 和 Shortcuts 以登录用户的完整账户权限执行。workspace 只是工作目录，**不是**沙箱。Shell 使用 `/bin/sh -c`；AppleScript 使用 `/usr/bin/osascript -e` 并将脚本作为字面参数传入；Shortcuts 使用 `/usr/bin/shortcuts run` 并将名称作为字面参数传入。工具子进程只继承明确允许的基本环境变量，不继承宿主的任意环境变量。
- 首个 GUI 场景可以使用经明确审批的 AppleScript/System Events，但前提是用户已授予所需的 Automation 与 Accessibility 权限。没有自动或盲目的 CUA 回退。

Brain stdin 使用有界、串行的异步写入队列；每条 JSONL 写入不超过 1 MiB，队列最多 4 MiB，并通过非阻塞管道、poll 和超时处理背压。Brain stdout 只承载 JSONL 协议；每行最大 1 MiB，子进程 stdout/stderr 有界，stderr 不会写入守护进程日志。工具结果只回传给当前 Brain 子进程。

## 测试范围

集成测试会启动真实本地 Hub、两个配对的 Swift `RemoteClient`、实际 `bun run packages/brain/src/cli.ts --mode host --native` 子进程，并经由本机注入的 OpenAI-compatible fixture 驱动 Brain 的既有 JSONL 工具/审批协议。fixture 是确定性的测试模型，不是真实模型验收或生产 provider；测试不启动 UI，也不代表真实模型行为已经验证。

电话侧 `ApprovalSigning` helper 校验审批请求并生成/验证 ES256 approval-v1 决策。helper **不会**执行生物认证；手机 UI 在允许前必须先使用 `LAContext` 完成认证。
