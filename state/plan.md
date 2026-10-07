# Mission Plan

## 2026-09-21 当前执行：恢复原设计与完整产品

- 用户已批准 [.agents/plans/2026-09-21-cuaremote-product-completion.plan.md](../.agents/plans/2026-09-21-cuaremote-product-completion.plan.md)，并要求本次真实端到端测试、截图和视频。
- 该计划 todos 是本轮唯一进度来源；旧 M0–M4 的 DONE 不代表产品完成。
- 验收逐页记录在 [docs/product-acceptance.md](../docs/product-acceptance.md)。
- 本线程拥有 TS、消息生成、Android 和文档；现有 Mac 线程拥有原生源码及原生验证。通过文件工具同步，不能用 origin/main 覆盖未提交代码。

来源：spec.md（全部里程碑一次做完）。文件归属见 decisions.md「分工」。

## 2026-09-21 当前请求：真实 iPhone → Mac
- E1 — orb：真实设备模式（身份、配对、加密、模型执行、签名确认）；真实网络预检与拒绝不执行断言。
- E2 — sol-mac：补原生 iPhone 应用、Swift 加密/Keychain、Mac 启动入口，用独立模拟器跑 XCUITest 并检查截图。
- E3 — orb：两台同时在线的 GitHub macOS runner，其中一台运行 iPhone 模拟器；使用同一套真实宿主与 UI 测试。保存模型密钥到 GitHub 前取得单独批准。
- E4 — sol-mac：只读确认 VM 可行性与 CPU/内存/磁盘限制，不安装镜像、不更改主机设置。
- 本次不把旧 spec 的 SSH、iPad、Android、App Store 等未完成项目标成完成，也不以假页面替代。

## M0 PoC
- F0.1 monorepo 初始化 — orb — 无依赖
- F0.2 packages/protocol — orb — 依赖 F0.1；产出 Protocol.swift 供 runner 线程
- F0.3 brain 工具注册表 — orb — 依赖 F0.2
- F0.4 brain agent loop + providers + CLI — orb — 依赖 F0.3
- F0.5 Jev 客户端 + 策略引擎 — orb — 依赖 F0.2
- F0.5b jev-ax GUI 定位 — orb — 依赖 F0.3、F0.5
- F0.6 apps/poc-web — orb — 依赖 F0.4、F0.5
- F0.7 packages/jev-eval — orb — 依赖 F0.5
- F0.8 本地模型实测 — runner A — 依赖 F0.4 + Sol 装模型

## M1 Mac MVP
- F1.1 apps/hub — orb — 依赖 F0.2
- F1.2 E2E 加密 HPKE + 审批签名 — orb（TS）+ runner A/B（Swift 互通向量）— 依赖 F0.2
- F1.3 云端大脑模式 — orb — 依赖 F0.4、F1.1
- F1.4 apps/daemon-macos — runner A — 依赖 F0.2 Protocol.swift
- F1.5 apps/ios — runner B — 依赖 F0.2 Protocol.swift
- F1.6 学习应用 — orb（brain 侧探索 + 卡片 schema）+ runner B（SwiftUI 渲染）
- F1.7 终端 — runner A（PTY）+ runner B（SwiftTerm + Citadel）+ orb（协议 + terminal 模式）
- F1.8 开源材料 — orb

## M2 iPad + 终端进阶
- F2.1 firmware/dongle — orb
- F2.2 校准算法 — orb
- F2.3 brain iPad 执行目标 — orb
- F2.4 iOS iPad 被控模式 — runner B
- F2.5 SSH 进阶 — runner B（+ orb 的 fs 协议）

## M3 产品化
- F3.1 语音输入 — runner B
- F3.2 模型设置页 — runner B（UI）+ orb（provider 注册表）
- F3.3 密文历史同步 — orb（hub + brain）+ runner B
- F3.4 实时画面 H.264 + Bonjour — runner A/B + orb 协议
- F3.5 OSC 133 — runner A + orb
- F3.6 JOC 计费 — orb
- F3.7 App Store 材料 — runner B + orb

## M4 Android
- F4.1 daemon android 执行目标（adb）— orb（brain 工具）+ runner A（daemon 侧 adb 调用）
- F4.2 apps/android-daemon — orb
- F4.3 apps/android — orb
- F4.4 多设备管理 — orb（hub）+ runner B（UI）
