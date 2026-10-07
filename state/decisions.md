# Decisions

## 2026-09-22 放宽原生底栏（本轮验证完成）
- 用户认为原生五栏太挤，要求放宽。保持真正 UITabBar、顶部原生导航和右侧独立系统任务按钮，不回到自绘、不缩小文字，也不合并动作与导航。
- 已移除组合外侧额外的两侧各 14 点边距，HStack 间距从 10 改为 5 点，保留系统自己的留白。标准机组宽 294→327 点，入口中心距 44.8→51.4 点；mini 组宽 300 点、中心距 46 点。两机任务圆钮仍为 60 点，实际间隔 10 点，右侧约 5 点留白，未裁剪系统控件。
- pending05 八文件、width06 三文件增量及最终测试补丁均已核验导入，完整 14 份应用源码与 Mac 一致，只有入口产品代码变化。两份 Live 查询编译通过，未重跑真实连接。原生 33 通过、1 真机保护项跳过；旧标准 UI 六项通过、两项睡眠期间失败的记录保留，不改成整轮通过。
- 父线程直接核读两机短测各一项通过、repair06 两项补测通过（132.006 秒）、compact06 三项通过（184.870 秒）。宽度和圆钮右缘增加了可失败的断言，在 width07 实测通过；build07 与 Release06 成功，六项隔离入口在 Release 中均不存在。
- 47.434 秒实际新录屏已完整检查，覆盖原生选中移动、滚动透色、独立任务输入和详情隐藏/返回；标准/mini、大字末卡和输入、深色截图均已检查。11 项交付文件哈希一致；两台专用模拟器已关闭，无测试或录制残留。未新验真实模型、Mac 连接、新配对、Face ID、真机保护或 iOS18 外观；未推送。

## 2026-09-22 原生底栏与独立任务按钮必须同时保留（design-33 过程记录，最终结果见上节）
- 用户指出 design-32 再次丢失原生导航。把底部五栏改成自绘、只保留顶部原生，是助手的错误选择，不是用户批准的取舍。此前测试通过只能说明该实现可操作，不代表满足原生效果要求。
- 顶部和底部导航使用真正系统组件，同时保留底部最右独立新任务按钮。不能在两者之间自行取舍，不能拿手绘胶囊、颜色或控件标识冒充原生。
- Mac 小项目已实际验证公开 UITabBar 独立控件加右侧系统按钮：标准机与 mini 各 1 项通过，页面保持全宽。父线程已读源码并检查标准图及彩色内容透过底栏的图，确认是系统浮动玻璃和选中背景，不是旧式矩形条。Apple 文档明确支持独立使用 UITabBar；不需要搜索页签、工具栏替代、私有层级或手绘背景。
- 已接入 Mac 正式页面，父线程已核读 pending03 源码和首页/详情实际图，正式回归仍在进行。首次实例检查实际发现切栏重建 UITabBar，已改为在五栈之外保留同一控件，根页按实测高度预留空间，详情只隐藏。修正后实例/滚动定向检查通过；不能把此结果当整轮回归通过。
- 独立 UITabBar 不自动提供完整 UITabBarController 的栏外滚动边缘模糊，已与真正 TabView 画面对照确认。系统玻璃与选中背景由控件提供，但两者外观不完全相同，不声称没有差异。
- 父线程直接核读 diagnostic-04，确认五个原生栏按钮在详情中仍为 isHittable=true，不是仅容器残留。Mac 修正真实 UITabBar 的 isHidden、isUserInteractionEnabled、accessibilityElementsHidden，保留实例；pending04 六文件快照已取回暂存并读完，间距检查恢复为至少 9.5 点。还未导入当前 orb 产品源码，不把待回归包当最终交付。
- Mac 报告 ui-04 主页面/详情定向测试通过，原生 33 通过、1 真机保护跳过，Release04 成功；完整 regression04 中取消状态等待超时，不能算整轮通过。pmset 日志显示多次睡眠，测试日志出现数百秒停顿；已请用户唤醒 Mac 并保持唤醒，不改系统设置或权限，不重复启动原测试。正式小屏、新录屏和两份 Live 查询的最终编译仍待完成。
- 已取回的源码与日志在 `.amp/in/ui-evidence/design-33/`；底栏改前/改后图已检查并展示。未取得本轮新录像，不拿 design-32 视频代替。orb 的未改共享代码复测为 238 通过、0 失败、1344 断言，五包类型检查通过，这不代替 iOS 界面验证。

## 2026-09-22 恢复底部独立任务按钮（design-32，自绘底栏已被用户否定）
- 用户明确要求保留原稿最右侧的独立新任务按钮，不能与其他按钮粘在同一背景组里。上一轮把它移到顶部工具栏是错误的实现选择，本轮撤销。
- 底部左侧五栏组与右侧独立星芒圆按钮自绘；标准机和 iPhone 13 mini 均实测圆按钮 60 点、两块背景间距 10 点。顶部保留原生标题、返回与添加设备，不用第六页签代替动作，没有隐藏的系统底栏或顶部重复任务入口。
- 保留 design-31 的状态配色、卡片、半屏输入、五栏状态保留与详情返回。任务按钮空闲时开输入、未配对时开添加设备、忙时进入已有任务，不重复创建任务。
- 五个独立 NavigationStack 保留在 ZStack 中，只有当前栏首页挂载真实底栏，其他栏保留同高安全区。详情使用原生 push 后不继承底栏，不另外维护导航深度。首轮点击区域过小、次轮隐藏栏重复暴露按钮均修正后复测，失败日志保留。
- 已核读 `regression-03`：原生 33 通过、1 真机保护项跳过，UI 8 通过；`compact-03` 小屏 3 通过；独立录制用例 1 通过，Release 构建成功。标准机、小屏、大字、深色、按钮间距、详情末卡、历史重启和取消锁定均有本轮测试记录。
- 7 个增量文件和完整 14 个应用源码哈希已核验、整合。只有入口和共用导航两份产品文件变化，连接、配对、数据与历史存储不变；orb 238 项测试、五包类型检查通过，未推送。
- 本轮交付已检查的新截图与 48.634 秒实际 simctl 录屏，明确标注隔离数据，不代表真实模型、新配对、正式设备连接、Face ID 或真机保护验收。此前 design-30/31 只有新截图和日志；旧录像不拿来代替本轮视频。

## 2026-09-22 颜色回补与原生导航（design-31，任务按钮位置已由上节修订）
- 用户指出原稿中的颜色缺失，并明确允许导航栏使用原生组件。本轮恢复状态、风险及操作的颜色，顶部导航栏和底部五栏使用原生组件；此决定取代下一节中的自绘标题与胶囊导航要求。
- 页面仍按 `docs/design/index.html` 保留卡片、分组列表、输入区、按钮和深底代码区，不恢复默认 Form 外观。任务入口移至顶部工具栏；忙时进入已有任务详情。五栏状态保留、原生返回、详情隐藏底栏、离线提示及取消期间的签名锁定均已重新检查。
- 绿色用于成功与开启状态，黄色用于警告与待确认，红色用于失败及危险操作，蓝色用于链接与 GUI 标签；对应浅色底取自原稿，并配套深色模式。普通图标保持中性，不用颜色或标签暗示设备没有报告的状态。
- 小字蓝色徽章改用 `#1768CF`，与原稿浅蓝底的对比度由 4.3446 提高至 4.6833；链接与导航仍用原蓝。普通待执行步骤不显示成黄色待确认，取消不显示成成功，未结束旧历史使用时钟；内存进度仅按在线设备提供的有效用量和总量计算。
- Mac `regression-06` 日志已核读：原生 33 通过、1 真机文件保护项跳过、0 失败，UI 8 通过；`compact-06` 小屏 3 通过，Release 构建成功。此前颜色、详情底栏失败及模拟器 Busy 启动失败保留，不计为通过。证据与截图使用 `design-31` 新名称，不复用旧轮结果。
- Mac 既有线程完成 iOS 产品及测试代码，orb 负责文档和整合。不继续旧计划的全部功能开发，不改配对、连接或存储行为，不推送；未重测真实模型、正式设备连接、新配对、Face ID 或真机锁屏保护。

## 2026-09-22 UI 还原（此前记录，导航选择已由上节修订）
- 用户要求取回历史线程代码、按设计稿还原，并明确不要过分使用原生。本轮只处理 iOS 界面与必要回归，不继续旧计划中的全部功能开发。
- 已从界面还原线程恢复 187 个文件，包含 iOS、Mac、配套服务代码与 `docs/design/`；逐文件校验与捕获内容一致。当前工作仍未推送，`origin/main` 不是最新实现。
- `docs/design/index.html` 是视觉依据。保留五栏，但自定义标题、底部胶囊导航与独立任务按钮、搜索、分组卡片和表单外观；不让系统 TabView、Form、大标题或 Liquid Glass 改变原稿布局。系统键盘、认证和必要的导航能力保留。
- 设备首页对应原稿 `#/mac` 的控制页，不是 `#/devices` 的管理列表；活动页应能直接浏览已收到的历史。未接通的画面、终端、计费不显示假数据，视觉测试数据只用于标明的模拟器测试入口。
- 本次整合线程：https://ampcode.com/threads/T-01a0c64a-289a-7509-8c9d-f072058edb0d；原生实现仍在 `sol-mac:/Users/sol/ReVolae` 的既有线程完成，保留当地未提交代码与配对。
- Mac 曾断连，恢复后通过主动上传完成取回。18 个增量文件及其后两份联测脚本定位补丁已校验并导入；14 个完整应用源文件均与 Mac 最终哈希一致。原生数据、任务与历史存储逻辑未变，未改配对、固定公钥或系统权限。新版 UI 已进入当前 orb 源码，未推送。
- 整合后 `bun test` 为 238 通过、0 失败、1344 断言，五包类型检查通过。Mac 原生测试 30 通过、1 真机保护项跳过；标准机型 UI 的 8 项分别取得通过结果（ui-05 为 7 通过、1 失败，cancel-06 定向补跑该失败通过），小屏另有 3 项通过。Release、build-07、build-08 成功；Release 不包含五种隔离入口标记。
- 关键日志、校验清单与说明保存在 `.amp/in/ui-evidence/design-30/`；已检查的实际截图在 `.amp/in/artifacts/ui-parity/`。初轮失败不删除或计为成功，测试数据有明确标记。完整 114 张 PNG 与改前图仍保留在 Mac 的 `apps/ios/.runtime/design-30/delivery/native-design-30-evidence.tgz`。
- 原生线程：https://ampcode.com/threads/T-01a0c39c-d19b-70ba-97a6-796b65826178。本轮没有重验真实模型、正式设备连接、新人工配对、Face ID 或真机锁屏保护；两份联测脚本只更新定位并检查编译。系统字体、符号、键盘、弹层外框与认证保留，不承诺 HTML 与 SwiftUI 逐像素相同。

## 2026-09-21 真实联测
- 主线程在 orb（HEAD 起点 1dd1185），另一个线程访问 sol-mac 的 /Users/sol/ReVolae，未使用其它 Volae/Vocae 仓库。未推送改动通过文件工具同步。
- 使用现有真实 ZenMux 接口 openai/gpt-4.1-mini；真实 API、文件读写与加密网络预检已通过。现有 mock 单元测试单独报告，不作 E2E 证据。
- Mac 执行复用 LocalBunHost，device.ts 负责真实登录、配对、固定公钥、HPKE 与签名确认；Swift 提供 iPhone 客户端及 Mac 启动入口。拒绝操作立即结束，禁止模型换路径继续执行。
- 模拟器没有 Secure Enclave 时使用真实 P-256 软件签名并显示限制，不伪造 Face ID。模拟器应用需本地 ad-hoc 签名；禁用签名会使 Keychain 报 -34018。
- 实测修正：当前 Apple Silicon 模拟器的 SecureEnclave.isAvailable 为 true，不能据此认定具备真实 iPhone 身份认证。按 targetEnvironment(simulator) 明确选择软件 P-256，并用独立 Keychain 命名空间保存；不迁移旧硬件身份。非模拟器的硬件创建、恢复与身份认证失败仍直接报错，不转为软件路径。模拟器结果不作为真机 Face ID / 设备密码验证结果。
- GitHub 不提供独立 iPhone runner：使用两个并发 macos-26 job，一个真实宿主，一个 iPhone 模拟器。临时 HTTPS 隧道仅承载合成测试数据，hub 启用随机短期 JWT；连接凭据在 artifacts 中使用手机 job 的临时公钥加密。
- Mac 的 GitHub 用户凭据能读取仓库 Actions secrets，目前为空。orb 凭据不能访问该接口。新的模型密钥存储位置需要用户批准，不能仅凭准备好工作流宣称云端通过。
- 主机 M5 Max / 18 核 / 128 GiB，空闲磁盘约 4.2 TiB；当前没有 VM 工具或镜像。先独立后台模拟器、构建 jobs=4。未来 VM 建议 4 vCPU / 16 GiB / 120 GB 虚拟盘，并用 160 GB 有上限磁盘存放镜像及缓存；NAT 仍可访问主机，不能宣称完全网络隔离。

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

## 2026-09-19 brain 实现时的决定
- **不用 Vercel AI SDK**，自写两种线格式（OpenAI chat/completions、Anthropic messages）覆盖 anthropic / openai / zenmux / ollama / lmstudio / openai-compat。理由：依赖少、ZDR/自带 key 只是换 base url、zod 4 无兼容问题。可否决。
- MCP 客户端自写 80 行（initialize / tools/list / tools/call），不引 @modelcontextprotocol/sdk。
- gui.* 白名单 19 个 cua-driver 工具（见 `packages/brain/src/gui/cua-driver.ts`），浏览器 / 录屏 / 配置类不放行；输入类默认 `delivery_mode: background`。
- 策略顺序固定：静态等级 → 作用域 → Jev(level/intent_match/irreversible) → 自治档位；静态 L2 不问 Jev；Jev 只能升级不能降级；三档阈值 cautious(risk≤0.2, conf≥0.85) / balanced(0.5, 0.6) / handsoff(0.75, 0.4)；无 Jev 时 L1 在 cautious/balanced 都要确认。
- 终端模式模型只能看到 L0 工具 + propose_command，其他工具即使被叫到也不执行（测试覆盖）。
- 模型价格表只填了 PRD 里的两个名字（占位价），其余为 0 并需在设置页标「价格未知」。
