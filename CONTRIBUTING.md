# 参与贡献

## 开始之前

- 先看 [docs/architecture.md](docs/architecture.md) 知道四层各在哪，再看 [docs/protocol.md](docs/protocol.md) 了解消息格式。
- 第一个 PR 需要签 [CLA](CLA.md)。核心代码是 AGPL-3.0-only，`packages/protocol` 是 MIT，贡献时按目录遵守。
- 安全相关问题走 [docs/security.md](docs/security.md) 末尾的私密渠道，不开公开 issue。

## 环境

| 需要 | 版本 | 用于 |
|---|---|---|
| Bun | ≥ 1.3 | protocol / brain / hub / poc-web / 校准库；终端功能依赖 `Bun.spawn({terminal})` |
| uv + Python | 3.12+ | `packages/jev-eval`、`firmware/dongle` 的 Python 部分 |
| Xcode | 26+ | `apps/daemon-macos`、`apps/ios`（只在 macOS 上） |
| JDK 17 + Android SDK | AGP 9 | `apps/android*`（用仓库自带 `./gradlew`） |

```sh
bun install
bun test                # TS 全部测试
bun run typecheck       # 每个包 tsc --noEmit
uv run --with pytest pytest -q   # firmware/dongle 与 jev-eval 的 Python 测试
./gradlew test          # Android（需要 SDK）
```

不需要任何 API key 就能跑全部测试：模型用 `mock` provider，Jev 用 `--mock`，PTY 测试在 Linux / macOS 上用本机 bash。

## 改协议

`packages/protocol/src` 是唯一来源。改完必须重新生成并一起提交：

```sh
bun run gen     # → packages/protocol/schema/*.json 与 swift/Sources/CuaRemoteProtocol/Protocol.swift
```

规则：
- 新消息要同时加进 `HubMessage`（端 ↔ hub）或 `PhoneToDevice` / `DeviceToPhone`（端 ↔ 端）以及 `AllMessages`；两个方向都有的类型在 `messages.ts` 的 filter 里去重。
- 只加可选字段、不改已有字段含义。要改就加新消息类型，旧的标 deprecated 留一个版本。
- 涉及签名 / 加密 / 编码的改动要更新 `fixtures/` 里的测试向量，Swift 端靠这些向量验互通。
- 在 `docs/protocol.md` 对应小节写清楚语义（谁发、什么时候发、对端怎么处理、错误码）。

## 改大脑 / 宿主

- 新工具：在宿主的 `tools.list` 里声明 `ToolDescriptor`（`staticLevel` 按 [security.md](docs/security.md) 三级填，宁高勿低），在 `docs/protocol.md` 的工具表加一行。
- 预检顺序（静态 → 作用域 → Jev → 档位）不能调；Jev 只能升级不能降级。任何降低确认频率的改动都要在 PR 里说明并附 `packages/jev-eval` 的对比数字。
- 平台专属能力（iPad dongle、adb、PTY）写成独立 `Host` 包装层（参考 `ipad-host.ts` / `adb-host.ts` / `terminal/manager.ts`），不要往 `loop.ts` 里塞平台分支。

## 写测试

- 测试放在各包 `test/` 下，Bun 用 `bun:test`，Python 用 pytest。
- 对每个可能写错的地方设计一个「错了会挂」的用例：边界两侧、不对称输入、迟到 / 重放 / 越界的消息。不写只证明「没崩」的测试。
- 涉及外部进程（PTY、adb、cua-driver）用假实现单测逻辑，再加一个真进程冒烟测试并标明平台前提。
- 网页 UI 改动要附截图；Swift / Android UI 改动附模拟器截图。

## 提交与 PR

- 一个 PR 做一件事；协议改动与用它的实现可以在同一个 PR。
- 提交信息用中文或英文都行，第一行说清改了什么，例如 `F1.7 远程终端：terminal.open 签名与窗口背压`。
- PR 描述写：改了什么、为什么、怎么验证（贴命令和关键输出）、替维护者做了哪些可否决的决定。
- CI 会跑 `bun test`、`bun run typecheck`、pytest；全绿再请求 review。

## 文档语言

仓库文档和注释默认简体中文，说人话，不堆术语；对外协议字段名、代码标识符用英文。
