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
- F1.7 终端 [PENDING]
- F1.8 开源材料 [PENDING]

## M2 - iPad + 终端进阶 [RUNNING]
- F2.1 firmware [DONE] 已回收：ESP32-S3 TinyUSB NCM+HID+HTTP 主固件 + RP2040 CircuitPython 备用（未编译/未真机）· F2.2 校准 [DONE] firmware/dongle/calibration 单调分段线性拟合，4 测试，模拟 P95 0.72px · F2.3 brain iPad 工具 [DONE] packages/brain/src/ipad/ipad-host.ts：IpadHost 把 iPad app 的 6 个底层工具（screen/pointer/hid.macro/clipboard/calibration.get|put）包成 ipad.screenshot/tap/scroll/type/key/calibrate；校准 44 样本→fitCalibration→存回设备；指针预测+归零；宏分批≤128；ASCII 直敲/非 ASCII 剪贴板；host-mode 懒包装、云端大脑按 platform=ipados 包装；11 测试 · F2.4 iOS iPad 被控（runner B）[PENDING] · F2.5 SSH 进阶（runner B）[PENDING]

## M3 - 产品化 [PENDING]
- F3.1 语音（runner B）· F3.2 模型设置页 · F3.3 密文同步 · F3.4 实时画面 · F3.5 OSC 133 · F3.6 JOC 计费 · F3.7 App Store 材料 [PENDING]

## M4 - Android [RUNNING]
- F4.1 adb 工具 [PENDING]
- F4.2 android-daemon [DONE] 已回收：无障碍/MediaProjection/十个 android.* 工具/HPKE/审批验签（gradle test 在源线程通过；orb 无 JDK 未复跑）
- F4.3 android 控制端 [DONE-部分] Compose UI 全页面就位，但状态层还是本地假数据、未接真实 WebSocket/pair.request
- F4.4 多设备 [PENDING]
