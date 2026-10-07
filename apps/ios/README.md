# iPhone 原生客户端

SwiftUI 客户端使用真实账号 JWT、设备 P-256 登录签名、六位码或 PairOffer 配对、HMAC 和 CryptoKit HPKE。意图、执行事件、批准与拒绝均经已固定设备公钥的加密连接发送。

当前状态：design-33 的原生修正与放宽改动已核验导入，完整 14 份应用源码与 Mac 一致。标准机五栏宽度由 294 增至 327 点，mini 为 300 点；不缩小文字或合并任务按钮。两机短测、mini 完整三项与新增宽度/右缘检查通过，两项睡眠期间失败也已单独补测通过，旧失败记录保留。最终构建与 Release 成功，47.434 秒新实录及大字/深色截图已检查；本轮界面验证完成，不代表重新验收真实连接或真机能力。

按 2026-09-22 最新要求，顶部原生导航、底部原生五栏和最右独立任务按钮必须同时保留。底部通过 UIViewRepresentable 使用系统 UITabBar 及五个 UITabBarItem，右侧是独立 Button；不是自绘栏，也不把任务伪装成搜索或第六页签。iOS 26 的任务按钮使用系统玻璃样式，较旧系统使用系统按钮样式；不手画底栏背景、边框或选中状态。

各栏使用独立 NavigationStack 保留导航、搜索及滚动状态，系统底栏在各栏之外保持同一实例，详情只隐藏它。分组列表、卡片、半屏任务输入和深底步骤代码区继续按 `docs/design/index.html` 实现；页面不套默认 Form，保留系统键盘与认证。

独立 UITabBar 保留系统玻璃、选中背景与过渡，但不自动提供完整 UITabBarController 的栏外滚动边缘模糊。两者的滚动外观不完全相同；不通过裁剪系统控件或手绘背景掩盖这个差异。

原稿中的成功绿、警告黄、危险红、链接及 GUI 标签蓝均与文字、图标一起表达状态，并配套浅色底和深色模式。普通应用图标保持中性，离线清单不显示成当前状态。本轮使用 `design-33` 记录验证进度；`design-32` 自绘底栏未满足用户要求，其测试通过不等于设计验收通过。

任务按钮空闲时打开输入，未配对时打开添加设备，忙时进入已有任务详情，不重复创建任务。首页顶部仅保留添加设备，不再放第二个任务按钮。

连接与配对位于添加设备页面，任务与签名确认仍经真实加密连接发送。离线应用清单明确标注为上次收到的数据；设备未提供的指标不补造。画面、原生终端、SSH 与用量等未接通功能如实显示限制。最新 UI 回归与此前真实联测分别记录在 `docs/product-acceptance.md`，模拟器视觉数据不算真实设备执行结果。

## 构建

需要 Xcode 26、XcodeGen、已安装的 iOS Simulator runtime。仓库根执行：

```sh
xcodegen generate --spec apps/ios/project.yml --project apps/ios
xcodebuild -project apps/ios/CuaRemote.xcodeproj -scheme CuaRemote \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/.build -jobs 4 build-for-testing CODE_SIGN_IDENTITY=-
swift test --package-path packages/protocol/swift -j 4
```

不要设置 `CODE_SIGNING_ALLOWED=NO`：即使是模拟器，Keychain 也需要本地签名，否则报 `-34018`。模拟器 ad-hoc 签名不需要开发者证书。真机签名需要自己的 Apple 开发配置，不使用这里的模拟器签名设置发布。

## 真实端到端测试

先构建，然后在被控 Mac 启动 `scripts/e2e/host.ts start <全新私有目录>`。需要真实 `CUAREMOTE_PROVIDER` 和该模型的环境变量密钥。宿主会生成随机测试文件、开启 JWT 验证的 hub、启动真实设备，生成短时连接配置。配对信息五分钟有效，不要先启动宿主再做第一次构建。

手机机器获取该私有 `connection.json` 后：

```sh
python3 apps/ios/scripts/configure-ui-test.py apps/ios/.build/Build/Products /private/connection.json
xcrun simctl create 'ReVolae E2E' com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot <返回的UUID>
xcrun simctl bootstatus <UUID> -b
xcodebuild test-without-building -xctestrun <生成的xctestrun文件> \
  -destination 'platform=iOS Simulator,id=<UUID>' -jobs 4 \
  -parallel-testing-enabled NO -resultBundlePath /private/live.xcresult
```

配置字段：`E2E_HUB_URL`、`E2E_TOKEN`、`E2E_PAIR_CODE`、`E2E_READ_PATH`、`E2E_READ_EXPECTED`、`E2E_APPROVE_PATH`、`E2E_DENY_PATH`、`E2E_WRITE_CONTENT`。XCUITest通过实际输入框连接和配对，不在 App 内注入假状态。跨机器使用 `wss://`，本机允许 `ws://127.0.0.1`。

默认新配对需要在 Mac 确认窗口中实际允许；测试检查等待状态，并留出覆盖 helper 90 秒时限的结果等待。无法操作窗口、拒绝或超时都不能当作成功。

仅当宿主已核验并恢复真实旧配对时，可提供 `E2E_CONNECTION_MODE=existing-pairing`，以及 `E2E_DEVICE_ID`、`E2E_PHONE_ID`、`E2E_HISTORY_BASELINE`（非负整数字符串）。此时不要求配对码。测试核对界面上的真实手机/设备标识，不发起新配对或修改固定公钥；加密读取必须使用手机原来保存的公钥。历史按旧数量加本轮三条检查。日志和截图明确标为既有配对重连，不能宣称新人工确认已通过。

配置脚本添加 `--device-pages` 可运行真实状态、底栏完整滚动、只读学习、快捷指令保存/重读/删除、隐私设置读取、历史审批只读、断开/重新连接、重命名和解绑检查。解绑在最后执行，只针对本轮指定测试设备。新增断言需完整跑完才能算验收通过。

还需要继续使用原配对时添加 `--preserve-pairing`。测试仍检查管理卡最后一行完整滚入详情页可见区域，不被导航栏或底部安全区遮挡，但不点击解绑，并输出 `E2E_PAIRING_PRESERVED_UNPAIR_NOT_TESTED`；这一轮不能声称重新验收了解绑。

快捷指令支持上移/下移，首尾、离线和等待回执时禁用对应按钮。顺序只在收到当前设备对应 `ref` 的 `shortcuts.list` 后更新，不先显示保存成功。排序失败或超时会重新读取，保留错误提示；断线不重发排序。真实页面检查创建 Zulu 23、Alpha 7、Mike 51 三条指令，将顺序改为 Mike 51、Alpha 7、Zulu 23，再离页重读并核对新的回执，避免把旧缓存当成持久化结果。

测试检查随机文件读回、签名批准和签名拒绝。Mac 另执行 `bun scripts/e2e/host.ts verify <本轮目录>`，确认批准前无文件、批准后内容正确、拒绝后无文件、三次调用了真实模型。手机不读取 Mac 的本地文件。

`record-simulator.py <UUID> <测试日志> <mp4> <停止文件>` 在日志出现 `E2E_PAIRED` 后开始录制，只录模拟器；出现完成标记或停止文件后向其录屏子进程发 SIGINT。失败运行的录像不能作为成功证据。

测试结束使用 `host.ts stop`，再 `simctl shutdown <UUID>`。生成的 `xctestrun`、连接配置、原始日志和 `xcresult` 可能包含短时凭据，应保存在私有目录，不直接上传。仅交付脱敏日志、经过检查的截图及配对后录屏。

## 签名与限制

私钥和配对公钥保存在 Keychain。非模拟器平台支持 Secure Enclave 时使用硬件签名并要求系统身份验证；硬件密钥创建、恢复或身份认证失败直接报错，不降级。

模拟器可能报告可访问宿主 Secure Enclave，这不证明真实 iPhone 身份认证可用。`targetEnvironment(simulator)` 构建明确使用 CryptoKit 软件 P-256，并在批准区域显示“模拟器软件签名，未验证 Face ID / 设备密码”。模拟器身份使用独立的 `.simulator-software` Keychain 命名空间，不迁移或覆盖旧硬件身份。仍需真实点击确认、检查命令和到期时间、生成真实签名，并由 Mac 验签。没有测试开关或伪造认证回调；模拟器测试不验证真人身份认证。

断线后立即标记设备离线、清除未完成请求和审批。已认证连接遇到明确网络中断时，依次等待 2、4、8、16、30 秒重连，累计最多五次；正常关闭、认证失败、损坏消息、公钥不符、初次连接失败均停止。用户主动断开或更换连接会取消等待，页面也提供“停止自动重连”。使用本次已认证的内存配置，表单清空或编辑不影响自动恢复；不保存账号令牌到文件，不重发任务或旧审批。系统挂起 App 时不申请额外后台运行，进程结束后需要重新连接。

设备更换公钥时拒绝静默接受，必须重新配对。审批签名前重新计算具体命令的哈希、检查请求有效期，并在系统身份认证返回后再次确认连接及审批仍有效。任务与历史使用设备的 `status` 区分完成、失败、拒绝和取消；旧记录只按 `ok/cancelled` 兼容，不根据摘要猜测拒绝。

## 独立模拟器网络检查

`bun apps/ios/scripts/reconnect-hub.ts <全新私有目录>` 启动仅监听回环地址的真实中继，生成 600 权限的 `connection.json`。它不配对、不调用模型；测试控制入口需要该文件中的独立随机令牌。使用 `configure-ui-test.py <Build/Products> <connection.json> --network-test` 配置后，运行 `-only-testing:CuaRemoteTests`。`PhoneNetworkTests` 实际等待全部五档，检查主动停止、认证拒绝、正常关闭、损坏消息和无效 JWT 均不重试；核对修改请求没有被自动重发。没有配置时该项明确跳过，不算通过。

测试结束向配置地址同端口的 `/control` 发送 POST `stop`，Authorization 为 `Bearer <E2E_RECONNECT_CONTROL>`，关闭服务后删除这个临时配置。不要把凭据写进命令参数或日志。`RunOutcomeTests` 的四张状态图明确标注为展示测试数据，不作为真实模型执行证据。

## 手机本地历史

已收到且通过当前设备、请求 ref、runId 检查的历史列表和详情，保存在 Application Support 的 `History-v1` 中；按中继来源、手机身份和设备分别存 JSON，不塞进 Keychain。写入使用原子替换、`completeFileProtection`、600 文件权限，并排除系统备份。历史可能包含任务文本与工具输出，仍应当作本机私密数据保管。账号令牌、模型密钥、运行会话与签名决定不进入这个存档。

重启只恢复最近通过认证的来源，设备一律显示离线；不能恢复 busy、旧批准入口或自动重发任务。历史页显示来源和保存时间，没下载的详情明确要求在线获取。第一页刷新按 runId 更新现有状态，并保留已收到的更早页。解绑或中继确认设备已移除时删除该设备文件。损坏文件明确报错，不当作空列表，也不会被新的一页悄悄覆盖。

来源使用实际收到 auth.ok 的那条连接地址，不使用可编辑表单。完整地址只在内存中计算 SHA256 来源标识；落盘和界面使用移除 userinfo、query、fragment 的显示地址。端口、路径或私有参数不同仍隔离。含私有参数的地址不保存原文，重启后联网需重新输入；此前其它来源的存档保留，但不会因编辑地址框而自动切换或删除。

`HistoryCacheTests` 使用临时目录验证全新 Store/Model 读回、分页更新、两设备/来源/身份隔离、缺详情、持久删除、迟到响应、损坏文件和认证字段拒绝，并生成明确标注的页面测试图。无需模型密钥。`PhoneNetworkTests.testHistorySourceUsesAuthenticatedConnectionNotEditedForm` 使用上述真实回环中继验证“认证 A → 表单改 B → 手动/自动重连 A”以及未认证 B 不覆盖 A 的最近来源或缓存，不在 hub 中插入假配对。

模拟器不提供文件保护等级属性，因此 `testCompleteFileProtectionOnPhysicalDevice` 明确跳过；不能据模拟器检查声称真机锁屏加密已通过。600 权限、排除备份、实际读写与删除可在模拟器检查，文件保护等级及锁屏行为仍需真机验收。
