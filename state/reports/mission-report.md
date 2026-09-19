# CuaRemote 任务报告（2026-09-19）

仓库 sol1560/ReVolae，本地 main 共 22 个提交，**没有 push**。

## 一句话结果

M0–M4 里所有能在 Linux orb 里做的部分都做完并本地提交了；所有必须在 Mac 上做的部分（Swift daemon、iOS app、本地模型实测、语音）一件都没做，因为 runner `sol-mac` 从 13:07 起一直离线，本轮结束时 `list_runners` 仍为空。

## 做完了什么（按里程碑）

| 里程碑 | orb 里做完 | 等 Mac |
|---|---|---|
| M0 PoC | 协议包（zod → JSON schema / Swift 生成）、大脑（agent loop、两种模型线格式、Jev 客户端 + 策略引擎、cua-driver MCP 白名单、jev-ax）、网页 PoC（已起服务并截图）、jev-eval 评测包 | F0.8 本地模型实测 |
| M1 Mac MVP | hub 中继（登录、配对、推送、SQLite）、HPKE 端到端加密 + 审批签名（RFC 9180 向量通过）、云端大脑、学习应用、远程终端（含本轮加固）、开源材料 + CI | Swift daemon（F1.4）、iOS app（F1.5） |
| M2 iPad | ESP32-S3 固件 + RP2040 备用、校准库、大脑 iPad 工具 | 板子未买、固件未编译 |
| M3 产品化 | 模型设置协议、密文历史同步、OSC 133 命令块、JOC 计费、实时画面帧格式 + Bonjour、App Store 材料 | 语音（F3.1）、iOS 页面 |
| M4 Android | 被控端 daemon、控制端 UI、共享协议库（Kotlin，源线程 gradle 通过）、adb 路径、多设备协议 | 控制端接真实 WebSocket、真机验收 |

代码量：247 个文件，TS 77 / Kotlin 19 / Swift 4 / Python 17 / C 6。

最后一次全量验证（本轮）：`bun test` 203 通过 / 19 文件；`bun run typecheck` 5 个包全过；`uv run --with pytest pytest -q` 6 通过；jev-eval 自己的 61 个 pytest 在源线程通过。

## 本轮做的事：终端安全加固

oracle 对抗审查找出 9 个问题，修了 8 个（提交 cf7150e）：

- 开终端的签名原来只绑 sessionId，同一部手机配对的另一台 Mac 能拿它开终端 → 现在绑 deviceId。
- 不配手机公钥时原来悄悄不验签 → 现在必须显式写 `unsafeUnsigned: true`，否则构造直接报错。
- sessionId 没校验、cwd 不存在要到 spawn 才失败且已经烧掉一次 Face ID 签名 → 都挪到验签前检查（`terminal_bad_session_id` / `terminal_bad_cwd`）。
- nonce 原来记最近 1000 个 → 按过期时间保留，宿主可以传 Map 持久化，daemon 重启后旧签名照样拒。
- streamId 重启后从 1 起会撞旧会话 → 按启动时刻取种子。
- 往链路写帧抛错会丢字节 → 直接关会话。
- shell 里 `trap '' HUP` 时 close 留孤儿 → 2 秒后 SIGKILL。

测试从 21 加到 29（真实重放、跨设备签名、trap HUP、nonce 持久化、sendFrame 抛错）。测试顺手抓到我自己写的一个 bug：时间种子把秒当毫秒除了 1000。

**没修的一个**：HPKE 握手没有接收方新鲜度，hub 理论上能把整段密文流重放给设备。要改线格式，记在 `state/discovered-issues.md`，留给下一轮协议改动统一做。

## 替你做的决定（可否决）

规划期的（在 `state/decisions.md`）：iOS app 先放 monorepo；hub 用 bun:sqlite；HPKE 用 noble 自实现；GUI 三条路 jev-ax → 通用模型 → 专用模型；本地模型候选 Muse Glimmer 30B + Qwen3.8-27B；Android 用 Kotlin/Gradle；不用 Vercel AI SDK、MCP 客户端自写；策略顺序与三档阈值；终端模式只给 L0 工具。

这几轮新增的：
- 终端：签名绑 deviceId；`unsafeUnsigned` 显式开关；sessionId 只许 `[A-Za-z0-9_-]{1,64}`；streamId 时间种子；SIGKILL 等 2 秒；终端不受作用域白名单约束（docs/security.md 已写明）。
- 实时画面：帧头 `[flags][pts u32][w u16][h u16]`；Bonjour TXT 只有 id/v/n；`media.info` 加必填 streamId。
- App Store：bundle id `dev.cuaremote.app`、分类、关键词、中英文文案全是占位。
- CI 工作流写了但没在 GitHub 跑过。
- Android：Gradle 9.6 / AGP 9.4 / Kotlin 2.4.20；BouncyCastle 做 HPKE；daemon 登录改签 `hubAuthPayload`（这处改动 orb 没 JDK 没复跑 gradle）。
- iPad dongle：主控 ESP32-S3 而不是 RP2040；固定地址 172.31.254.1/29；Unicode 走剪贴板 + Cmd+V。
- jev-eval：误报/漏报定义、mock 默认 4% 错误率。

## 卡住的（要你亲手做）

- **runner sol-mac 上线**：这一条卡住了 F0.8 / F1.4 / F1.5 / F2.4 / F2.5 / F3.1 全部。上线后按 `state/agent-jobs.md` 建线程 A（daemon-macos）和 B（ios），kit 在 `.amp/cuaremote-kit.tgz`（需重新打包）。
- Mac 上的辅助功能 / 录屏 / Automation 授权（弹窗只能人点）。
- ANTHROPIC / OPENAI / TYPESAFE 的 key（现在只有 KIMI）。
- Apple 开发者证书、真机、APNs 证书。
- iPad dongle 板子采购。
- Ollama / LM Studio 拉模型（约 40 GB）。
- ZDR 账号、JOC 计费密钥。
- 静态策略误报 6.8%（目标 < 5%），要改 `policy.ts`（解析 shell 引号、pip --target、金融子串只匹配 app/域名）。

## 可以看的东西

- 网页 PoC：https://t-03gwav8srej07odd2k232gxq6-p26004.onamp.dev/
- 截图：`.amp/in/artifacts/poc-web-approval.png`、`poc-web-done.png`
- 评测报告：`packages/jev-eval/reports/report.md`（Jev 数字是 MOCK）
- 文档：`docs/architecture.md`、`docs/security.md`、`docs/protocol.md`
