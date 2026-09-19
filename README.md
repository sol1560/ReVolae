# CuaRemote

在手机上说一句话，让 Mac / iPad / Android 自己去做。不是远程桌面，是意图层：目标设备上的 agent 自己选 CLI、AppleScript、Shortcuts 还是 GUI 自动化（Cua Driver）去完成，每一步先经 Jev 安全预检，敏感操作推到手机上 Face ID 确认。同时它是一个完整的远程终端 / SSH 客户端。

模型无关、开源（AGPL-3.0 + CLA）、隐私由你逐项选择（大脑在哪 / 哪类数据上云 / 模型走标准、ZDR、自带 key 还是本地）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/protocol` | 消息类型（zod）+ JSON Schema + Swift Codable（MIT） |
| `packages/brain` | TypeScript 大脑：agent loop、工具注册表、模型适配层、Jev 预检、策略引擎、cua-driver MCP 客户端 |
| `packages/jev-eval` | 基准集与评测脚本（Python） |
| `apps/hub` | Bun：WS 中继、配对、认证、推送、计量、云端大脑宿主、计费 |
| `apps/poc-web` | 手机网页原型 |
| `apps/daemon-macos` | Swift：`CuaRemote.app` 常驻 + `cuaremote` CLI |
| `apps/ios` | SwiftUI iOS / iPadOS app（Liquid Glass；SSH 客户端；iPad 被控扩展） |
| `apps/android-daemon` / `apps/android` | Android 被控端 / 控制端 |
| `firmware/dongle` | iPad USB dongle 固件与校准 |
| `docs/` | 架构、协议、安全模型 |

## 快速开始

```sh
bun install
bun test                                                           # 全部 TS 测试，不需要任何 key
bun run packages/brain/src/cli.ts run "列出桌面上的 pdf" --provider mock   # 本地大脑 + 假模型跑一遍
bun run apps/poc-web/src/server.ts --port 8787 --no-gui              # 网页原型：浏览器代替手机
```

真模型：`--provider anthropic:<model>` / `openai:<model>` / `zenmux:<model>` / `ollama:<model>`，key 放环境变量（`ANTHROPIC_API_KEY` 等）。Jev 预检要 `TYPESAFE_API_KEY`，没有就退化成静态规则 + 更多确认。

## 文档

- [docs/architecture.md](docs/architecture.md)：四层怎么接、一次意图怎么走、大脑放哪。
- [docs/protocol.md](docs/protocol.md)：消息格式、签名、加密、配对、终端、同步、计费。
- [docs/security.md](docs/security.md)：三级分级、预检顺序、数据去向、挡不住的事。
- [CONTRIBUTING.md](CONTRIBUTING.md)：环境、改协议的规矩、测试、PR。

## 现状

TypeScript 部分（协议、大脑、hub、网页原型、iPad 校准、Android adb 路径、终端）与 Android 端、dongle 固件已有代码和测试；Swift 的 Mac daemon 与 iOS app 目录尚空，等 macOS 机器上开工。各功能进度见 [state/progress.md](state/progress.md)。

## 许可

核心代码 AGPL-3.0-only，见 [LICENSE](LICENSE)；`packages/protocol` 为 MIT。贡献前请阅读 [CLA.md](CLA.md)。
