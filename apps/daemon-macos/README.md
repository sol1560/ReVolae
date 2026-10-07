# Mac 原生启动入口

`cuaremote-macos` 是 Swift 原生 CLI 启动器。它负责检查路径和允许访问的目录、启动真实 Bun 设备进程、显示状态和停止自己启动的进程。设备登录、配对、加密、模型调用及工具执行使用 `packages/brain/src/device.ts` 和 `LocalBunHost`，不包含假模型或替代工具结果。

同一包还提供菜单栏 App。关闭窗口后继续运行；退出时先停止自己创建的宿主或取消待重连。App 与 CLI 共用状态目录锁，不创建第二条设备连接，不把进程存活当作连接成功。

```sh
bash apps/daemon-macos/scripts/build-app.sh
open apps/daemon-macos/.build/CuaRemote.app
```

这是本机开发签名包，尚未签名公证发布。首次在界面选择具体工作目录，并展开“开发环境与账号”设置仓库、Bun 和账号令牌。凭据只放进程内存/子进程环境，不存入配置；当前正式账号登录尚未接入。可以通过 `CUAREMOTE_REPO`、`CUAREMOTE_BUN`、`CUAREMOTE_HUB_URL`、`CUAREMOTE_PROVIDER` 提供非秘密初值。

App 读取本次启动的 `status.json` 区分正在连接、已认证、已断开和当前任务。配对码来自真实 `pairing.json`，使用/过期/删除后不继续显示缓存；“重新生成配对码”通过 stdin 请求并等待真实回执，不重启宿主或任务。配对仍需 Mac 的真实确认窗口，高风险操作仍需手机签名。只读权限结果与系统设置中的授权说明分开显示，不自行修改权限。

已完成认证的宿主仅在本次最终状态明确 `reconnectable: true` 时自动恢复，间隔为 2、4、8、16、30 秒，一次手动启动最多五次。重连用已验证的启动配置和仅存在内存的环境凭据，不读取清空后的输入框，不重发任何任务。主动停止、未知原因、初次启动失败、认证或公钥错误均不自动重试；点击停止或退出会取消等待并释放内存凭据。当前 Bun 对关闭码 1001 的报告有偏差，保守视为不恢复，不能声称已验收该关闭码的自动恢复。

“登录 Mac 时打开 CuaRemote”通过系统 SMAppService 注册，仅用户实际操作开关才会改变系统登录项。登录启动只打开 App，不保存账号令牌，不自动启动模型或执行任务。代码和开关已加入，但本次没有注册登录项；系统允许、公证发行及重启后的实际启动仍待用户授权验收。

```sh
swift test --package-path apps/daemon-macos -j 4
swift build --package-path apps/daemon-macos -j 4
apps/daemon-macos/.build/debug/cuaremote-macos start \
  --repo /absolute/ReVolae --bun /absolute/bun \
  --hub ws://127.0.0.1:8788/ws \
  --allow-dir /absolute/disposable-work \
  --state-dir /absolute/private-device-state \
  --provider zenmux:openai/gpt-4.1-mini
apps/daemon-macos/.build/debug/cuaremote-macos status --state-dir /absolute/private-device-state
apps/daemon-macos/.build/debug/cuaremote-macos stop --state-dir /absolute/private-device-state
```

`ZENMUX_API_KEY`、`CUAREMOTE_HUB_TOKEN` 等凭据从父进程环境继承，不写入命令行或启动记录。不要把私钥状态目录放进模型允许访问的目录。启动器拒绝整个 `/` 或用户主目录；远程地址必须使用 `wss://`。

`status` 是进程存活检查，不代表 hub 已认证或任务已完成。真实状态和输出查看私有目录的 `events.jsonl`；配对信息由 Bun 写到 `pairing.json`，五分钟过期。`stop` 先通知启动器关闭自己持有的子进程；若启动器已崩溃，仅在记录中的 PID、真实设备入口、工作目录和私有目录全部匹配时恢复停止，不对任意 PID 发信号。

## 原生采集入口

同一次 `swift build` 生成 `cuaremote-native-helper`。把绝对路径通过 `CUAREMOTE_NATIVE_HELPER` 传给 Bun；helper 不建立第二条设备连接。

```sh
apps/daemon-macos/.build/debug/cuaremote-native-helper stats
apps/daemon-macos/.build/debug/cuaremote-native-helper apps
apps/daemon-macos/.build/debug/cuaremote-native-helper inventory com.apple.finder sdef
apps/daemon-macos/.build/debug/cuaremote-native-helper capture 1024
```

标准输出只有一个 JSON，失败写标准错误并返回非零。状态来自真实系统计数器，CPU 为两次采样差值；内存使用量为活跃、固定和压缩页；没有内置电池时不返回电量。应用列表来自安装目录，学习状态由 Bun 存储补充。

`permissions` 返回当前进程的真实辅助功能/录屏权限与 `automation: "unknown"`；自动化需要按目标应用单独核验。`confirm-pair <手机名称> <手机标识>` 显示真实本机确认，标准输出为 `{accept: boolean}`。自动化工具在点击后可能因为窗口已关闭而报告后续读取失败，必须查看进程退出和实际配对结果，不重复点击。

`identity-load <绝对状态目录>` / `identity-save <绝对状态目录>` 使用 service `io.cuaremote.device.identity` 的 Keychain 软件身份记录。account 使用 POSIX `realpath`，与 Bun 一致；save 完整 JSON 从 stdin 读入，不进入 argv/env。仅条目不存在时 load 返回 null，访问失败不生成替代身份。真实迁移/重启/peer修改/冲突保护及仅测试条目清理可用 `bash apps/daemon-macos/scripts/test-keychain.sh` 复跑，不输出身份内容。

脚本字典从应用包静态读取，不启动应用。菜单和窗口采集只读取已运行的指定应用，并检查辅助功能权限，不自行授权或点击。按应用归属的个人快捷指令发现与可操作探索尚未接入，返回明确错误，不以空成功冒充完成。

`capture` 使用 ScreenCaptureKit 读取真实主屏幕，需要已有录屏权限，不弹授权或修改系统设置。可设置 `CUAREMOTE_CAPTURE_BUNDLE_ID` 限定为某个应用的单窗口；找不到该窗口则失败，不回退到整个桌面。自动测试不应捕获私人桌面；测试只采集专用的可公开窗口，或验证权限拒绝路径。

资源限制：Swift 构建使用 `-j 4`，iOS 构建使用 `-jobs 4`。工作目录限制是应用侧检查，不是系统沙盒。若要严格限制 CPU、内存和磁盘，应另建 macOS 虚拟机；本次没有安装或配置虚拟机。
