# 架构

CuaRemote 分四层：手机上的**意图层**、生成计划的**大脑**、每步放行前的**预检**、真正干活的**执行层**。四层之间只靠 [`packages/protocol`](../packages/protocol) 里定义的消息说话，所以任何一层都能换实现（大脑放本地还是云端、模型用哪家、被控设备是 Mac / iPad / Android）。

```diagram
┌──────────────┐    Frame(kind 0/1/2) 经 hub 中继，HPKE 端到端加密    ┌─────────────────────────────┐
│ 手机 app     │◀──────────────────────────────────────────────────▶│ 被控设备 daemon              │
│ iOS / Android│                                                    │ (Swift / Kotlin / Bun 参考)  │
│ · 文字/语音   │        ┌──────────────┐                            │  ┌────────────────────────┐ │
│ · 审批(Face ID)│◀─────▶│ hub (Bun)    │◀──────────────────────────▶│  │ brain (bun, stdio)     │ │
│ · 终端页      │  WS    │ · 中继 · 配对 │   云端大脑时 brain 在这里    │  │ · agent loop           │ │
│ · 设置        │  JSON  │ · 推送 · 计费 │                            │  │ · PolicyEngine + Jev   │ │
└──────────────┘        │ · 密文同步    │                            │  │ · 模型适配 · 学习应用   │ │
                        └──────────────┘                            │  └───────────┬────────────┘ │
                                                                    │   tools.call │ tools.result │
                                                                    │  ┌───────────▼────────────┐ │
                                                                    │  │ 宿主：shell/AppleScript │ │
                                                                    │  │ Shortcuts/fs/screenshot│ │
                                                                    │  │ cua-driver(MCP) / PTY  │ │
                                                                    │  │ iPad dongle / adb      │ │
                                                                    │  └────────────────────────┘ │
                                                                    └─────────────────────────────┘
```

## 一次意图怎么走

1. 手机发 `intent.submit{text, deviceId, mode}`，走 hub 中继（hub 只看信封上的收件人，看不到内容）。
2. 设备 daemon 解密后原样写进 brain 的 stdin。
3. brain 的 agent loop（[`packages/brain/src/agent/loop.ts`](../packages/brain/src/agent/loop.ts)）：向宿主要工具表（`tools.list`），把用户意图、工具表、最近几步交给模型，模型每次提议一个工具调用。
4. 每个调用先过 `PolicyEngine`（[`packages/brain/src/jev/policy.ts`](../packages/brain/src/jev/policy.ts)）：静态分级 → 作用域白名单 → Jev 预检（等级 / 是否符合意图 / 不可逆风险，三问并行）→ 自治档位算出 `allow` / `confirm` / `deny`。
5. `confirm` 时 brain 发 `approval.request`，手机弹出确认卡，用户 Face ID 后签名回 `approval.decision`，daemon 验签再放行。
6. 放行的调用由宿主执行（`tools.call` → `tools.result`），结果回到模型继续下一步；`step.*`、`run.finished` 一路转给手机展示。

## 各部分在哪

| 部分 | 路径 | 语言 | 说明 |
|---|---|---|---|
| 协议 | `packages/protocol` | TS（zod）→ JSON Schema + Swift Codable | 单一来源。改完跑 `bun run gen` 重生成，Swift/Kotlin 端照生成物实现 |
| 大脑 | `packages/brain` | TS（Bun） | `--mode host` 被 daemon spawn；也可作云端大脑跑在 hub 进程里 |
| 预检评测 | `packages/jev-eval` | Python | 基准集：静态规则与 Jev 的误报 / 漏报 / 延迟 / 成本 |
| hub | `apps/hub` | TS（Bun + sqlite） | WS 中继、配对、认证、推送、云端大脑宿主、密文同步、计费 |
| 网页原型 | `apps/poc-web` | TS | M0 用浏览器代替手机跑通链路 |
| Mac daemon | `apps/daemon-macos` | Swift | 常驻 app + `cuaremote` CLI；宿主工具、PTY、TCC 归属 |
| iOS app | `apps/ios` | SwiftUI | 控制端（Liquid Glass）、SSH 客户端、iPad 被控扩展 |
| Android | `apps/android-daemon` / `apps/android` / `apps/android-shared` | Kotlin | 被控端（无障碍 + MediaProjection）/ 控制端 / 共享协议 |
| iPad dongle | `firmware/dongle` | C（ESP32-S3）/ CircuitPython（RP2040）+ TS 校准 | USB HID + 网络，模拟键鼠 |

## 大脑放哪（用户选）

`PrivacySettings.brainLocation`：
- `local`：brain 跑在被控设备上，模型可以是本地（Ollama / LM Studio）也可以是云端 API；截图不出设备，除非模型在云上。
- `cloud`：brain 跑在 hub 里，适合被控设备性能弱或想长时间跑任务；hub 会看到明文意图和截图，所以这一档要求用户显式选择。
- `lan`：借同账号另一台设备的大脑。

模型档位 `modelTier`：`standard` / `zdr`（零数据保留端点，选了不支持的模型直接拒绝、不降级）/ `byok`（自带 key）/ `local`。云同步逐项开关（历史 / 截图 / 日志 / 快捷指令），传的是端到端密文，hub 存不解。

## 执行通道优先级（Mac）

模型看到的工具表按成本排：`shell.run` / `applescript.run` / `jxa.run` / `shortcuts.run` 先于 `gui.*`。GUI 三条路依次尝试：Jev 从无障碍树里选元素（`jev-ax`）→ 通用视觉模型看截图 → 专用 GUI 模型子循环。`gui.*` 由 brain 直接 spawn `cua-driver mcp`，只放行白名单里的 19 个工具，输入类默认后台投递不抢焦点。

## 学习应用

`app.learn.start{bundleId}` 让 brain 用 `app.explore` 读 sdef / 菜单 / 窗口 / 快捷指令四层，模型提出「卡片」（带占位符的可复用操作），校验后存成 `app.cards`；之后同类意图直接跑卡片，等级不低于卡片声明的等级。见 [protocol.md「学习应用」](protocol.md#学习应用)。

## 终端

同一条加密链路上的真 PTY：`terminal.open`（L2，要手机签名）→ kind 1 帧双向传字节，窗口式背压；shell 集成脚本发 OSC 133，brain 在终端模式能读最近几条命令块回答「刚才为什么报错」。iOS app 另带完整 SSH 客户端。见 [protocol.md「远程终端」](protocol.md#远程终端)。

## iPad 与 Android

- iPad 没有系统级自动化接口，走硬件：USB dongle 同时是 HID 键鼠和网卡，iPad 上的 app 截屏回传，brain 把「点 (x, y)」翻成校准过的相对位移宏。任何 app 都检测不到，因为对系统来说就是一个外接键鼠。
- Android 两条路：设备上装被控 daemon（无障碍 + MediaProjection，纯软件）；或 Mac 上有 `adb` 时由 Mac 的 brain 通过 `android.adb` 代管。两条路的工具名和参数一致。

更细的消息格式、密码学、配对、计费规则都在 [protocol.md](protocol.md)；安全模型在 [security.md](security.md)。
