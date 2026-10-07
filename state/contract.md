# Acceptance Contract

## 2026-09-21 真实 iPhone → Mac 验收（覆盖本次请求）

### Programmatic
- 真实 hub、持久设备身份、HMAC 配对、HPKE 加密、真实模型及真实本地工具，不用旧 mock 测试替代。
- 手机请求读取仅存于 Mac 临时目录的随机内容；手机收到实际文件内容、执行步骤及最终结果。
- 写操作批准前不产生文件；签名批准后文件内容正确；拒绝操作不产生文件。
- iPhone 模拟器通过 XCUITest 操作真实界面；输出 xcresult、截图及宿主侧文件断言。
- 本地通过后再运行两个同时在线的 GitHub Actions macOS job：设备 job 保持服务，手机 job 使用 iPhone 模拟器发送请求，失败或超时必须使工作流失败。
- 缺少权限、服务或设备时记为 BLOCKED，不能跳过后报告成功。

### UX
- 检查连接、配对、执行结果和待确认/拒绝状态的实际模拟器截图。
- 本地使用独立模拟器，不占用现有模拟器；限制构建并行度。VM 只研究可行性和资源限制，不未经批准安装大型镜像或修改主机权限。

## M0 - PoC

### Programmatic
- `bun install && bun test && bun run typecheck` 在仓库根通过。
- `packages/protocol`：每个消息类型 zod 往返测试；帧编解码测试（kind 0/1/2、streamId 边界）；`bun run gen:swift` 生成 `Protocol.swift` 且 `bun run gen:schema` 生成 JSON Schema。
- `packages/brain`：工具注册表测试（静态等级、作用域拒绝、白名单过滤 cua-driver 工具名）；策略引擎测试（max(静态, Jev)、超时退静态、风险先于完成、缓存命中）；jev-ax 候选提取与门槛测试；agent loop 用 mock provider + mock 工具跑通 10 条固定意图并产出 JSONL。
- `cuaremote run "列出桌面上的 pdf" --provider mock` 输出步骤时间线。
- `packages/jev-eval`：`uv run pytest`；`uv run report` 用 fixtures 产出 P50/P95 / 覆盖率 / 误报漏报表。

### UX
- agent-browser 打开 poc-web，提交含 `sudo` 的意图，时间线在该步暂停显示具体命令，点确认后继续到完成；截图存 state/reports/screenshots/M0/。

## M1 - Mac MVP

### Programmatic
- `apps/hub`：配对撮合测试（secret 过期、HMAC 错误拒绝）；设备挑战应答测试；中继路由测试（两端 WS 互发密文，hub 不解密）；推送 dry-run 测试；计量写入测试。
- HPKE：TS 加密 → TS 解密往返；输出 `vectors.json`，Swift 侧 `swift test` 用 CryptoKit 解密同一向量成功。
- 审批签名：P-256 签名验签测试 + 过期拒绝 + 重放拒绝。
- 云端大脑：brain 以 `--mode hub` 运行，tools.call 经中继到 mock daemon，端到端测试通过。
- `apps/daemon-macos`：`xcodebuild -scheme CuaRemote build` 通过；`swift test` 通过（协议解码、HPKE 向量、PTY 回显、策略白名单 → bounded 清单）。
- `apps/ios`：`xcodebuild -scheme CuaRemote -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test` 通过。
- 学习应用：brain 探索器对 fixture sdef + AX 输出能力卡片 JSON，schema 校验通过。

### UX
- iOS 模拟器截图：设备 / 应用 / 终端 / 活动 / 我的 五个 tab、底部 accessory、审批卡片（Face ID 模拟器用 `simctl` 匹配）、隐私「数据去哪了」页、模型档位页（Fable 5.1 标不支持 ZDR）、扫码配对页、SSH 主机列表与终端。存 state/reports/screenshots/M1/。
- Mac：`cuaremote status` 输出常驻状态与权限清单；菜单栏图标可见（截图）。

## M2 - iPad + 终端进阶

### Programmatic
- firmware：`python -m py_compile` 全部通过；HTTP 输入接口的 JSON 契约测试（主机侧 mock）。
- 校准：`bun test` 校准拟合在合成数据上误差 ≤ 2px；ipad_computer_use 校准流程移植测试。
- brain iPad 工具：mock dongle + mock 截屏跑通 tap/type/swipe。
- iOS：iPad 模拟器 build 通过；SFTP / 端口转发 / ssh config 导入单测。

### UX
- iPad 模拟器截图：被控模式页、大脑选择说明页；iPhone：SFTP 浏览器、FIDO2 选项。

## M3 - 产品化

### Programmatic
- 密文同步：加密块上传 / 下载 / 第二设备解密测试；hub 拿不到明文（测试断言存储内容不含明文关键字）。
- JOC 计费：mock 接口下免费配额扣减、超额拒绝、用量上报测试。
- OSC 133 解析单测。
- provider 注册表：档位标签、Fable 5.1 ZDR 不可用断言。
- iOS：语音输入模块单测（mock recognizer）；H.264 解码路径 build 通过；Fastlane lane 语法检查。

### UX
- iPhone 截图：按住说话、模型切换页、历史同步开关、实时画面页。

## M4 - Android

### Programmatic
- brain android 工具：mock adb 跑通 screencap / tap / dump。
- `apps/android-daemon` 与 `apps/android`：`./gradlew assembleDebug`（orb 能装 SDK 则必须通过，否则 UNSURE 并给出源码级检查）。
- hub 多设备：一个控制端绑定两台被控设备的路由测试。

### UX
- 无 Android 模拟器（orb 无 KVM），UX 记 SKIPPED；iOS 多设备列表截图。
