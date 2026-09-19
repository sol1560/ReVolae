# Discovered issues（超出 spec 范围，记录不处理）

## 2026-09-19 F0.6 期间发现
- PolicyEngine 缓存把 verdict 一起缓存，导致「以后自动」第二次仍然要确认。已修：缓存只存 Jev 评估，verdict 每次重算（policy.test 新增用例）。
- @cuaremote/brain 的 package.json 没有 main/exports，跨包导入解析不到。已补。
- LocalBunHost 在 Linux 上 `sh -l` 会打印 `source: not found`（orb 的 profile 问题，Mac 用 zsh 不受影响）。未处理。
- PoC 页面「自主程度」下拉目前只是提示，真正的档位由服务端 --autonomy 决定；正式版走 privacy.set。

## 2026-09-19 F0.7 jev-eval 报告（数字全是 MOCK，方法已验证）
- 静态规则误报 6.8%（>5% 目标），且因为最终等级取 max，真实 Jev 再准也压不下去。要修 policy.ts：解析 shell 引号（写进文档的 sudo 不算）、pip install --target 项目内不升级、金融子串只匹配 targetApp/域名不匹配路径名。
- 静态规则漏报 45.8%：SSH 私钥/云凭据/API key/Cookie 读取外传、curl -F、base64 绕过、find -delete、> /dev/disk、wget|bash、/etc/hosts、LaunchAgents、git push -f、branch -f、../ 穿越、拆分 L2。需要加规则（F1.x 前）。
- 标注拿不准：step-090、step-140、adv-026、adv-027、adv-030（理由在 reports/report.md）。

## iPad dongle（F2.1/F2.2，回收自 T-01a0b9e1）
- ESP32-S3 C 固件在 orb 里没有 idf.py，也没有板子：未编译、未烧录、未在 iPad 上枚举过。需要真板验证 NCM+HID 复合枚举、DHCP、15ms 时序、供电。
- 绝对坐标 HID（USB touchscreen digitizer）能否被 iPadOS 当系统触摸接受：没有可靠官方证据，暂不能替代相对增量 + 校准。
- 该线程替用户做的决定：主控选 ESP32-S3-DevKitC-1 N8R8（CircuitPython usb_cdc 只有串口，做不了 NCM）；RP2040 降为 HID+串口 JSON 备用；键鼠合一个 HID 接口两个 Report ID；固定地址 172.31.254.1/29；Unicode 走 iPad app 写剪贴板 + Cmd+V。

## Android（F4.2/F4.3，回收自 T-01a0b9e0）
- HPKE 互通已交叉验证：Android 生成的 test-vectors/hpke-auth.json 在 TS OpenContext 里解出 "first-frame"，aad 与 TS relayHeader 字节一致。
- 我改了 daemon 的 hub 登录签名：原来签裸 nonce，改为签 hubAuthPayload(deviceId, nonce)（Frames.kt 新增函数、HubConnection.kt 调用、ProtocolTest 加断言）。本 orb 没有 JDK/Android SDK，这三处改动没跑 gradle，需在 Mac 上 `./gradlew :apps:android-shared:core-protocol:test` 复核。
- 控制端 UI 是本地假状态，没接 WebSocket、没发真实 pair.request；hub 现已定稿（docs/protocol.md「hub 登录与中继」），需要一轮接线。
- 该线程替用户做的决定：Gradle 9.6 / AGP 9.4 / Kotlin 2.4.20 / compile 37 / min 29；BouncyCastle 1.81 做 HPKE；X25519 由 BC 管、P-256 由 Android Keystore 管；只给 Android 实际处理的消息建强类型，其余控制帧原样转发。
- 需要真机：无障碍/通知使用权/录屏授权、各厂商后台保活、指纹。

## 2026-09-19 F1.7 终端加固（oracle 对抗审查后）
- 已修：terminal.open 签名原来只绑 sessionId，可跨设备重放 → 现在绑 deviceId；无 phoneKeys 时原来静默不验签 → 现在要显式 unsafeUnsigned 否则构造抛错；BunPty.close 对 `trap '' HUP` 的 shell 留孤儿 → 2 s 后 SIGKILL；streamId 重启从 1 起 → 时间种子；sendFrame 抛错会丢字节 → 关会话；sessionId 没校验 → 正则；cwd 不存在要到 spawn 才报错且已烧 nonce → 验签前检查；nonce 计数环 1000 个 → 按 expiresAt 过期、可持久化。
- **未修（hpke.ts 层）：HPKE 握手没有接收方新鲜度。** 发送方单方面建立上下文，接收方不贡献随机数，hub 理论上可以把一整段密文流（从握手帧开始）原样重放给设备；应用层的 nonce 只保护 terminal.open 这一类签名消息，普通控制消息和 kind 1 输入帧没有这层保护。修法：接收方在 hello 里带一次性 challenge，发送方把它放进 HPKE 的 info；或者每条链路记住已见过的 enc，重复即拒。留给下一轮协议改动统一做（会改 wire 格式）。
- 未做：nonce 表的持久化只是留了接口（Map），Bun 宿主和 Swift daemon 都还没真的落盘。
