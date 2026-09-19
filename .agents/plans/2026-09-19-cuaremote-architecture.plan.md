---
name: CuaRemote 总体方案与 M0 PoC
overview: "CuaRemote 是「手机上说一句话，Mac 上的 daemon 自己用 CLI / AppleScript / Shortcuts / Cua Driver 去做」的开源远程控制平台，同时是一个完整的远程终端 / SSH 客户端。方案：Mac 端 = Swift 宿主 App（权限、常驻、终端、截屏、加密、连接）+ TypeScript「大脑」子进程（规划、工具调用、Jev 预检），大脑同一份代码可在 Mac 或云端跑；隐私不替用户决定，由用户按「大脑在哪 / 哪类数据上云 / 模型走标准、ZDR 还是本地」逐项细选。M0 先纯 TS 在一台 Mac 上跑通「手机网页 → 大脑 → Jev → 工具执行 → 结果回传」，并测出单次操作成本、Jev 误报率、CLI 覆盖率。"
todos:
  - id: p-prep
    content: "P: Sol 手动准备：装 CuaDriver.app 并授权（确认 cua-driver mcp 能起）、给终端 Automation 权限、配 ANTHROPIC/OPENAI/TYPESAFE key、装 Ollama 拉 muse-glimmer:30b-mlx、LM Studio 装 Qwen3.8-27B（可选 Holo3-35B-A3B）、建测试目录与 2-3 个测试 Shortcuts"
    status: pending
  - id: a-repo
    content: "A: 初始化 monorepo（bun workspaces）：packages/protocol、packages/brain、apps/poc-web、packages/jev-eval，AGPL-3.0 LICENSE + CLA + README，GitHub Actions 最小 CI"
    status: pending
  - id: b-protocol
    content: "B: packages/protocol 写 zod 消息类型（intent/run/plan/step/approval/terminal/media/stats/capabilities/privacy-settings）与帧格式定义，导出 JSON Schema"
    status: pending
  - id: c-tools
    content: "C: packages/brain 工具注册表：shell.run / applescript.run / jxa.run / shortcuts.run / fs.list / fs.read / gui.* = 经 Vercel AI SDK MCP 客户端连 cua-driver mcp stdio 并按白名单过滤（默认 cua 官方 13 个 + screenshot），bounded 权限模式由作用域设置生成；每个工具带静态等级、作用域检查、成本级别、数据外发标记"
    status: pending
  - id: d-agent
    content: "D: packages/brain agent loop + 模型适配层：先出草案计划再逐步 tool calling 执行（Vercel AI SDK），接 Claude、OpenAI、本地 Ollama（Anthropic 兼容）、本地 LM Studio（OpenAI 兼容）四种 provider，每个 provider 带隐私档位标签；系统提示含 cua 三条省 token 规则；25 步/credit 上限；每步 JSONL 日志；cuaremote run \"<意图>\" CLI"
    status: pending
  - id: d2-local
    content: "D2: 本地单模型大脑跑通：Muse Glimmer 30B（Ollama）和 Qwen3.8-27B（LM Studio）各自用 tool calling 调 shell/applescript + cua-driver MCP 工具完成 Calculator 2+3 和一条 CLI 任务，记录 token / 耗时，与 cua 文档的 12,251 token / 224 秒基线对照；不行就换 llama.cpp llama-server 端点"
    status: pending
  - id: d3-gui-adapter
    content: "D3（stretch）：packages/brain GuiExecutor 子循环 + GuiModelAdapter：gui.task 高层工具；先做 generic-vision 和 holo3 两个适配器（uitars15 / uimate 推 M1）；动作映射到 cua-driver MCP 工具；每个动作过 Jev；--gui-model 参数可切"
    status: pending
  - id: e-jev
    content: "E: packages/brain Jev 客户端 + 策略引擎：三题并行（choice 分级 / noul 意图匹配 / score 不可逆），最终等级 = max(静态, Jev)，阈值可配，1.5s 超时或「本地模式」关闭 Jev 时降级为静态策略，同 state 哈希缓存"
    status: pending
  - id: f-web
    content: "F: apps/poc-web：bun 起 http://<mac>.local:8787，手机 Safari 打开，输意图、看步骤时间线、审批按钮、切换模型档位（标准/ZDR/本地），WS 推事件（含 L2 暂停→确认→继续的完整链路）"
    status: pending
  - id: g-bench
    content: "G: packages/jev-eval：50 条意图基准集（CLI/AppleScript/GUI 各类）每条用云端模型和本地模型各跑 3 次；10 条纯 GUI 任务分别用 Muse Glimmer 30B / Qwen3.8-27B / 云端模型（若 D3 完成再加 Holo3）跑 3 次；150 条步骤标注 + 30 条对抗样本跑 Jev；脚本汇总 P50/P95 成本与延迟、CLI 覆盖率、Jev 误报/漏报、本地模型成功率、本地 GUI 任务成功率、每步延迟与每任务输入 token"
    status: pending
  - id: verify
    content: 验证：10 条固定意图命令行端到端跑通；手机上一条含 L2 的任务能暂停→确认→继续；切到本地模型后抓包确认无外发；Jev 超时降级可演示；Muse Glimmer 和 Qwen3.8 各用本地 tool calling 跑通 Calculator 2+3 并记录 token/耗时；出 PoC 报告回答五个数字
    status: pending
isProject: true
---

# CuaRemote 总体方案与 M0 PoC

这是跨多次会话的项目总纲。第一部分是整体方案，第二部分是 M0 PoC 的具体切片，todos 只覆盖 M0。M1 之后每个里程碑开始时再单独出 plan。

## 背景

- 仓库 [ReVolae](https://github.com/sol1560/ReVolae) 目前是空仓库，没有任何提交。
- 设计稿原型在 [.amp/in/design/index.html](../../.amp/in/design/index.html)（单页 hash 路由），各屏截图在 [.amp/in/artifacts/design/](../../.amp/in/artifacts/design/)。4 个 tab：设备 / 应用 / 活动 / 我的 + 一个「✨ 让 Mac 做一件事」浮动按钮。设计稿里没有终端界面。
- Sol 的 Mac：macOS 26.5 / M5 Max / 128GB；Xcode 26.6 + iOS 26.5 全套模拟器；swift 6.3.3、node 25、bun 1.3.9、python 3.14、rust 1.93；已装 LM Studio、Warp、Ghostty、WeChat。**没装** cua-driver、Tailscale；**Automation 权限未授**（`tell application "System Events"` 会阻塞）；**签名证书为空**（只有 App Store Connect API key）；iPhone 17 Pro Max 配过对但当前 unavailable；无 XIAO 板。三家模型 API 网络都通。
- Cua Driver（已读源码和 2026-09 的 README）：**agent 对接面是 MCP over stdio（`cua-driver mcp`）**，shell 用 `cua-driver call`；工具有 `start_session / end_session / launch_app / list_apps / list_windows / get_window_state(max_elements, max_depth) / get_accessibility_tree / move_cursor / click / type_text / press_key / hotkey / invoke_menu / screenshot(pid, window_id)`，后台交付不抢焦点。macOS 权限归属：标准装 `CuaDriver.app` 起 daemon，`cua-driver mcp` 自动代理过去；宿主 App 嵌入用 `@trycua/cua-driver` 的 `EmbeddedCuaDriverHost`（UniFFI 原生库）spawn 私有 daemon 继承宿主 TCC；**README 明说裸跑 `cua-driver serve` 不受支持**。权限模式 `standard / bounded（按审核过的能力清单放行）/ unrestricted`，启动时定死。另有本地加密的「Computer History」动作历史预览。截图只有单帧，没有实时流；各 crate 和 SDK 均 MIT。
- Cua 官方的本地模型路线（2026-08-10 文档「Run a local model with Cua Driver」，已读原文）：**Muse Glimmer 30B**（Meta）+ Ollama `muse-glimmer:30b-mlx` 或 llama.cpp `unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL` + Claude Code 当 harness + `cua-mcp-filter` 只暴露 13 个工具。Cua 自己没有训练模型，cua-driver 不带模型。详见 N 节。
- Jev（TypeSafe）：托管 API `POST https://api.typesafe.ai/v1/systemone`，问题类型 noul / choice / score，同一 state 并行评估，70-500ms，$0.042/M 输入 token，仅文本，无开源权重，**没有本地版**。
- ZDR（已查官方文档）：Anthropic 和 OpenAI 的零数据留存都是**按账号签约开通**的，不是请求参数；OpenAI ZDR 下 `store` 强制 false；**Anthropic 的 Claude Fable 5.1 / Fable 5 是 Covered Model，默认强制留存，ZDR 账号也用不了**。
- 本地模型（已读 cua / UI-TARS-desktop 源码，并查了 HF / GitHub / arXiv）：两者都接 LM Studio `http://localhost:1234/v1`（OpenAI 兼容），GUI 任务要用带视觉的模型；cua 有原生 `mlx/mlx-community/UI-TARS-1.5-7B-4bit` 适配器。UI-TARS 开源权重只到 **1.5-7B**（2025-04，OSWorld 27.5），UI-TARS-2 只有论文没有权重；2026 年新出的开源 GUI 模型（Holo3-35B-A3B、UI-Mate-27B/9B、Qwen3.5/3.8 系列）在 OSWorld-Verified 上是 UI-TARS-1.5-7B 的 2-3 倍。详见 N 节。

## 三条最重要的决定

1. **Mac 端 = Swift 宿主 App + TypeScript 大脑子进程。M0 先纯 TS，M1 加 Swift 壳。** 大脑必须能搬家（本地跑或云端跑同一份代码），因为 iPad/Android 被控时没有 Mac 可以跑它，也因为用户可以选云端大脑。
2. **隐私不替用户决定，做成三个维度的细选（见 B 节）**：大脑在哪（每台设备单独选）、哪类数据上云（历史/截图/日志/快捷指令逐项开关）、模型走哪档（标准 / ZDR / 本地）。默认值偏保守，但每一项都能改，iPad 这种没得选的地方明确告诉用户为什么。
3. **远程终端是完整功能**：既能开配对设备的本地终端，也是能连任意主机的 SSH 客户端（主机列表、密钥管理、Snippets、扩展键盘、SFTP、Face ID / FIDO2 解锁）。AI 生成命令走同一个大脑。

```diagram
┌──────────────┐  WSS(E2E 加密)  ┌──────────────┐  WSS(E2E 加密)  ┌──────────────────────────────┐
│ iOS app      │◀──────────────▶│ hub (云端)    │◀──────────────▶│ Mac: CuaRemote.app (Swift)    │
│ 意图/审批/终端│                │ 中继+计量+推送 │                │  ├─ brain (bun, TS) 子进程     │
│ SSH 客户端   │                │ 可选:云端大脑  │                │  ├─ cua-driver 私有 daemon(MCP)│
│ Face ID 签名 │                │ 可选:密文同步  │                │  └─ PTY / SCStream / Keychain │
└──────┬───────┘                └──────┬───────┘                └──────────────┬───────────────┘
       │ 直连 SSH                      │ 计量代理                               │ 本地
       ▼                               ▼                                       ▼
  任意 SSH 主机              云端模型 (标准 / ZDR org) / Jev / JOC 计费     LM Studio / MLX 本地模型
```

## A. 技术选型：Swift 宿主 + TS 大脑

| 组件 | 语言 | 职责 |
|---|---|---|
| `CuaRemote.app`（LSUIElement，`SMAppService.agent` 注册常驻） | Swift | TCC 权限归属、WS 连接 + 端到端加密、PTY、SCStream 实时画面、IOKit 状态、Keychain、spawn cua-driver 和大脑 |
| `brain`（bun 单文件二进制，打进 .app；同一份也部署在 hub） | TS | 规划器 / agent loop、工具注册表、模型适配层、Jev 客户端、策略引擎、成本记账 |
| `cua-driver` | 复用官方二进制（M0 标准装 `CuaDriver.app`；M1 用 `@trycua/cua-driver` 的 `EmbeddedCuaDriverHost` 由 Swift 宿主 spawn 私有 daemon，继承宿主 TCC） | GUI 兜底，agent 侧走 `cua-driver mcp` stdio |

- 不用纯 TS/Bun 做 daemon：SCStream 实时画面、`forkpty`、Keychain、Bonjour 都要原生代码；`@trycua/cua-driver` 是 napi 原生模块，在 `bun build --compile` 下能否加载未验证。
- 不用 Rust：cua-driver 的 Rust crate 是 `publish = false` 私有 crate；Apple 专属 API 用 Swift 最省。
- 大脑用 TS：必须能在 hub 里跑；Vercel AI SDK 直接解决多模型 tool calling / token 统计 / 流式，OpenAI 兼容 provider 也能接 LM Studio。
- 签名：开发期用 Keychain Access 自建「CuaRemote Dev」代码签名证书，TCC 授权跨重编译不丢；发布要 Developer ID + 公证，只能账号持有人在开发者网站创建。Info.plist 必须有 `NSAppleEventsUsageDescription`。
- 分发：`brew install --cask cuaremote` → `cuaremote setup` 注册常驻并引导授权。设计稿里的 `brew install cuaremote` 改成 `--cask`。
- 待验证（M1 第一周）：大脑（孙进程）spawn 的 osascript 是否沿进程树归属到 .app 的 TCC。cua-driver 这部分不用猜：README 明说嵌入只支持 `EmbeddedCuaDriverHost` 或 `cua-driver mcp --direct`（用 spawn 方的 TCC），裸跑 `serve` 不受支持，按它来。
- `@trycua/cua-driver` 是 napi 原生包，M1 由 Swift 宿主直接调 UniFFI 原生库（或一个极薄的 node 侧进程）来 spawn 私有 daemon，brain 只连 `cua-driver mcp`，不碰原生库；这样 `bun build --compile` 能不能加载 napi 的问题绕开了。

## B. 隐私由用户细选：三个维度 + 一张「数据去哪了」表

**维度 1：大脑在哪（每台被控设备单独选）**

| 选项 | 意图/截图/命令输出经过哪里 | 能做什么 | 不能做什么 |
|---|---|---|---|
| 本地大脑（Mac 默认） | 只在 Mac 上；hub 只看到加密后的字节 | 本地模型时完全不出内网 | Mac 关机时没法发指令（本来也执行不了） |
| 云端大脑 | hub 上的大脑看到明文意图、截图、命令输出 | Mac 离线也能查历史、多设备协同、iPad 无 Mac 也能控 | 无法和「本地模型」组合 |
| iPad / Android 被控 | **没有本地大脑可用**：iPad 后台只有广播扩展，跑不了规划器 | 可选「借用同一局域网内某台 Mac 的大脑」（推荐，配对时提示）或云端大脑 | UI 上明确写「iPad 无法在本机运行大脑，原因是 iPadOS 后台限制」 |

**维度 2：哪类数据上云（逐项开关，默认全关）**

| 数据 | 默认 | 打开后 | 存法 |
|---|---|---|---|
| 操作历史（意图、步骤、结果文本） | 只存本机 | 多设备可看、Mac 离线可看 | 手机侧密钥加密的密文块，hub 存不了明文 |
| 截图 / 回放帧 | 只存本机 | 同上 | 同上，单独开关，默认关 |
| 执行日志（原始命令、脚本） | 只存本机 | 用于跨设备排错 | 同上 |
| 快捷指令 / 主机列表 / SSH 密钥元数据 | 只存本机 + iCloud Keychain（Apple 端到端） | 多设备同步 | 私钥永远不出 Secure Enclave / Keychain |
| 用量计量（token 数、步数、耗时） | 上云 | — | 这是计费必须的，只有数字没有内容，UI 里明说 |

**维度 3：模型走哪档（每个 provider 一个标签，选模型时直接看到）**

| 档位 | 含义 | 谁提供 | 限制 |
|---|---|---|---|
| 标准 | 走 hub 的普通模型账号，厂商按自己的政策留存（通常 30 天滥用监控） | hub 计费 | 无 |
| ZDR | 走 hub 签了零留存的模型账号（OpenAI ZDR org / Anthropic ZDR org） | hub 计费，需要项目方去签约 | **Claude Fable 5.1 不在 ZDR 范围内**（Covered Model），选它时 UI 标红；ZDR 也不等于「不出网」 |
| 自带 key | 用户自己的 API key 直连厂商，不经 hub | 用户自付 | 用户自己账号是否 ZDR 由用户负责，UI 里可手动标注 |
| 本地 | LM Studio / Ollama / MLX，OpenAI 兼容接口，`http://localhost:1234/v1` | 不计费 | 本地档位默认只选一个「大脑模型」（通用 agent 模型，候选 Muse Glimmer 30B / Qwen3.8-27B，见 N 节）；「高级」里可再加一个可选「GUI 模型」（专门看截图出坐标的模型，候选 Holo3-35B-A3B / UI-Mate / UI-TARS-1.5-7B）；PoC 要测本地模型的成功率 |

- **「数据去哪了」页面**（放在「我的 → 隐私」）：把上面三张表合成一张实时视图——当前这台设备的大脑在哪、当前模型档位、每类数据的去向，一眼看完。改任何一项就地生效。
- **Jev 是托管服务、只收文本**：即使本地大脑 + 本地模型，Jev 预检仍会把「步骤文本（命令/脚本/AX 标签，不含截图）」发到 TypeSafe。所以加一个独立开关「Jev 预检上云」，关掉后策略引擎退到纯静态分级（静态 L0 放行、其余全部人工确认）。UI 里说清楚代价是「确认弹窗变多」。
- **预设三档**方便用户一键选：「全本地」（本地大脑 + 本地模型 + Jev 关 + 同步全关）、「平衡」（本地大脑 + ZDR 模型 + Jev 开 + 同步关，默认）、「全云」（云端大脑 + 标准模型 + 同步全开）。预设只是把上面的开关批量设置，选完仍可逐项改。

## C. 连接、加密、配对

- **演进**：M0 一个 bun 进程 = 大脑 + 工具 + 手机网页（同 Wi-Fi），不加密不部署 → M1 拆成 Swift 宿主 + 大脑子进程，hub 上云（Bun.serve WS + Postgres，Fly.io 或 Hetzner 单机），两端出站 WSS 连 hub，端到端加密 + **云端大脑模式同时上线**（同一份 brain 包，只是 tools 调用经中继到 daemon）→ M3 接 JOC 计费、密文历史同步、局域网直连。
- **不把 hub 塞进 justoneconnector 的 Next.js**：长连接 + 二进制中继 + 推送不适合 Next.js；JOC 只当身份/计费后端被 hub 调用；AGPL 边界也干净。
- **连接**：两端永远出站连 hub。局域网直连（Bonjour + 同一套加密）M3 做，给实时画面和终端降延迟。Tailscale 不做产品依赖。
- **端到端加密**（CryptoKit，零第三方依赖）：每条会话双方各开一个 HPKE auth 模式上下文（X25519 + ChaChaPoly），一个方向一个；hub 只看到路由头。云端大脑模式下，hub 里的大脑是一个「合法的第三方」，手机↔hub、hub↔daemon 各自加密，UI 里明示。推送用 HPKE base 模式封装 → APNs → Notification Service Extension 解密。
- **审批签名**：手机审批 = Secure Enclave P-256 密钥（生物识别 ACL）对 `stepId + decision + expiry(≤2min)` 签名，daemon 验签。hub 伪造不了审批。
- **配对**：Mac `cuaremote pair` 在终端打 ANSI 二维码 `{hubURL, macDeviceId, macPubKeys, 一次性 128 位 secret, 4 分钟过期}` → 手机扫码经 hub 发 `{phonePubKeys, HMAC(secret, 双方公钥)}` → Mac 验 HMAC，终端显示「iPhone 17 Pro 请求配对，按 Enter 确认」。6 位码只当无摄像头时的撮合句柄（限速 + 4 分钟 + 两端短认证串人工比对）。

## D. 协议

- 一条 WebSocket，帧内多路复用：`[u8 kind][u32 streamId][payload]`，kind = 0 控制 JSON / 1 PTY 字节 / 2 媒体帧（JPEG 或 H.264 NAL）。整个 payload 端到端加密。
- 控制消息 JSON，`v` 版本号 + `id` 幂等。TS 用 zod，Swift 手写 Codable（或 quicktype 生成）。protobuf 等 Android 上了再考虑。
- 手机→设备：`intent.submit{text, deviceId, mode: agent|terminal}`、`run.cancel`、`approval.decision{stepId, allow, signature, remember?}`、`terminal.open/input/resize/close`、`media.subscribe{fps, maxWidth}/unsubscribe`、`stats.get`、`shortcut.run`、`history.list`、`privacy.set{brainLocation, sync{...}, modelTier, jevEnabled}`。
- 设备→手机：`run.created{runId, plan[]}`、`plan.updated`、`step.started`、`step.precheck{level, intentMatch, risk, jevMs, verdict}`、`step.approval_required{concreteAction}`、`step.finished{ok, ms, channel, cost, dataLeftDevice: bool}`、`run.finished`、`terminal.data/exit`、`media.frame`、`stats`、`capabilities`、`privacy.state`。
- 端↔hub（明文）：`hello/auth`（设备用密钥挑战应答，手机用 JOC JWT）、`route{to}`、`push.send`、`pair.*`。
- 大脑↔宿主（本地 stdio 或经中继，同一 JSON）：`tools.list`、`tools.call`、`event.emit`、`approval.request`。大脑不关心自己在本地还是云端。
- PTY 流要有窗口式背压（`terminal.ack{bytes}`）和 `resize`；OSC 133 块边界放 M3。

## E. Jev 预检

- state 纯文本：用户原话、计划摘要（标当前步）、本步描述、通道、具体动作（完整命令/脚本/{app, window, element, action}）、目标 app 与作用域、白名单、前序结果（截断 500 字）。不发截图。
- 三题并行一次：`choice(L0/L1/L2)`、`noul(是否服务用户原话意图)`、`score(不可逆风险)`。
- 阈值全放 daemon 策略引擎（手机设置同步过来）：最终等级 = `max(工具注册表静态等级, Jev 等级)`；L0 放行；L1 `intentMatch ≥ 0.6 且 risk < 0.3` 自动，否则确认；L2 一律确认。同 state 哈希缓存。
- Jev 挂了 / 超时 >1.5s / 用户关了「Jev 上云」：退到纯静态策略，静态 L0 自动放行，其余全部人工确认。
- PoC 测误报：被动标注（Jev 拦下 → 用户放行 = 误报候选）+ 主动集（150 条真实步骤 + 30 条对抗样本，含文件/网页里塞 prompt injection）。

## F. 执行路由与 agent loop

- daemon 侧能力注册表 + 模型 tool calling 选工具；不让模型输出「这步是 CLI 还是 GUI」的标签。
- 工具集：`shell.run{cmd,cwd,timeout}`、`applescript.run`、`jxa.run`、`shortcuts.run{name,input}`、`fs.list/read`（限白名单目录）、`gui.*` = **cua-driver 的 MCP 工具原样透传**（brain 用 Vercel AI SDK 的 MCP 客户端连 `cua-driver mcp` stdio，再经我们自己的白名单过滤，默认只放 cua 官方那 13 个 + `screenshot`；`delivery_mode: background`），M1 加 `app.<能力>`（见 H 节）。每个工具声明：静态等级、作用域要求、成本级别、**数据外发标记**（比如 `applescript.run` 读到的邮件正文会进模型上下文，UI 要能显示）。
- 系统提示写死优先级「shell > applescript > shortcuts > gui」，gui 前先 `get_window_state` 拿 AX 元素 token。
- Loop：先出草案计划，再逐步 ReAct 执行；新增步骤照样过 Jev；硬上限 25 步 / 单次 credit 预算。
- 模型适配层：`provider` 抽象带 `{tier: standard|zdr|byok|local, vision: bool}`；GUI 步骤只路由给 `vision: true` 的模型，本地文本模型 + gui 工具时提示用户换模型或改走 OmniParser 式的结构化描述。
- **GUI 默认路径 = 大脑直接调 cua-driver 的 MCP 工具**（云端 Claude / GPT，或本地 Muse Glimmer / Qwen3.8 这类通用 agent 模型，一条代码路径），每个 gui 工具调用单独过 Jev（state 里是 `{app, tool, 参数, 目标 AX 元素}` 文本）。系统提示写死 cua 的三条省 token 规则：先 `get_window_state(max_elements=25, max_depth=3)` 再动手、能用 `invoke_menu` / `hotkey` 就不点坐标、连续输入合并成一次 `type_text`。
- **可选路径：专用 GUI 模型子循环**。用户在「高级」里选了 GUI 模型（Holo3 / UI-Mate / UI-TARS-1.5，见 N 节）时，注册表多一个高层工具 `gui.task{goal, app}`；brain 里的 `GuiExecutor` 接手，循环「截图 → GUI 模型出一个动作 → 映射到 cua-driver 工具执行 → 再截图」，直到 finished / call_user 或步数上限（默认 15），每个动作同样过 Jev。这条路给「专用模型比通用模型强」的可能性留口子，是否默认露出由 PoC 数据定。
- **cua-driver 的 `bounded` 权限模式是作用域白名单的强制层**：daemon 启动 cua-driver 时把用户设置的「允许操作的应用」编成能力清单传给它（环境变量，启动时定死；改设置要重启 cua-driver 子进程），brain 侧的白名单只是第一道，cua-driver 侧是第二道。
- CLI 覆盖率 = 非 gui 工具步数 / 总步数，另记「整次任务零 GUI 完成率」。

## N. 本地 computer use 模型：Cua 的 Muse Glimmer 路线 + 专用 GUI 模型对比

**Cua 官方怎么本地跑（已读 trycua/cua `docs/.../driver/run-with-local-model.mdx`，2026-08-10）**

- Cua 没有自己的模型；cua-driver 只是「手和眼」（MCP 工具），大脑由外面接。官方文档验证过的本地大脑是 **Meta Muse Glimmer 30B**，harness 是 Claude Code：
  - Ollama：`ollama pull muse-glimmer:30b-mlx` → `ollama launch claude --model muse-glimmer:30b-mlx -- --bare --strict-mcp-config --mcp-config ./muse-cua-mcp.json --tools ""`
  - llama.cpp：`llama-server --hf-repo "unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL" --ctx-size 131072 --jinja --mmproj-auto`（给 Anthropic 兼容端点）+ Claude Code
  - 工具只暴露 13 个：`cua-mcp-filter --allow start_session,end_session,launch_app,list_apps,list_windows,get_window_state,get_accessibility_tree,move_cursor,click,type_text,press_key,hotkey,invoke_menu`
- 官方实测（Calculator 算 2+3）：**不做上下文控制时 71,088 输入 token / 660 秒；过滤工具 + `get_window_state max_elements=25 max_depth=3` + 批量 `type_text` 后 12,251 token / 224 秒**。本地 GUI 就是这么慢，PoC 的预期要按这个数量级定，不是几秒。
- 这三条上下文控制规则（小工具集、限制 AX 树大小、把连续按键合并成一次 `type_text`）直接写进我们的 brain 系统提示和工具白名单，对云端模型同样省钱。

**Muse Glimmer 30B 事实（已读 HF 模型卡 `meta-models/Muse-Glimmer-30B`）**

| 项目 | 结论 |
|---|---|
| 许可 / 体量 | Apache-2.0；稠密 29.6B（含 1.8B 视觉编码器）；131k 上下文 |
| 能力 | 原生 tool calling + 图片输入 + 可调推理强度（系统提示里写 `Reasoning strength: low/medium/high/xhigh`）；是**通用 agent 模型**，能同时写 shell、调工具、看截图点坐标 |
| Mac 上跑 | 4-bit 不到 20GB，24/32GB 机器能跑；DFlash 投机解码在 M5 Max 上 26.6→50.2 tok/s；Ollama 有 `muse-glimmer:30b-mlx`，LM Studio / llama.cpp 用 unsloth GGUF |
| 采样 | temp 1.0 / top_p 0.95 / top_k 64（模型卡推荐，别用 0 温度） |
| 分数 | OSWorld-Verified **65.9**、ScreenSpot Pro 75.4、SWE-Bench Verified 76.0、Terminal-Bench 2.1 51.7、MCP Atlas 75.5 |
| 对比（Meta 自己表里的数字） | Qwen3.6-27B thinking OSWorld-Verified **75.6**、Gemma4-31B 58.5。也就是说 Qwen3.6/3.8-27B 在这个榜上可能比 Muse 更强，但 cua 只在 Muse 上跑通过，Qwen 走 cua-driver MCP 没人验证过 |

**两类模型，两种用法**

| 类别 | 例子 | 能干什么 | 怎么接 |
|---|---|---|---|
| (a) 通用 agent 模型 | **Muse Glimmer 30B**（cua 验证过）、**Qwen3.8-27B / Qwen3.6-27B**（分数更高，待验证）、Gemma4-31B | 一个模型包办整个大脑：规划、调 shell / applescript 工具、调 cua-driver MCP 工具、看截图 | 走 tool calling，和云端 Claude / GPT 完全同一条代码路径，只是 provider 换成 Ollama（Anthropic 兼容）或 LM Studio / llama.cpp（OpenAI 兼容） |
| (b) 专用 GUI 模型 | Holo3-35B-A3B（OSWorld-Verified 77.8）、UI-Mate-27B（77.0）/ 9B、UI-TARS-1.5-7B（27.4）、OpenCUA-32B（34.8） | 只会「看截图 → 出一个动作和坐标」，不会调工具、不会写 shell | 要一个 `GuiExecutor` 子循环 + 每家一个 `GuiModelAdapter`（prompt + parser + 坐标换算），由规划模型通过 `gui.task` 委托 |

专用 GUI 模型的事实（UI-TARS 只有 1.5-7B 开源、UI-TARS-2 无权重、`Thought/Action` 契约与 smart_resize 坐标换算；Holo3 / UI-Mate / OpenCUA 的许可、体量、分数）见修订 2 保留的下表：

| 模型 | 许可 | 体量 / 4-bit 大小 | OSWorld-Verified | 备注 |
|---|---|---|---|---|
| Holo3-35B-A3B（H Company，2026-03-31） | Apache-2.0 | MoE 35B 总 / 3B 激活，约 20GB | 77.8（模型卡；第三方榜单 82.6） | Qwen3.5-35B-A3B 微调；3B 激活所以快 |
| UI-Mate-27B / 9B（腾讯，2026-08-14） | Apache-2.0 | 稠密 27B，MLX 4-bit 17.7GB；9B 约 6GB | 27B：77.0 | Qwen3.6-27B 微调；要用腾讯自己的 prompt + parser |
| OpenCUA-32B / 7B（xlang） | MIT | 32B / 7B | 34.8 / 26.6 | grounding 强（ScreenSpot-Pro 55.3） |
| UI-TARS-1.5-7B | Apache-2.0 | 7B，约 4GB | 27.4 | 最小最省；坐标是 smart_resize（factor 28）后图像空间的绝对像素；UI-TARS-desktop 的 `action-parser` 可移植 |

以上分数都来自模型卡和榜单，没有人在 macOS 真实应用上验证过（MacArena 论文指出模型在 macOS 原生任务上明显比 Linux 差）。**PoC 必须自己测。**

**选型决定**

1. **「全本地」默认 = 一个通用 agent 模型当整个大脑**，不再默认拆「规划模型 + GUI 模型」两槽。理由：Muse Glimmer 是 cua 官方唯一验证过的本地路线，一个模型走 tool calling 就能覆盖 shell / applescript / cua-driver 全部工具，代码路径和云端模型完全一样，没有额外的 prompt / parser / 坐标换算要维护。
2. **默认候选两个都测，PoC 后定一个**：Muse Glimmer 30B（cua 验证过、有 DFlash 加速、Ollama 一条命令）vs Qwen3.8-27B（榜单更高、LM Studio 已装好就能用）。128GB 机器两个同时加载没问题；16GB 机器两个都跑不了，退到 Qwen3.5-9B 这类小模型 + 只开 CLI / AppleScript 工具。
3. **专用 GUI 模型降为可选「GUI 模型」槽位**：UI 里默认隐藏，在「高级」里打开后才出现第二个下拉框，选了就启用 `gui.task` → `GuiExecutor` 子循环。适配器顺序：`generic-vision`（通用模型走 tool calling，M0 必做，其实就是路线 (a) 的复用）→ `holo3`（M0 stretch）→ `uimate` / `uitars15`（M1 按需）。用途是给「通用模型在 macOS GUI 上不行、但专用模型行」这个可能性留口子，PoC 的对比数据决定它要不要在 M1 露出。
4. **不用 UI-TARS-desktop 的 SDK、不用 cua-agent（Python）**：前者绑 Electron + nut.js，后者是 cua 的旧一代 Python 适配器集合（`huggingface-local` / `mlx` / `omniparser` / `<grounder>+<planner>` 组合），只借它们的 prompt、parser、坐标换算和「grounder + planner」拆分思路。
5. PoC 第五个数字改为：**Muse Glimmer 30B 和 Qwen3.8-27B 在 10 条 macOS GUI 任务上的成功率、每步延迟、每任务输入 token**（M5 Max，先复现 cua 的 Calculator 2+3 基线，再跑我们的 10 条），加一组 Holo3（若 D3 完成）对照。

**风险**

- 本地 GUI 每步截图 + AX 树的 prefill 是大头，cua 实测 224 秒完成一个计算器任务；用户体感会很差，UI 必须一开始就显示「本地模型，预计几分钟」并允许中途切云端。
- Ollama 的 Anthropic 兼容端点和 LM Studio 的 OpenAI 兼容端点对图片 + tool calling 的支持程度不一样，M0 第一周就要各跑通一次，不行就退到 llama.cpp `llama-server`。
- Qwen3.8-27B 走 cua-driver MCP 工具无人验证；若 tool calling 格式不稳，Muse 就是唯一默认。
- 专用 GUI 模型如果 PoC 显示明显强于通用模型，M1 的默认就得变回两槽，届时 D3 升为必做。

## G. 远程终端：配对设备终端 + 完整 SSH 客户端

**配对设备终端**（M1）
- daemon：`forkpty` 起登录 shell，`TERM=xterm-256color`，开终端 = L2（会话级 Face ID）。流经 hub 中继 + 端到端加密，M3 加局域网直连降延迟。
- iOS：SwiftTerm（MIT）渲染；libghostty 等稳定 iOS 发布再换。扩展键盘条（Esc / Tab / Ctrl / Alt / 方向 / 常用符号，可自定义）用 inputAccessoryView。
- AI 生成命令：同一个大脑的「terminal 模式」，只有 `propose_command` 工具、不执行，结果填进输入行由用户回车；可以选「解释这段输出」「修这个报错」。用户自己敲的命令不过 Jev；「AI 建议并自动运行」才过 Jev。
- 终端会话是一条活动记录；M3 用 OSC 133 把命令切成步骤。

**SSH 客户端**（主机列表 + 密钥 M1；SFTP、FIDO2、端口转发 M2）
- 库：Citadel（基于 swift-nio-ssh，rootshell 在用）。手机直连目标主机，不经 hub。
- 主机列表：地址、端口、用户、认证方式、跳板机、标签、颜色；可从 `~/.ssh/config` 导入（通过配对 Mac 的 `fs.read`）。
- 密钥管理：生成 ed25519 / 导入；私钥存 Keychain（`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`），可选 Secure Enclave（P-256，签名时 Face ID）；iCloud Keychain 同步可选；一键把公钥装到主机（`ssh-copy-id` 等价）。FIDO2 / 硬件密钥（`sk-ssh-ed25519`）M2。
- Snippets 和快捷指令合成一个模型 `{name, steps|command, level, runIn: agent|terminal|ssh:<hostId>}`，在终端里是键盘条上的 chips。
- SFTP（M2）：文件浏览器，上传/下载/预览，和配对设备的 `fs.*` 文件浏览器共用同一套 UI。
- 解锁：app 打开 / 连接主机时 Face ID；FIDO2 作为主机认证方式 M2。
- 一键连接：主机卡片点一下直接进；支持多标签会话、后台保活（iOS 后台限制下用推送 + 会话恢复，说清楚做不到 mosh 级别）。
- **不经 hub**：SSH 流量手机直连主机，hub 完全不知道你连了谁；主机列表默认只存本机 + iCloud Keychain。

## H. 「学习应用」：保留「索引应用 → 在手机上生成界面」，M1 上

- 保留设计师的完整概念：daemon 探索应用 → 列出能力清单 → Jev 分级 → 用户确认 → 手机上出现这个应用的原生操作界面。
- 探索数据源分两层，UI 上区分：
  - **只读层（L0，自动）**：`sdef` 脚本字典（Mail / Finder / Music / Safari 都有，结构化）、菜单栏 AX 树（一级不用展开就能读）、主窗口 AX 树、应用的 Shortcuts 动作。
  - **探索层（需要点击，标出来）**：展开子菜单、打开面板读控件。Cua Driver 后台交付，不抢焦点，但会真的点，所以要用户点「开始探索」并可随时停。
- 模型把清单总结成**能力卡片**，控件类型：按钮、输入→按钮、列表（数据源是一段 AppleScript / JXA 查询，比如收件箱）、开关、选择器、表单（多字段）。卡片 = 存储的带参数快捷指令，每次执行照样过 Jev。
- 生成的界面是**数据驱动的 SwiftUI**（卡片 JSON → 原生控件），不是网页；用户可以改名、隐藏、重排、补描述，改动只存本机。
- Electron / 沙盒 app 只有 AX，卡片会弱，UI 诚实标「仅 GUI」；微信这类可以接 wx-cli-again 式的只读适配器当列表数据源（发消息仍走 GUI）。
- 名字建议叫「学习这个应用」。

## I. 设计稿要改的地方与信息架构

- **Compose 按钮用 `tabViewBottomAccessory`，不用 `Tab(role: .search)`**：search 角色一点开就把 tab 栏变成搜索框；底部 accessory 跨 tab 常驻、能显示「1 个操作等待确认」、随 `tabBarMinimizeBehavior(.onScrollDown)` 收起。
- **实时画面**：M1 做「详情页打开时 1fps JPEG 缩略图」（首页「3 秒前回传」改成按需）；M3 做 H.264（VideoToolbox → `AVSampleBufferDisplayLayer`，300-800kbps，5-15fps 自适应）+ 局域网直连。设计稿的 12fps/92ms 只在局域网成立，UI 上换成实测值。
- **「不可检测」措辞**：写「对被控应用来说就是一套真实的 USB 键鼠，不需要越狱、不装辅助功能框架、不在 iPad 上运行自动化」。不写「任何应用都检测不到」。
- **控制方式**：Jev 阈值滑杆换三档预设（谨慎 / 平衡 / 放手），数值在高级设置；审批卡片必须显示具体将执行的命令 / 脚本 / 元素 + 「仅这次 / 以后自动」；Compose sheet 加设备选择和「在终端里跑」切换；「应用」页里的 CPU / 内存收进设备详情。
- **隐私页**：新增「我的 → 隐私」（B 节的「数据去哪了」视图 + 三档预设 + 逐项开关）；模型选择页每个模型带 标准 / ZDR / 自带 key / 本地 标签，Fable 5.1 标「不支持 ZDR」。
- **建议 tab 结构**：`设备 / 应用 / 终端 / 活动 / 我的` + 底部 accessory「✨ 让 Mac 做一件事」。「应用」保留（承载 H 节的学习应用）；终端 tab = 配对设备终端 + SSH 主机列表；快捷指令 / Snippets 在 compose sheet 和终端键盘条里是 chips，在「我的」里统一管理。
- Liquid Glass 用系统件：`TabView` + `tabBarMinimizeBehavior` + `tabViewBottomAccessory`、`NavigationStack` 工具栏、iOS 26 sheet 默认玻璃背景；自定义卡片用 `glassEffect(_:in:)` + `GlassEffectContainer`，按钮 `.buttonStyle(.glass / .glassProminent)`。

## J. iPad dongle（M2）与 Android（M4）

- iPad：复用 ipad_computer_use（MIT）的 RP2040 固件 + 校准；CuaRemote iPad app 的广播扩展 = 截屏 + HID 中转（改成我们的协议）；大脑按 B 节选：借同一局域网的 Mac、或云端。产品化考虑 ESP32-S3（原生 USB + Wi-Fi，dongle 自己连 hub / Mac 收 HID 指令，iPad app 只管截屏）。研究项：绝对坐标 HID 描述符能否免校准（上游没试过，花一天试）。风险：ReplayKit 每次要用户手动点「开始」，无人值守做不到；扩展 50MB 内存上限；iPhone 要开 AssistiveTouch；要采购板子。
- Android 两阶段：先「adb 经 Mac」（Mac daemon 加 android 执行目标，`adb exec-out screencap` + `input tap/swipe` + `uiautomator dump`，无线调试配对码，手机上不装东西）；再 AccessibilityService app（Play 要 `isAccessibilityTool` 声明 + 显著披露）。Android 被控同样没有本地大脑，按 B 节处理。

## K. 仓库结构与开源边界

```
ReVolae/                        (公开，AGPL-3.0 + CLA)
  apps/daemon-macos/            Swift Package + Xcode 工程 → CuaRemote.app（含 cuaremote CLI target）  [M1]
  apps/hub/                     Bun/TS：中继、认证、模型网关（标准 / ZDR 两组账号）、推送、配对撮合、云端大脑宿主  [M1]
  apps/poc-web/                 M0 手机网页（一次性）
  packages/brain/               TS：规划器、工具注册表、模型适配层、Jev 客户端、策略引擎（本地 sidecar 和 hub 共用）
  packages/protocol/            zod + JSON Schema + Swift Codable   ← MIT/Apache，方便第三方实现客户端
  packages/jev-eval/            标注集 + 评测脚本（Python/uv）
  firmware/dongle/              M2
  docs/
cuaremote-ios/                  (私有仓库) iOS/iPadOS app（含 SSH 客户端），通过 git URL 引用 protocol 的 Swift 包
```

- iOS app 单独私仓：闭源、含签名 / Fastlane 秘密。只依赖 `protocol`（宽松许可），不链接 AGPL 的 Swift 代码。
- CI 最小集：ubuntu `bun install && bun test && tsc --noEmit`（M0 起）；macOS runner `swift build && swift test`（M1 起）。

## L. 里程碑

- **M0 PoC（2-3 周）**：见 M 节。
- **M1 Mac MVP（4-6 周）**：Swift 宿主 + 嵌入 cua-driver；hub 上云（中继 + 云端大脑两种模式）；端到端加密 + 配对；iOS app：设备 / 应用（学习应用）/ 终端（配对设备终端 + SSH 主机列表 + 密钥）/ 活动 / 我的（隐私页、模型档位）；Face ID 审批；开源。
- **M2 iPad + 终端进阶（4-6 周）**：dongle 方案移植与校准；SFTP、FIDO2、端口转发、`~/.ssh/config` 导入；iPad 被控的大脑选择 UI。
- **M3 产品化（4-8 周）**：语音输入；密文历史同步；H.264 实时画面 + 局域网直连；OSC 133 终端分块；JOC 计费 + ZDR 账号签约；App Store 上架。
- **M4 Android**：adb 经 Mac → AccessibilityService app；Android 控制端。

## M. M0 PoC 切片（2-3 周）

最薄路径：手机 Safari 网页（同 Wi-Fi）→ bun 进程（网页 + WS + 大脑 + 工具）→ 标准安装的 CuaDriver.app（走它自己的 TCC，不用嵌入）→ 结果回网页。零云端、零 Swift、零签名。M0 写的 `brain` 就是 M1/M3 用的 `brain`，只有网页是一次性的。M0 就把模型适配层做成三档（Claude、OpenAI、本地：Ollama 的 Anthropic 兼容端点 + LM Studio 的 OpenAI 兼容端点），因为「本地模型能不能干活」是 PoC 要回答的第四个数字。GUI 全部走 `cua-driver mcp`，brain 是 MCP 客户端。

- **Week 1「无手机也能跑」**：todo A–D。验收：10 条固定意图从命令行端到端跑通，JSONL 日志能算出每条成本；切到 LM Studio 后同样 10 条至少跑通 CLI 类。
- **Week 2「Jev + 手机审批」**：todo E–F。验收：一条含 L2 步骤的任务在手机上暂停 → 点确认 → 继续；Jev 超时降级路径可演示；网页上切换模型档位立即生效。
- **Week 3「回答五个数字」**：todo D2、G（D3 有余力再做）。验收：报告里有 P50/P95 成本与延迟、CLI 覆盖率、Jev 误报/漏报、本地模型成功率、Muse vs Qwen3.8 的 GUI 成功率 / 每步延迟 / 每任务 token。

每步记录：模型 tokens in/out、模型延迟、Jev 延迟/判定、通道、工具延迟、成败、重试、人工决定、provider 档位。成本 = tokens×单价 + Jev + 分摊；P50/P95 按「单次任务」和「单步」各算。误报 = Jev 拦下且用户放行 / Jev 拦下总数。

Sol 要提前手动做的（todo P）：
1. 跑 cua 官方安装脚本装 CuaDriver.app，给辅助功能 + 录屏权限，`cua-driver call check_permissions '{}'` 确认；再跑一次 `cua-driver mcp` 确认能起来。可选：按 cua 文档用 Claude Code + Muse 先手动复现一次 Calculator 2+3，作为我们 brain 的基线对照。
2. 给 Ghostty/Terminal 授 Automation 权限（手动跑一次 `osascript -e 'tell application "Finder" to get name'` 把弹窗点掉）。
3. 环境变量：ANTHROPIC_API_KEY / OPENAI_API_KEY / TYPESAFE_API_KEY（现在只有 KIMI）。
4. 本地模型两条线都备好：(a) `brew install ollama` 后 `ollama pull muse-glimmer:30b-mlx`（约 20GB），确认 `http://localhost:11434/v1` 能回；(b) LM Studio 里下 `Qwen/Qwen3.8-27B`（MLX 4-bit 约 17GB）并开本地服务器 `localhost:1234`。可选（D3 stretch）：`Hcompany/Holo3-35B-A3B`（MLX 4-bit 约 20GB）。128GB 内存同时加载没问题。UI-Mate / UI-TARS-1.5 M0 不装。
5. 准备测试目录（如 `~/cuaremote-sandbox`）或测试用 macOS 账户，基准集里有删除、发送，别拿主账户试。
6. 建 2-3 个测试 Shortcuts。
7. M0 不需要：Tailscale、iOS 证书、XIAO 板、Telegram。

## 验证

- `bun test`（packages/protocol schema 往返、策略引擎阈值、工具注册表作用域检查、provider 档位路由）；`tsc --noEmit`。
- 命令行冒烟：`cuaremote run "列出桌面上的 pdf"`（L0，shell）、`cuaremote run "把 ~/cuaremote-sandbox/a.txt 改名为 b.txt"`（L1）、`cuaremote run "在 Music 里播放 Nights"`（AppleScript）、`cuaremote run "在系统设置里打开蓝牙面板并截图"`（gui 兜底）；预期每条输出步骤时间线 + JSONL 日志。同样 4 条加 `--provider local` 再跑一遍。
- 手机冒烟：iPhone Safari 打开 `http://<mac>.local:8787`，输入含 `sudo` 或删除的意图，预期时间线在该步暂停显示具体命令，点「确认」后继续到完成。
- 本地模式不外发：`--provider local --jev off` 时用 `tcpdump -i en0 'not host <mac>.local'`（或 Little Snitch）跑一条任务，预期除 LM Studio 本地回环外没有出站连接。
- Jev 降级：把 `TYPESAFE_API_KEY` 设成错的或断网，预期 L0 步骤照常放行、其余全部要求确认，日志标 `jev: fallback`。
- 本地单模型 GUI：`cuaremote run "打开计算器算 2+3 并告诉我结果" --provider ollama:muse-glimmer:30b-mlx`，再换 `--provider lmstudio:qwen3.8-27b`，预期两个都通过 cua-driver MCP 工具完成并回答 5，日志里每个 gui 工具调用有 `tool`、`args`、`stepMs`、输入 token；整任务输入 token 应在 cua 基线（12,251）的 2 倍以内，超出就说明省 token 规则没生效。
- cua-driver 白名单：brain 启动时列出的 MCP 工具应只有白名单里的（默认 14 个），调用白名单外的工具名（比如 `history_query`）预期被 brain 拒绝并记日志；cua-driver 以 `bounded` 模式启动时，对作用域外应用调 `launch_app` 预期 cua-driver 侧报错而不是执行。
- 专用 GUI 模型（仅当 D3 完成）：`cuaremote run "在系统设置里打开蓝牙面板并截图" --provider local --gui-model holo3`，预期输出动作序列并完成，日志里每个动作有 `guiModel`、`stepMs`、解析出的坐标和实际点击的 AX 元素名；解析失败要报 `parse_error` 而不是乱点。
- 坐标换算单测（仅当 D3 做到 uitars15）：给 `uitars15` 适配器一张 2560×1600 截图和模型原文 `click(start_box='<|box_start|>(500,300)<|box_end|>')`，预期换算结果等于用 smart_resize（factor 28）算出的归一坐标乘回 2560×1600，误差 ≤1 像素；同一输入喂给 1.0 契约（0-1000 归一）应得到不同结果，证明两种换算没混。
- 基准报告：`uv run packages/jev-eval/report.py` 输出 P50/P95、覆盖率、误报/漏报、本地模型成功率、Muse vs Qwen3.8 GUI 成功率与每步延迟 / 每任务 token 表。

## 假设与默认值

- 隐私三个维度的**默认值**取「平衡」预设：本地大脑 + ZDR 模型 + Jev 开 + 同步关。用户可改任意一项；iPad / Android 被控时默认「借局域网 Mac 的大脑」，没有 Mac 就提示选云端大脑。
- ZDR 档位在 M3 之前只有「自带 key」能真正做到（hub 的 ZDR 账号要项目方去和 OpenAI / Anthropic 签约，M3 做）；M0/M1 的 UI 先把档位标签做出来，hub 的 ZDR 通道标「即将支持」。
- M1 用户默认「自己和朋友」：TestFlight + BYOK，Developer ID 公证和 JOC 计费推到 M3。
- SSH 客户端在 iOS app 里，M1 出主机列表 + 密钥 + 连接 + 键盘条 + Snippets；SFTP / FIDO2 / 端口转发 M2。不做 mosh。
- 「学习应用」M1 上，卡片控件先做 6 种（按钮、输入→按钮、列表、开关、选择器、表单）。
- iPad M2 先做「自购板子 + 刷固件」的极客版；「不可检测」按 I 节口径写。
- M0 用标准安装的 CuaDriver.app + `cua-driver mcp`，不嵌入；嵌入放 M1 Swift 宿主（`EmbeddedCuaDriverHost`）。
- 明确不做：Telegram bot、Tailscale 集成、Windows/Linux 被控端、mosh。
- 退路：若 Vercel AI SDK 对某家模型 tool calling 不稳，brain 里的模型适配层换成直接调各家 SDK，工具注册表和策略引擎不受影响；若本地视觉模型 GUI 成功率太低，本地档位先只开 CLI / AppleScript 工具并在 UI 说明。
- 「全本地」默认是**一个通用 agent 模型当大脑**，候选 Muse Glimmer 30B（cua 验证过）和 Qwen3.8-27B（榜单更高、未验证），PoC 后定一个；专用 GUI 模型（Holo3 / UI-Mate / UI-TARS-1.5）是可选高级槽位，M0 只做 stretch，是否在 M1 露出看 PoC 对比数据。
- 修订 1：隐私从「替用户选本地大脑」改为三维度细选 + 「数据去哪了」页 + 三档预设，补 ZDR 与 Covered Model 事实、本地模型接法、Jev 上云独立开关；终端从「只连配对 Mac」改为完整 SSH 客户端（主机、密钥、Snippets、扩展键盘、SFTP、FIDO2）；「学习应用」从 M3 缩水版改回 M1 完整概念；tab 结构改为 设备 / 应用 / 终端 / 活动 / 我的；M0 加本地模型档位与「不外发」验证。
- 修订 2：补 UI-TARS 研究（只有 1.5-7B 开源、UI-TARS-2 无权重、输出契约与 smart_resize 坐标换算）和 2026 年本地 GUI 模型对比（Holo3-35B-A3B、UI-Mate-27B/9B、Qwen3.5/3.8、OpenCUA）；新增 N 节；F 节把 GUI 步骤改成「规划器 → gui.task → GuiExecutor 子循环 + 可插拔 GuiModelAdapter」；本地档位拆成「规划模型 + GUI 模型」两个槽位；UI-TARS-1.5-7B 降为 16GB 机器兜底，默认候选改为 Holo3；M0 新增 todo D2、todo P/G/验证加三个本地 GUI 模型的实测，PoC 从回答四个数字改为五个。
- 修订 3：纠正「本地 computer use 模型」所指——Cua 官方本地路线是 **Muse Glimmer 30B**（Ollama / llama.cpp + Claude Code + cua-mcp-filter 13 个工具），不是 UI-TARS；Cua 不出模型。N 节重写为「通用 agent 模型（Muse / Qwen3.8）独自当大脑」vs「专用 GUI 模型子循环」两类，「全本地」默认改为单模型、两槽降为可选高级项；cua-driver 对接从「Unix socket 行分隔 JSON」改为 **MCP over stdio**（`cua-driver mcp`），M1 嵌入用 `EmbeddedCuaDriverHost`，`bounded` 权限模式当作用域白名单第二道；吸收 cua 三条省 token 规则（小工具集、`get_window_state` 限 max_elements/max_depth、批量 type_text）；todo D2 改为本地单模型跑通 + 与 cua 基线对照，原 GUI 适配器改为 D3 stretch；todo P / G / 验证相应调整。
