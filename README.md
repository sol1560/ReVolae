# CuaRemote

在手机上提交任务，让 Mac 调用真实模型和本地工具执行，并把结果传回手机。写入操作先显示具体命令，手机签名批准后才执行；拒绝会立即终止任务。iPad、Android、远程终端和 SSH 等扩展的完成情况见下方进度文档，不代表全部已可用。

模型无关、开源（AGPL-3.0 + CLA）、隐私由你逐项选择（大脑在哪 / 哪类数据上云 / 模型走标准、ZDR、自带 key 还是本地）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/protocol` | 消息类型（zod）+ JSON Schema + Swift Codable（MIT） |
| `packages/brain` | TypeScript 大脑：agent loop、工具注册表、模型适配层、Jev 预检、策略引擎、cua-driver MCP 客户端 |
| `packages/jev-eval` | 基准集与评测脚本（Python） |
| `apps/hub` | Bun：WS 中继、配对、认证、推送、计量、云端大脑宿主、计费 |
| `apps/poc-web` | 手机网页原型 |
| `apps/daemon-macos` | Swift `cuaremote` 启动入口，启动真实 Bun 设备进程 |
| `apps/ios` | SwiftUI iPhone 客户端：登录、配对、任务、结果、签名批准/拒绝 |
| `apps/android-daemon` / `apps/android` | Android 被控端 / 控制端 |
| `firmware/dongle` | iPad USB dongle 固件与校准 |
| `docs/` | 架构、协议、安全模型 |

## 快速开始

```sh
bun install
bun test                         # 单元和集成测试，不是原生端到端验收
bun run typecheck

# 先在环境中配置 ZENMUX_API_KEY；这条预检使用真实网络、模型和文件系统。
CUAREMOTE_PROVIDER=zenmux:openai/gpt-4.1-mini bun scripts/e2e/live-device.ts
```

真模型：`--provider anthropic:<model>` / `openai:<model>` / `zenmux:<model>` / `ollama:<model>`，key 放环境变量（`ANTHROPIC_API_KEY` 等）。Jev 预检要 `TYPESAFE_API_KEY`，没有就退化成静态规则 + 更多确认。

## 原生 iPhone → Mac 测试

真实路径是 SwiftUI → WebSocket hub → Mac 设备进程 → 真实模型和本地工具 → SwiftUI。中继启用 JWT 身份验证，端间使用 HPKE 加密，批准和拒绝使用 P-256 签名。

- `scripts/e2e/host.ts start <本轮目录>`：启动真实测试宿主，生成随机文件及权限为 0600 的 `connection.json`；先设置 `CUAREMOTE_PROVIDER` 和模型密钥。
- `apps/ios`：用 XcodeGen 生成工程，先 `build-for-testing`，再将连接信息注入 `.xctestrun` 并运行真实 XCUITest。模拟器使用 `CODE_SIGN_IDENTITY=-`，不能禁用签名，否则 Keychain 无法工作。
- `scripts/e2e/host.ts verify <本轮目录>`：独立核对 Mac 文件内容、批准前没有写入、拒绝没有写入，以及三次真实模型执行记录。
- `scripts/e2e/host.ts stop <本轮目录>`：仅停止该轮宿主，不终止其它进程。
- [双 runner 工作流](.github/workflows/native-e2e.yml)：两个 `macos-26` job 同时运行，一个接收执行，一个运行 iPhone 模拟器。没有单独的 GitHub iPhone runner。需要仓库的 `ZENMUX_API_KEY` Actions Secret；缺少时明确失败，不使用 mock。测试连接凭据以密文交换，测试结束后关闭临时服务。

模拟器使用真实软件签名，不等于已验证真机 Face ID 或 Secure Enclave。测试只访问随机临时目录；允许目录不是操作系统沙箱，完整主机隔离需另建 VM。

## 文档

- [docs/architecture.md](docs/architecture.md)：四层怎么接、一次意图怎么走、大脑放哪。
- [docs/protocol.md](docs/protocol.md)：消息格式、签名、加密、配对、终端、同步、计费。
- [docs/security.md](docs/security.md)：三级分级、预检顺序、数据去向、挡不住的事。
- [CONTRIBUTING.md](CONTRIBUTING.md)：环境、改协议的规矩、测试、PR。

## 现状

TypeScript、Swift iPhone 客户端和 Mac 启动入口已有实现；原生端到端测试、GitHub 联测及其它平台的实际验证状态分别记录在 [state/progress.md](state/progress.md)。既有单元测试包含测试替身，它们的通过不能代替真实模型、真实设备代码和模拟器界面的端到端验收。

## 许可

核心代码 AGPL-3.0-only，见 [LICENSE](LICENSE)；`packages/protocol` 为 MIT。贡献前请阅读 [CLA.md](CLA.md)。
