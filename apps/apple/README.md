# 原生 iPhone → Mac

此目录的 XcodeGen 配置生成两个真实应用：`ReVolaePhone`（iOS 18+）和 `ReVolaeMac`（macOS 15+）。源代码分别在 `apps/ios/Sources` 与 `apps/daemon-macos/Sources`，双端共享 `packages/apple` 的身份、配对与加密连接；Mac 执行核心在 `packages/macos`。

## 构建

需要 macOS、Xcode 26+、Bun ≥1.3、XcodeGen。先在仓库根目录 `bun install`，然后：

```sh
xcodegen generate --spec apps/apple/project.yml
xcodebuild -project apps/apple/ReVolae.xcodeproj -scheme ReVolaeMac \
  -configuration Debug -derivedDataPath apps/apple/DerivedData \
  CODE_SIGN_IDENTITY=- build
xcodebuild -project apps/apple/ReVolae.xcodeproj -scheme ReVolaePhone \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/apple/DerivedData CODE_SIGNING_ALLOWED=NO build
```

XcodeGen 生成的工程、Info.plist 和 entitlements 一并提交；修改工程配置请先改 `project.yml` 再生成，不要手工改工程文件。真机在 Xcode 选择自己的 Team 和唯一 Bundle ID，签名、安装；模拟器构建不需要开发者账户。Mac 本地调试采用 ad-hoc 签名，分发需要自己的 Developer ID 与公证。

## 连接与配对

1. 启动 Hub（见 `apps/hub/README.md`）。双端输入**完全一致**的 Hub URL 与相应账户 token。公网必须使用 `wss` 并启用 Hub 账户认证，不能把无认证开发服务公开暴露。
2. Mac 选择本仓库、Bun 可执行文件和可读取的工作目录。在 Mac 本地输入模型 provider 和 API key；iPhone 不可覆盖模型或提交工具 RPC。
3. Mac 点击“启动连接”；iPhone 的“连接”页输入同一 Hub 并连接。本机开发可显式开启“允许本地开发 ws”；这是私网调试选项，不代表传输中的账户 token 有 TLS 保护。
4. Mac 的“配对 iPhone”页生成 5 分钟二维码，手机扫描（模拟器可粘贴配对 JSON），请求配对。核对两端身份指纹，然后在 **Mac 本地**确认。
5. iPhone 设备页出现“加密就绪”才可以发送任务。Hub 已认证不等于对端已经完成加密握手。

配对码含临时凭据，不应附在问题截图、录屏或日志中。撤销配对会删除本地信任并中断相关任务。密钥变化不会被静默接受。

## 操作与审批

- 在 iPhone 选择 Mac，输入指令。计划、审批、实际工具输出与结束报告显示在任务页；记录页从 Mac 查询持久化记录。
- `fs.read` / `fs.list` 只能访问 Mac 选定工作目录中的规范化路径。
- Shell、AppleScript、Shortcuts 都要求**单次签名审批**。手机显示原文、工作路径和目标应用，允许操作前必须通过 Face ID / Touch ID；无生物识别时不能批准，不存在模拟器跳过审批开关。
- 这些命令具有 Mac 登录用户完整账户权限，工作目录不是沙盒。尤其注意 `shell.run` 可以访问工作目录以外的路径；审批的是实际命令，而不是一个受限容器。
- GUI 首条路径是批准后的 AppleScript / System Events，需要 macOS 自动化/辅助功能授权。请由用户主动授予；授权失败应显示失败，不能绕过 TCC。
- Mac 配置的云模型可能收到任务与工具输出。密钥仅保存在当前进程内存，偏好中不存 API key 或 Hub token。重新启动须重新输入。
- 关闭 Mac 窗口后应用仍在菜单栏常驻；“立即停止任务”“断开连接”“退出”均可停止执行。本版本不自动注册登录项。

## 故障语义

手机进入后台主动断开，Mac 停止当前任务。断网、手机撤销配对或 Brain 失败都会阻止继续执行。终止进程不能撤销已发生的外部副作用，也不能保证回收自行脱离进程组的任意第三方程序。

Mac 将任务提交 ID 写入本地日志，重复提交不再执行；重启时未完成记录标为 `interrupted`，不自动重跑。手机收到不确定发送结果时应先重连、查询记录，再决定是否发新任务。`completed` 是 Brain 的完成报告，最终仍需核对真实文件或应用状态。

## 验证边界

`mock` provider 是测试用确定性模型，例如 `shell: printf hello` 会经过真实加密、审批和 Mac 子进程，但不代表真实语言模型能力。测试报告必须分别列出：组件测试、真实 Hub/Brain 进程集成、模拟器、真实 iPhone、目标 Mac TCC、蜂窝网络。未跑的项目不能标为通过。
