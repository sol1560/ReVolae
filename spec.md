---
auto_approve_plan: true
use_cross_review: true
use_rescue: true
adversarial_each_milestone: false
adversarial_final: true
use_test_agent: true
test_agent_backend: auto
max_parallel_features: 3
---

# CuaRemote 全里程碑任务书

用户（Sol）要求：M0 到 M4 全部一次做完，不分阶段等批准。详细方案见 [.agents/plans/2026-09-19-cuaremote-architecture.plan.md](.agents/plans/2026-09-19-cuaremote-architecture.plan.md)（修订 3），本文件只写「做什么、验收什么」。方案文件里的决定（Swift 宿主 + TS 大脑、隐私三维度细选、完整 SSH 客户端、MCP 对接 cua-driver、本地单模型大脑等）视为已定。

执行环境：
- orb（Linux）：TypeScript / Python / 固件源码 / Android 源码 / 文档。不能编译 Swift。
- runner `sol-mac`（macOS 26.5、Xcode 26.6、iOS 26.5 模拟器）：Swift 宿主 App、iOS App、模拟器截图验证、本地模型实测。通过独立线程执行。
- 需要 Sol 亲手做的事（系统权限点击、API key、Apple 证书、买板子、App Store、ZDR 签约、JOC 计费密钥）不能自动完成，记入 `state/blocked.md`，代码侧要做到「填上 key / 点了授权就能跑」。

## 仓库布局（本仓库 sol1560/ReVolae，AGPL-3.0 + CLA）

```
packages/protocol/     zod 消息类型 + JSON Schema + 生成的 Swift Codable（MIT）
packages/brain/        TS 大脑：agent loop、工具注册表、模型适配层（Claude / OpenAI / Ollama / LM Studio）、Jev 客户端、策略引擎、cua-driver MCP 客户端、成本记账、CLI
packages/jev-eval/     基准集 + 评测脚本（Python/uv）
apps/hub/              Bun：WS 中继、配对撮合、设备认证、推送、计量、云端大脑宿主、JOC 计费对接
apps/poc-web/          M0 手机网页
apps/daemon-macos/     Swift：CuaRemote.app（LSUIElement 常驻、TCC、WS+E2E、PTY、SCStream、Keychain、spawn brain 与 cua-driver）+ cuaremote CLI
apps/ios/              SwiftUI iOS/iPadOS app（Liquid Glass；设备/应用/终端/活动/我的；SSH 客户端；Face ID 审批；语音；iPad 被控扩展）
apps/android-daemon/   Kotlin：AccessibilityService 被控端
apps/android/          Kotlin Compose：Android 控制端
firmware/dongle/       iPad dongle 固件（RP2040 CircuitPython，HID + USB 网络 + HTTP）与校准
docs/
```

## M0 PoC

- F0.1 monorepo 初始化：bun workspaces、LICENSE(AGPL-3.0)、CLA、README、GitHub Actions（bun test + tsc）。
- F0.2 `packages/protocol`：D 节全部消息类型（intent/run/plan/step/approval/terminal/media/stats/capabilities/privacy/pair/hello）、帧格式 `[u8 kind][u32 streamId][payload]` 编解码、JSON Schema 导出、Swift Codable 生成脚本。
- F0.3 `packages/brain` 工具注册表：shell.run / applescript.run / jxa.run / shortcuts.run / fs.list / fs.read / gui.*（cua-driver MCP 透传 + 白名单）；每个工具带静态等级 L0/L1/L2、作用域检查、成本级别、数据外发标记。
- F0.4 agent loop + 模型适配层：Vercel AI SDK，草案计划 → 逐步 tool calling；provider：anthropic / openai / ollama(anthropic 兼容) / lmstudio(openai 兼容)，各带隐私档位标签；25 步 / credit 上限；JSONL 日志；`cuaremote run "<意图>"` CLI；系统提示含 cua 三条省 token 规则。
- F0.5 Jev 客户端 + 策略引擎：三题并行（choice / noul / score），最终等级 = max(静态, Jev)，1.5s 超时或 Jev 关闭时退静态，同 state 哈希缓存。策略顺序必须是「风险 / 等级 / 白名单先于完成判断」（Jev-cu 的 `done` 先于 `risk` 是反例）。
- F0.5b `jev-ax` GUI 定位路线（吸收 Sac-Y/Jev-cu）：GUI 步骤先 `get_window_state(max_elements, max_depth)` 拿元素候选（≤40，去 URL、截 120 字）→ 一次 Jev 请求并行问 `target: choice(候选)`、`action: choice(click/set_value/type_text/press_key/scroll/wait/ask_user)`、`done: noul` → 本地门槛（目标置信度 <0.5 升级到视觉模型；`ask_user` / 敏感等级 → 确认）→ cua-driver 按元素 token 执行 → 重新观察。文本 / 按键 / 坐标由规划模型事先给出，Jev 只选不生成。GUI 三条路优先级：`jev-ax` → 通用模型看截图（云端或本地 Muse/Qwen）→ 专用 GUI 模型子循环。
- F0.6 `apps/poc-web`：bun 起 `:8787`，手机 Safari 打开，输意图、步骤时间线、审批按钮、模型档位切换，WS 推事件。
- F0.7 `packages/jev-eval`：50 条意图基准集、10 条 GUI 任务、150 条步骤标注 + 30 条对抗样本、报告脚本（P50/P95 成本延迟、CLI 覆盖率、Jev 误报漏报、本地模型成功率）。
- F0.8 本地单模型实测（runner）：Muse Glimmer 30B（Ollama）与 Qwen3.8-27B（LM Studio）跑 Calculator 2+3 与 CLI 任务，记录 token/耗时。依赖 Sol 装模型与 cua-driver 授权，装不上则 BLOCKED。

## M1 Mac MVP

- F1.1 `apps/hub`：Bun.serve WS 中继（路由头明文、payload 端到端密文）、设备密钥挑战应答、手机 JWT、配对撮合（二维码 secret + HMAC）、推送队列（APNs 抽象，无证书时 dry-run）、计量表、SQLite（bun:sqlite）；可选 Postgres。
- F1.2 端到端加密：TS 侧 HPKE（X25519 + ChaChaPoly，`@noble` 系或 WebCrypto）与 Swift CryptoKit HPKE 互通向量测试；审批签名 P-256 验签。
- F1.3 云端大脑模式：brain 在 hub 内运行，tools.call 经中继到 daemon；本地/云端同一份代码。
- F1.4 `apps/daemon-macos`（runner）：Swift Package + Xcode 工程；LSUIElement + SMAppService 常驻；`cuaremote setup / pair / status` CLI；WS 出站 + HPKE；spawn brain（bun 二进制）与 cua-driver（EmbeddedCuaDriverHost 或 `cua-driver mcp --direct`）；PTY（forkpty）+ 背压；SCStream 1fps JPEG 缩略图；IOKit 电池/网络/运行中应用；Keychain 存密钥；作用域白名单 → cua-driver bounded 能力清单；操作日志本地全量。
- F1.5 `apps/ios`（runner）：SwiftUI，iOS 26 Liquid Glass 系统件（TabView + tabBarMinimizeBehavior + tabViewBottomAccessory「让 Mac 做一件事」、NavigationStack、glassEffect）；tab 设备 / 应用 / 终端 / 活动 / 我的；扫码配对；意图输入 + 步骤时间线；审批卡片（显示具体命令 / 脚本 / 元素，仅这次 / 以后自动，Face ID = Secure Enclave 签名）；设备详情（缩略图、电池、网络、应用）；「我的 → 隐私」数据去哪了页 + 三档预设 + 逐项开关 + 模型档位标签（Fable 5.1 标不支持 ZDR）；操作历史；自定义快捷指令。
- F1.6 学习应用：daemon 侧 sdef / 菜单 AX / 主窗口 AX / Shortcuts 动作探索 → 能力清单 → 模型总结成能力卡片（6 种控件）→ 手机数据驱动 SwiftUI 渲染；每次执行过 Jev。
- F1.7 终端：daemon PTY 终端（开终端 = L2）；iOS SwiftTerm 渲染 + 扩展键盘条；AI「terminal 模式」propose_command；SSH 客户端（Citadel）：主机列表、ed25519 生成/导入、Keychain/Secure Enclave、一键连接、多标签、Snippets chips。
- F1.8 开源材料：README、架构文档、贡献指南、CLA、协议文档、安全模型文档。

## M2 iPad Computer Use + 终端进阶

- F2.1 `firmware/dongle`：RP2040 CircuitPython HID 键鼠 + USB 网络 + HTTP JSON 输入接口（参考 ipad_computer_use）；ESP32-S3 方案设计文档。
- F2.2 校准：相对增量 → 绝对坐标映射估算（TS 实现 + 单测，含 ipad_computer_use 的校准流程移植）；绝对坐标 HID 描述符实验记录。
- F2.3 brain iPad 执行目标：`ipad.screenshot / ipad.tap / ipad.type / ipad.key / ipad.swipe`，走 dongle HTTP + iPad app 截屏回传。
- F2.4 iOS app：iPad 被控模式（广播扩展截屏 + 上传；「无法在本机运行大脑」说明；借局域网 Mac 大脑 / 云端大脑选择）；控制端管理 iPad 设备。
- F2.5 SSH 进阶：SFTP 文件浏览器（与 fs.* 共用 UI）、FIDO2 / sk-ssh-ed25519、端口转发、`~/.ssh/config` 导入。

## M3 产品化

- F3.1 语音输入（iOS Speech / SFSpeechRecognizer，按住说话）。
- F3.2 多模型切换设置页（标准 / ZDR / 自带 key / 本地；本地大脑模型 + 可选 GUI 模型高级槽位）。
- F3.3 密文历史同步（手机侧密钥加密块 → hub 存储 → 多设备解密）。
- F3.4 实时画面：daemon H.264（VideoToolbox）+ iOS AVSampleBufferDisplayLayer；Bonjour 局域网直连。
- F3.5 OSC 133 终端分块。
- F3.6 JOC 计费对接：hub 调 justoneconnector credit 接口（无 key 时 mock），免费层配额，用量上报。
- F3.7 App Store 材料：隐私清单、截图脚本、Fastlane 配置（签名需 Sol）。

## M4 Android

- F4.1 Mac daemon 的 android 执行目标：adb（无线调试配对）screencap / input / uiautomator dump。
- F4.2 `apps/android-daemon`：AccessibilityService 被控端 + WS 客户端 + E2E 加密 + MediaProjection 截屏。
- F4.3 `apps/android`：Compose 控制端（意图、时间线、审批、生物识别）。
- F4.4 多设备管理：hub 一个控制端管多台被控；iOS / Android 控制端设备列表。

## 通用验收

- 每个 TS 包：`bun test` 通过、`tsc --noEmit` 干净。
- Swift：`xcodebuild build` 通过（macOS 与 iOS 模拟器），单测通过；iOS 关键页面模拟器截图存 `state/reports/screenshots/`。
- Python：`uv run pytest`。
- Android：`./gradlew assembleDebug`（orb 能装 SDK 则跑，否则记 UNSURE）。
- 端到端：poc-web / hub + brain + 模拟 daemon 跑通「意图 → 计划 → Jev → 执行 → 回传」含 L2 暂停确认；协议往返 TS↔Swift 向量一致。
