# Decisions

## 配置（spec.md frontmatter 解析结果）
auto_approve_plan: true（Sol 明确要求所有里程碑一次做完，不再等批准）
use_cross_review: true · use_rescue: true · adversarial_each_milestone: false · adversarial_final: true
use_test_agent: true · test_agent_backend: auto（orb 用 agent-browser；Swift/iOS 用 runner sol-mac 的 xcodebuild + simctl 截图）
max_parallel_features: 3

## 环境
- orb：Linux x64，bun / node / pnpm / python3 / uv / rg / agent-browser 已装；无 Swift、无 Android SDK（后者尝试安装 cmdline-tools 编译，失败则 UNSURE）。
- runner sol-mac：macOS 26.5 / M5 Max / 128GB；Xcode 26.6；iOS 26.5 模拟器；bun 1.3.9、swift 6.3.3；无 cua-driver / Ollama / Tailscale；Automation 权限未授；签名证书为空（只能模拟器）。
- 仓库 sol1560/ReVolae 为空仓库，工作目录 /home/user/workspace/repo，本地提交，不 push（用户未要求）。

## 分工
- orb（本线程）：packages/protocol、packages/brain、packages/jev-eval、apps/hub、apps/poc-web、firmware/dongle、apps/android-daemon、apps/android、docs。
- runner 线程 A（sol-mac）：apps/daemon-macos（Swift 宿主 App + cuaremote CLI）+ 本地模型实测 F0.8。
- runner 线程 B（sol-mac）：apps/ios（SwiftUI Liquid Glass、SSH 客户端、iPad 被控扩展），模拟器截图。
- 协议单一来源在 packages/protocol，生成 Protocol.swift 后上传给两条 runner 线程。runner 线程产出通过 download_thread_changes 收回 orb 合并提交。

## 规划决定（可否决）
1. iOS app 先放本 monorepo `apps/ios/`，不另开私仓（拆仓是 git 操作，随时可做）；它只依赖 MIT 的 protocol 包。
2. hub 存储用 bun:sqlite（零依赖、单机可跑），Postgres 留接口。
3. E2E 加密 TS 侧用 `@noble/ciphers` + `@noble/curves` 自实现 HPKE（RFC 9180，DHKEM X25519 + HKDF-SHA256 + ChaCha20-Poly1305），并生成测试向量交给 Swift CryptoKit 验证互通。
4. GUI 三条路：jev-ax（Jev 选元素，来自 Jev-cu）→ 通用模型看截图 → 专用 GUI 模型子循环（stretch）。
5. 本地模型默认候选 Muse Glimmer 30B（Ollama）与 Qwen3.8-27B（LM Studio）两个都测。
6. Android：apps/android-daemon 与 apps/android 用 Kotlin + Gradle Kotlin DSL，AGP 最新稳定版；orb 尝试装 SDK 编译。
7. 固件：RP2040 CircuitPython（复用 ipad_computer_use 思路），另写 ESP32-S3 设计文档。
8. 必须 Sol 亲手做的事一律进 blocked.md，代码做到「填 key / 点授权即可跑」。

## 参考项目结论
- trycua/cua：cua-driver 走 MCP stdio；本地模型官方路线 Muse Glimmer 30B；三条省 token 规则。
- Sac-Y/Jev-cu：Jev 选 AX 元素的 jev-ax 路线值得复用；其 done 先于 risk 的策略顺序、无分级、无 score、无恢复流程是反例。
- jamiepinheiro/ipad_computer_use：RP2040 HID + USB 网络 + 校准（详见 firmware/dongle/README）。
- rootshell / warp / Termius：SSH 客户端用 Citadel + SwiftTerm；键盘条、Snippets、主机列表。
