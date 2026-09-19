# Mission Progress

Status: RUNNING
Current: M1 - Mac MVP（F0.8 等 runner）

## M0 - PoC [RUNNING]
- F0.1 monorepo 初始化 [DONE]
- F0.2 packages/protocol [DONE]
- F0.3 brain 工具注册表 [DONE]
- F0.4 brain agent loop + providers + CLI [DONE]
- F0.5 Jev 客户端 + 策略引擎 [DONE]
- F0.5b jev-ax [DONE]
- F0.6 poc-web [DONE] 11 测试；orb 内已起 :8787 并截图验证
- F0.7 jev-eval [DONE] 已回收；uv run pytest 61 通过；报告 packages/jev-eval/reports/report.md（Jev 数字为 MOCK）
- F0.8 本地模型实测（runner A）[PENDING]
- Scrutiny: PENDING · Cross-review: PENDING · Probe: PENDING · UX: PENDING

## M1 - Mac MVP [RUNNING]
- F1.1 hub [DONE] apps/hub：Bun.serve WS 中继 + 公钥挑战登录 + 配对撮合（HMAC 端到端验）+ 6 位码 + 推送 dry-run/APNs + 用量 + bun:sqlite + 多账号 JWT；6 个集成测试
- F1.2 HPKE + 审批签名 [DONE] hpke.ts/approval.ts；RFC 9180 A.2.3 向量通过；Swift 互通向量 fixtures/hpke.json+approval.json；protocol 25 测试
- F1.3 云端大脑 [DONE] packages/brain/src/cloud/{cloud-brain,peer-links}.ts + host/relay-host.ts；apps/hub/src/cloud-brain.ts CloudBrainManager（brain:<account>，密钥落 brain_keys 表，hub.attachEndpoint 进程内挂载）；apps/hub/test/cloud-brain.test.ts 端到端（签名确认、拒无签名、拒重放、设备掉线）通过
- F1.4 daemon-macos（runner A）[PENDING]
- F1.5 ios（runner B）[PENDING]
- F1.6 学习应用（brain 侧）[DONE] packages/brain/src/learn/{learn,cards}.ts：四阶段 app.inventory → propose_cards → 校验（占位符/控件/来源/fromItem/等级只升）→ app.cards；runCard 走策略引擎且卡片等级为下限；转义 applescript/jxa/shell；host-mode 与云端大脑均接入（云端需 deviceId）；20 测试。daemon 侧 app.inventory/app.card.get 归 F1.4（runner）
- F1.7 终端 [DONE-orb 部分] 协议：terminal.open 带 signature（signTerminalOpen/verifyTerminalOpen，复用审批 challenge 格式：runId=terminal/stepId=sessionId/actionDetail=terminal.open，TTL≤300 s、nonce 记 1000）、terminal.opened 加 streamId（设备分配）；brain：packages/brain/src/terminal/{pty,session,manager}.ts —— BunPty（Bun.spawn terminal 真 PTY）、TerminalSession（16 KiB 分帧、256 KiB 窗口背压、迟到/超 sent ack 忽略、8 MiB 未确认断开并发 terminal_closed、退出时不等 ack 冲完再 terminal.exit、喂 Osc133Parser 发 terminal.block）、TerminalManager（open/resize/ack/close 路由、kind 1 帧按 streamId 写 PTY、terminal_exists/terminal_limit/terminal_spawn_failed/approval_invalid、CUAREMOTE_SESSION 环境变量、terminal.blocks 工具）；LocalBunHost({terminals}) 挂 terminal.blocks；21 测试（含 Linux 真 PTY：exit code、resize 后 stty size、close 触发 onExit）；docs「远程终端」节；schema/Swift 已重生成。Swift daemon forkpty + iOS 终端页（SwiftTerm）+ SSH 客户端归 runner；网页 PoC 不含终端
- F1.8 开源材料 [PENDING]

## M2 - iPad + 终端进阶 [RUNNING]
- F2.1 firmware [DONE] 已回收：ESP32-S3 TinyUSB NCM+HID+HTTP 主固件 + RP2040 CircuitPython 备用（未编译/未真机）· F2.2 校准 [DONE] firmware/dongle/calibration 单调分段线性拟合，4 测试，模拟 P95 0.72px · F2.3 brain iPad 工具 [DONE] packages/brain/src/ipad/ipad-host.ts：IpadHost 把 iPad app 的 6 个底层工具（screen/pointer/hid.macro/clipboard/calibration.get|put）包成 ipad.screenshot/tap/scroll/type/key/calibrate；校准 44 样本→fitCalibration→存回设备；指针预测+归零；宏分批≤128；ASCII 直敲/非 ASCII 剪贴板；host-mode 懒包装、云端大脑按 platform=ipados 包装；11 测试 · F2.4 iOS iPad 被控（runner B）[PENDING] · F2.5 SSH 进阶（runner B）[PENDING]

## M3 - 产品化 [RUNNING]
- F3.1 语音（runner B）[PENDING]
- F3.2 模型设置页 [DONE-orb 部分] 协议：PrivacySettings.cloudModel、ModelEntry、models.list / models.catalog；brain：packages/brain/src/llm/catalog.ts（BUILTIN_MODELS、listModels、probeLocal、tierAccepts、resolveProvider 选错抛错不降级、catalogMessage）；providers.ts 补 ANTHROPIC_ZDR / ZENMUX_ZDR；host-mode 与云端大脑的 intent/learn 都改走 resolveProvider 并响应 models.list；docs/protocol.md「模型设置」节；15 测试。设置页 UI 归 runner B
- F3.3 密文同步 [DONE-orb 部分] 协议：SyncKind/SyncBlob、sync.put/pull/page/delete（端↔hub）、sync.key（端到端分发密钥）；packages/protocol/src/sync.ts AES-256-GCM sealSync/openSync（AAD 绑 kind|id|deviceId|ts，5 测试）；hub：sync_blobs 表、按 ts 覆盖、seq 游标分页、unclaimed 拒、单块 64 KiB、每类 5000 配额只算新 id（2 端到端测试）；brain：packages/brain/src/sync/history-sync.ts HistorySync push/pull/disable/setKey（4 测试）；docs「云同步」节。Swift/Kotlin 端移植归 runner
- F3.5 OSC 133 命令块 [DONE-orb 部分] 协议：TerminalBlock（三个偏移量与 terminal.ack 同尺）、terminal.block 事件；brain：packages/brain/src/terminal/osc133.ts Osc133Parser（跨 chunk、BEL/ST、cmd= 或回显抠命令、OSC 7、字节级截尾、块数上限，7 测试）；loop 终端模式先调宿主 terminal.blocks（L0）把最近 5 条命令块放进上下文（1 测试）；shell-integration/cuaremote.{zsh,bash,fish}；docs「终端命令块」节；schema/Swift 已重生成。daemon Swift 解析 + terminal.blocks 工具 + iOS 按块渲染归 runner
- F3.6 JOC 计费 [DONE-orb 部分] apps/hub/src/billing.ts：CreditLedger 接口 + JocLedger（Bearer、余额/幂等扣款、409=已扣，路径可配）+ LocalLedger（hub credits 表）；Billing：自然月免费次数（默认 50）、免费层 1 台被控设备（只数配过对的）、usd×(1+30%)×100 credit 两位向上取整、run_billing 表按 runId 幂等预占/结算、余额查不到不放行、扣款失败下次重试；CloudBrain 加 billing 钩子（reserve 不过回 credits_exhausted 无 run.created，finally 里 settle 含断线）；hub 处理 billing.get / GET /api/billing / pair.request device_limit；协议 billing.get / billing.status；server 环境变量 HUB_BILLING/JOC_*/HUB_FREE_RUNS…；MockProvider 加 mock:paid 计价；6 测试（含端到端）；docs「计费」节。JOC 真实接口字段未核对（按最小假设写、可配）
- F3.4 实时画面 · F3.7 App Store 材料 [PENDING]

## M4 - Android [RUNNING]
- F4.1 adb 工具 [DONE-orb 部分] LocalBunHost 有 adb 时暴露底层 android.adb（sh -c、image 模式 sips 转 JPEG）；packages/brain/src/android/adb-host.ts AdbHost 把它包成与 Android daemon 同名同参的 10 个 android.* + android.devices（uiautomator XML 解析、index 中心点缓存、单台自动选 serial 缓存 30 s、set_text 仅 ASCII、包名校验、dumpsys 通知解析）；host-mode 链 wrapIfIpad→wrapIfAdb，云端大脑非 ipados 设备包 AdbHost；15 测试；docs「Android（adb 路径）」节。Swift 宿主的 android.adb 归 runner A；未真机验证
- F4.2 android-daemon [DONE] 已回收：无障碍/MediaProjection/十个 android.* 工具/HPKE/审批验签（gradle test 在源线程通过；orb 无 JDK 未复跑）
- F4.3 android 控制端 [DONE-部分] Compose UI 全页面就位，但状态层还是本地假数据、未接真实 WebSocket/pair.request
- F4.4 多设备 [DONE-orb 部分] 协议：DeviceSummary、devices.list/devices.page、device.rename、device.unpair、pair.removed；hub：devicesFor（配过对 ∪ 同账号，去自己和大脑，别名优先，排序）、device_aliases 表（按账号）、unpair 统一入口（WS 与 DELETE /api/pairings 都走，通知双方）、GET /api/devices 改用同一份；测试：一部手机配两台 Mac 各走各的密文通道、A↔B 未配对 not_paired、列表/别名/解绑/下线 lastSeen（hub.test 7/7）；docs「多设备管理」节；schema/Swift 已重生成。iOS/Android 设备列表页归 runner B / Android 线程
