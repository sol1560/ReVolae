# CuaRemote

在手机上说一句话，让 Mac / iPad / Android 自己去做。不是远程桌面，是意图层：目标设备上的 agent 自己选 CLI、AppleScript、Shortcuts 还是 GUI 自动化（Cua Driver）去完成，每一步先经 Jev 安全预检，敏感操作推到手机上 Face ID 确认。同时它是一个完整的远程终端 / SSH 客户端。

模型无关、开源（AGPL-3.0 + CLA）、隐私由你逐项选择（大脑在哪 / 哪类数据上云 / 模型走标准、ZDR、自带 key 还是本地）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/protocol` | 消息类型（zod）+ JSON Schema + Swift Codable（MIT） |
| `packages/brain` | TypeScript 大脑：agent loop、工具注册表、模型适配层、Jev 预检、策略引擎、cua-driver MCP 客户端 |
| `packages/jev-eval` | 基准集与评测脚本（Python） |
| `packages/cloud-computer` | 云电脑：E2B 沙箱宿主、终端、快照 / 分叉 / 撤销、快捷命令卡、沙箱模板 |
| `packages/client` | 手机端通信库：登录、端到端加密链路、审批签名、终端、上传（MIT） |
| `apps/mobile` | Expo 手机 App（iOS）：云电脑、任务与审批、分叉挑选、文件、终端、RevenueCat 付费墙 |
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

## 云电脑（Shipaton 2026）

手机不连电脑也能干活：每个账号有一台只属于自己的 Linux 云电脑（E2B 沙箱），出现在设备列表第一位。

- **长期保留**：空闲 10 分钟自动暂停（文件和内存都在），下次调用约 0.2 秒唤醒。装过的工具、做过的文件一直在。
- **一句话干活**：「把这份 PDF 转成 Word」「剪掉视频前 10 秒」「做个落地页给我预览」——大脑在云电脑里跑命令，做完推下载按钮 / 预览链接到手机。
- **试 3 种做法**：把整台机器原样复制成 3 份（文件 + 内存 + 进程），每份按一种思路同时做，手机上左右滑着挑；挑中的那份成为你的云电脑，其余删掉。
- **整机撤销**：每个任务前自动存快照，做坏了一键回到任务之前。
- **放心放手**：沙箱里删改、装软件都不用确认；只有把数据发出去（git push、发请求）才要你 Face ID 签名，签名在执行端验证。
- **手机当电脑用**：文件浏览 / 上传 / 下载、真终端（xterm.js + 扩展键）、常用任务卡片。

### RevenueCat 怎么用

- 额度是 RevenueCat 的**虚拟货币 `CRD`**：App 里用 RevenueCat SDK 买额度包（Test Store），RevenueCat 自动给账号发 CRD。
- 每次云端任务结束，hub 按「模型成本 + 沙箱运行秒数」折算 CRD，用 Developer API v2 **在服务器端扣款**（`reference` = 任务 id，客户端无法伪造）。
- **`pro` 订阅权益**解锁「试 3 种」；hub 用 `active_entitlements` 判断，App 用 `CustomerInfo` 显示。
- **Webhook** 到达时 hub 清缓存并把新余额实时推给手机。
- RevenueCat 的 App User ID = hub 账号 id（由手机公钥派生，免注册）。

代码：[`apps/hub/src/billing.ts`](apps/hub/src/billing.ts)（`RevenueCatLedger`）、[`apps/hub/src/server.ts`](apps/hub/src/server.ts)（webhook）、[`apps/mobile/app/(tabs)/me.tsx`](apps/mobile/app/(tabs)/me.tsx)（付费墙）。

### 跑起来

```sh
bun install
# 1. 构建云电脑模板（一次）
E2B_API_KEY=... bun run packages/cloud-computer/template/build.ts
# 2. 启动 hub（云端大脑 + 云电脑 + 自助账号）
E2B_API_KEY=... ZENMUX_API_KEY=... HUB_JWT_SECRET=$(openssl rand -hex 16) HUB_SELF_ACCOUNTS=1 \
HUB_CLOUD_BRAIN_PROVIDER=zenmux:anthropic/claude-sonnet-5 \
REVENUECAT_SECRET_KEY=sk_... REVENUECAT_PROJECT_ID=proj... REVENUECAT_WEBHOOK_AUTH="Bearer ..." \
bun run apps/hub/src/server.ts
# 3. 手机 App（开发版，需要 Xcode 或 EAS）
cd apps/mobile && cp .env.example .env   # 填 EXPO_PUBLIC_HUB_URL 和 RevenueCat Test Store key
npx expo run:ios --device
```

不接 RevenueCat 时 hub 不计费；真实端到端（真 E2B + 真模型）：`bun run apps/hub/scripts/e2e-cloud.ts`，沙箱冒烟：`bun run packages/cloud-computer/scripts/smoke.ts`。

## 文档

- [docs/architecture.md](docs/architecture.md)：四层怎么接、一次意图怎么走、大脑放哪。
- [docs/protocol.md](docs/protocol.md)：消息格式、签名、加密、配对、终端、同步、计费。
- [docs/security.md](docs/security.md)：三级分级、预检顺序、数据去向、挡不住的事。
- [CONTRIBUTING.md](CONTRIBUTING.md)：环境、改协议的规矩、测试、PR。

## 现状

TypeScript 部分（协议、大脑、hub、网页原型、iPad 校准、Android adb 路径、终端）与 Android 端、dongle 固件已有代码和测试；Swift 的 Mac daemon 与 iOS app 目录尚空，等 macOS 机器上开工。各功能进度见 [state/progress.md](state/progress.md)。

## 许可

核心代码 AGPL-3.0-only，见 [LICENSE](LICENSE)；`packages/protocol` 为 MIT。贡献前请阅读 [CLA.md](CLA.md)。
