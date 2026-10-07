# Mission Progress

Status: RUNNING（2026-09-21：用户批准恢复原设计和完整功能）
Current: task-history 实施中：native-activity-29已核验整合，实时步骤检查信息/耗时/数据离机与缺字段展示通过隔离页面验收；28正式批准前取消路径仍保留。整项尚未完成，例如设备审批仍固定remember=once，计划中的记住/撤销精确动作授权未接通。真机文件保护与身份认证仍未验；device-foundation保留权限及Mac窗口等欠项。

本轮逐项状态以 `.agents/plans/2026-09-21-cuaremote-product-completion.plan.md` 为准，功能验收见 `docs/product-acceptance.md`。下面是历史记录，不代表本轮完成。

## 本轮最新验证（2026-09-21）
- native-activity-29：两包/6源码/34证据文件及14个运行源码哈希核验一致并整合。先红灯缺检查来源，最终定向原生2项/UI46.478秒通过；加取消/历史/结果回归共原生21通过1跳过、UI4通过，Release入口/横幅/定义符号排除日志已读。六张活动/历史代表图独立检查，两步骤不串值、不按成败推断离机、缺字段不补零；两状态末卡底715、任务入口顶735，间距20点。首轮被底栏遮住检查末行的截图与日志保留，最终测试改查实际末行并复跑。orb238项1344断言、五包类型检查通过；未修改PhoneModel/RunSession/TS，无设备/模型调用或新录像，真机保护仍跳过。
- native-cancel-live-28：5源码、47证据文件及两包SHA已核验；17个可比对运行源码一致，未在orb比较Mac二进制。正式连接UI64.258秒、前检/清理各1项、取消8/结果2/导航1项全通过且0跳过；不代表本轮验证了真机文件保护。独立核对各JSON的runId/requestId、唯一cancelled完成事件、无step.finished/无目标文件与原手机身份/pin哈希一致；三张最终代表图已检查。取消后步骤不再假显执行中，28源码已整合。orb238项1344断言、五包/新宿主类型检查、配置脚本新旧格式14检查通过。真实既有配对私有副本、固定响应模型，未改原配对或补外部密钥，无新录像。下一步补活动步骤信息展示。
- native-cancellation-27：两包及8项源码SHA已核验导入；Mac原生26通过1跳过、取消UI2通过/80.804秒、导航1通过、共享Swift18通过及设备连接1项96断言、Release构建与测试入口排除日志已读。实际21秒超时后仍busy，手动重试与迟到回执不解锁旧审批；最终结果优先且不自动重发。六张代表截图已独立检查，44pt点击区域和按钮禁用由UI断言验证。orb复跑238项1344断言及五包类型检查通过。手机页面为隔离输入，设备连接用固定响应模型，完整手机到Mac取消联测继续；真机保护跳过，无新录像或外部模型调用。
- native-history-relaunch-26：5项源码和两包/逐文件哈希已核验导入；实际App重启UI64.959秒通过、原生18通过1跳过/导航1通过及Release测试入口隔离日志已核读。三次不同PID、两份JSON哈希一致、清理后无目录经独立脚本核对；68.125秒完整录像和代表截图已检查，末卡高于任务入口18.33点，缺详情及回活动空闲通过。隔离数据不算新模型/配对。新增设备取消测试证明ack不等于结束、旧签名拒绝及重复提交不执行，定向1项95断言/整仓238项1344断言及五包类型检查通过；测试已传原生线程。
- native-history-events-25：3项源码和两包/逐文件哈希已核验整合；先失败2断言再修复合法建议命令的历史保存，跨任务和认证字段过滤保持。Mac原生19通过1跳过、导航1通过日志及7张组件截图已检查；缺可选字段不补造、只读按钮探针有正例。orb238项1329断言/五包类型检查通过；无新模型或录像，组件通过不当作整页长历史或实际App重启通过。
- native-history-24：8项源码及两包/逐文件哈希已核验整合。Mac联合iOS17通过1跳过、导航1通过，强化历史6通过1跳过、共享Swift17通过日志已核读；新Store/Model读盘、来源/身份/设备隔离、更新保留早页、持久删除及实际认证地址重连检查通过。四张隔离数据截图已独立检查；无新模型或录像，真机文件保护仍未验。orb复测238项1329断言、五包类型检查通过。审阅发现terminal.suggestion遗漏和历史计划/预检展示缺口，原生继续修补。
- native-shell-09：五栏导航测试、真实读取/批准/拒绝与文件检查通过，截图和 60.99 秒录像已检查。
- native-v2-11/local-10：Swift 15 项、iOS build、LiveFlow 85.935 秒与 host verify 通过；新录像和完整批准页已独立检查并发给用户。真实软件签名，不是 Face ID 真机验收。
- orb：最新 `bun test` 238 pass / 0 fail、1344断言，五包类型检查通过；新增既有配对副本恢复、断线重连、结果分类与取消边界、快捷指令排序检查。history-21真实模型网络预检通过随机文件读取、批准写入、拒绝不写入及历史结果分类；最新取消网络测试用本地固定响应模型，不算新模型验收。
- Android：共享包和 daemon 单测、新增断线队列丢弃及完整旧会话重放测试通过；控制端与 daemon 两个 debug APK 构建成功。没有运行模拟器或真机，UI 假数据尚待替换。
- 设置与模型：所有页面直接响应带请求 ref；设备已返回模型目录和当前默认值，未核实价格标 unknownPrice，不能结算。Mac 正接新数据页，不把设备单测当 UI 验收。
- 新增只读权限消息、status.json 和默认 Mac 本机配对确认，已传 native 线程；本机确认窗口与权限引导尚待实际操作检查。此次回归用临时凭据仍按600保存，全部回归后清除；没有推送、部署或修改 GitHub Secrets。
- native-pages-14：39个手写源码/配置/测试文件已核对导入，Swift15/Mac7/iOS3单测及导航通过；local-11真实三任务及host verify通过，但扩展页面测试内存标签断言失败，修复后待完整复跑，不将其记为新页面通过。真实状态和批准截图已检查并展示；底栏滚到底仍待检查。
- foundation-18：等待批准时关闭设备的新增测试先20秒超时；修复关闭后重新等待握手的问题，定向约0.7秒通过。重启后旧签名被拒、重复提交只返回停止历史、未产生文件；整仓222项/1231断言与五包类型检查通过。已同步Mac继续回归。
- native-foundation-18：15文件已校验导入；Mac11项、Bun5项94断言、iOS4项及真实Keychain迁移清理日志已核对，三张窗口截图已独立检查。人工确认已实际拒绝并返回accept:false；工具错误发生在窗口关闭后的读取，不再把它视为点击失败。真实模型网络三任务再次通过，但全新人工配对与扩展页面回归、开机自启和自动重连仍未完成。
- resume-19：local-12正式确认窗无法读取，未配对、未执行任务；原host已停止。新增只读核对旧身份/配对并复制到新私有目录，测试证明原文件不变；local-13原pin真实读/批准/拒绝与host核验通过，但扩展卡片标识失败，整体FAIL。
- local-14：完整扩展LiveFlow 191.22秒、host verify通过；状态/范围/权限末行高于底栏、只读学习、快捷指令、隐私、历史、手动重连、重命名、解绑均实际执行。native-pages-19包与7项源码哈希核验导入；日志、持久更名解绑、175.50秒录像及关键截图已独立核验并交付；不是新人工配对通过。
- reconnect-20：设备退出明确reconnectable；认证/身份异常、初始失败和主动stop不重试。1006/1012/1013检查通过；1001在Bun1.3.9/1.3.10被错误报告1000，测试独立探测并明确提示限制，只证明保守不重连。Mac自动退避实现继续，未算整项完成。
- history-21：run.finished/HistoryItem新增可选RunStatus，成功/失败/拒绝/取消不再只靠ok区分；确认超时是失败，旧记录不猜拒绝。修复已取消仍调用模型及返回时取消却显示成功；新增测试先失败再修正。生成Swift已传原生线程接标签，未改其手写代码。
- native-reconnect-20：7项Mac源码哈希已核对导入，12项Swift（80.66秒）、10项TS日志已核读；真实Hub/CLI/Keychain完整五档退避后恢复，第六次停止；stop和认证拒绝不重试。iOS自动重连未完成。CGSession只读检查当前锁屏阻止新窗口验收，但不能倒推之前配对失败的原因；不修改权限或解锁。登录项开关未实际注册，local-12/13/14独立Keychain条目清理结果已核对。
- shortcuts-22：设备排序加密连接测试先失败后通过；重复/漏项/未知ID不覆盖原列表、改名保留位置、重启顺序保留。生成Swift待原生接入，手机排序未验收。原生线程报告共用连接Mac侧17项通过，iPhone模拟器自动重连与状态标签继续测试，源码待收取。
- native-phone-21：12项源码与证据哈希已核验导入；共享Swift17、Mac12、模拟器8项0跳过及导航1项通过，五档真实自动重连及停止/不重发断言日志已读。local-15完整LiveFlow189.314秒、文件核验及历史三条明确状态通过；新173.65秒录像、完整批准/名称/管理底部/实际重连截图已独立检查。保留配对，未验新人工配对/Face ID；失败/取消图标注展示数据。orb整合复测238项1329断言、五包和网络脚本类型检查、新旧配置格式隔离/600权限检查通过。下一步手机排序；Mac解锁后的人工确认与窗口验收仍未完成。

- native-shortcuts-22：5文件源码及证据哈希已核验整合，原生9项/导航1项/local-16完整238.205秒/独立文件及SQLite顺序检查均通过。222.5秒真实录像已检查；三条排序离页新回执保持Mike51→Alpha7→Zulu23。orb复测238项1329断言和五包类型检查通过。独立视觉复核发现禁用箭头不明显、末卡截图只验证标题而非底部，已交原生继续小范围修正；不能称视觉全部完成。Mac临时模型文件已删除，测试服务停止，既有配对保留。

- shortcuts-visual-23：3项源码和两包哈希已核验整合，Mac原生10项及导航1项通过。四状态的禁用箭头外观、44pt区域、实际操作行约697pt小于任务入口顶边735pt已检查；整卡能滚到完整可见，没有改安全区。新LiveFlow整卡断言只编译，未重跑真实模型。原local16包哈希与录像保留；orb复测238项1329断言及五包类型检查通过。计划转任务历史，原生继续手机本地保存与离线只读。

## 2026-09-21 原生应用与真实端到端测试
- E1 真实设备连接、配对、加密、签名确认、本地工具执行 [DONE] 真实 ZenMux、JWT、HPKE、随机文件读取、批准写入、拒绝未写入、无签名/重放拒绝均通过网络预检。
- E2 SwiftUI iPhone 应用与 macOS 入口、独立模拟器端到端测试 [DONE] local-07：XCUITest 1 PASS / 92.918 秒；宿主独立文件核验 PASS。源码已回收，截图与 76.36 秒成功录像已检查。
- E3 两个同时在线的 GitHub macOS runner 联测（其中一个运行 iPhone 模拟器）[BLOCKED] 工作流 actionlint 通过；仓库无模型密钥，保存到 Actions Secrets 需要用户批准，尚未运行。
- E4 Mac 虚拟机资源限制可行性 [DONE] 4 vCPU / 16 GiB / 120 GB VM + 160 GB 镜像/缓存总上限方案；未安装或改主机设置。
- 当前验证：整合后 TS 全套 203 PASS，类型检查及脚本检查通过；Mac 上 Swift 共享包 7 PASS、CLI 配置测试 1 PASS；iOS build-for-testing 与真实 XCUITest 成功；原生 Mac CLI 的真实启动、登录、配对、状态查询及停止通过。
- 已发现并修复：Keychain 本地签名、键盘遮挡输入、发送后旧输入残留、Swift 6 后台信号回调崩溃、模拟器系统认证无法完成、模型总结不复述原始文件内容。第七轮用新随机目录通过；读取断言精确核对真实工具输出，不依赖模型复述。
- 用户追加录像要求：只录独立模拟器、配对后开始，保留真实成功场景截图与录像，不录凭据或个人桌面。
- 限制：不使用假模型、假设备或硬编码结果作为验收。保留原有单元测试，但单独报告。
- GitHub：orb 凭据读取 Actions secrets/self-hosted runners 返回 403；Mac 的 sol1560 凭据读取 secrets 成功、列表为空，尚未修改 GitHub 状态。
- 清理：本任务所有 Mac host/device 已停止，独立模拟器已 Shutdown，临时 model.env 已删除。未推送或写入 Actions secrets。
- 证据与范围见 reports/native-e2e.md；不把模拟器软件签名当成真机 Face ID / 设备密码测试，不把本次结果当成旧任务书全部功能完成。

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
- F1.7 终端 [DONE-orb 部分] 协议：terminal.open 带 signature（signTerminalOpen/verifyTerminalOpen，复用审批 challenge 格式：runId=terminal/stepId=sessionId/actionDetail=terminal.open，TTL≤300 s、nonce 记 1000）、terminal.opened 加 streamId（设备分配）；brain：packages/brain/src/terminal/{pty,session,manager}.ts —— BunPty（Bun.spawn terminal 真 PTY）、TerminalSession（16 KiB 分帧、256 KiB 窗口背压、迟到/超 sent ack 忽略、8 MiB 未确认断开并发 terminal_closed、退出时不等 ack 冲完再 terminal.exit、喂 Osc133Parser 发 terminal.block）、TerminalManager（open/resize/ack/close 路由、kind 1 帧按 streamId 写 PTY、terminal_exists/terminal_limit/terminal_spawn_failed/approval_invalid、CUAREMOTE_SESSION 环境变量、terminal.blocks 工具）；LocalBunHost({terminals}) 挂 terminal.blocks；21 测试（含 Linux 真 PTY：exit code、resize 后 stty size、close 触发 onExit）；docs「远程终端」节；schema/Swift 已重生成。Swift daemon forkpty + iOS 终端页（SwiftTerm）+ SSH 客户端归 runner；网页 PoC 不含终端。**加固（oracle 审查后）**：签名绑 deviceId；unsafeUnsigned 显式开关（缺配置构造抛错）；sessionId 正则 + cwd 存在性在验签前检查、不烧 nonce（terminal_bad_session_id / terminal_bad_cwd）；nonce 按 expiresAt 过期并可由宿主持久化；streamId 时间种子；sendFrame 抛错关会话；BunPty 2 s SIGKILL 兜底；29 测试（含真实重放、跨设备、trap HUP）。HPKE 握手新鲜度问题记入 discovered-issues，未修
- F1.8 开源材料 [DONE] README（快速开始改成真能跑的命令、文档索引、现状）、docs/architecture.md（四层图、一次意图的走法、目录表、大脑位置/档位、GUI 三条路、iPad/Android）、docs/security.md（三级分级表、预检顺序、签名确认、HPKE/同步、配对、作用域、数据去向表、挡不住的、漏洞报告）、docs/README.md 索引、CONTRIBUTING.md（环境表、测试命令、改协议规矩、大脑/宿主规矩、测试要求、PR）、SECURITY.md、.github/workflows/ci.yml（bun typecheck+test、pytest）；CLA.md/LICENSE 已有。CI 未在 GitHub 上跑过（未 push）

## M2 - iPad + 终端进阶 [RUNNING]
- F2.1 firmware [DONE] 已回收：ESP32-S3 TinyUSB NCM+HID+HTTP 主固件 + RP2040 CircuitPython 备用（未编译/未真机）· F2.2 校准 [DONE] firmware/dongle/calibration 单调分段线性拟合，4 测试，模拟 P95 0.72px · F2.3 brain iPad 工具 [DONE] packages/brain/src/ipad/ipad-host.ts：IpadHost 把 iPad app 的 6 个底层工具（screen/pointer/hid.macro/clipboard/calibration.get|put）包成 ipad.screenshot/tap/scroll/type/key/calibrate；校准 44 样本→fitCalibration→存回设备；指针预测+归零；宏分批≤128；ASCII 直敲/非 ASCII 剪贴板；host-mode 懒包装、云端大脑按 platform=ipados 包装；11 测试 · F2.4 iOS iPad 被控（runner B）[PENDING] · F2.5 SSH 进阶（runner B）[PENDING]

## M3 - 产品化 [RUNNING]
- F3.1 语音（runner B）[PENDING]
- F3.2 模型设置页 [DONE-orb 部分] 协议：PrivacySettings.cloudModel、ModelEntry、models.list / models.catalog；brain：packages/brain/src/llm/catalog.ts（BUILTIN_MODELS、listModels、probeLocal、tierAccepts、resolveProvider 选错抛错不降级、catalogMessage）；providers.ts 补 ANTHROPIC_ZDR / ZENMUX_ZDR；host-mode 与云端大脑的 intent/learn 都改走 resolveProvider 并响应 models.list；docs/protocol.md「模型设置」节；15 测试。设置页 UI 归 runner B
- F3.3 密文同步 [DONE-orb 部分] 协议：SyncKind/SyncBlob、sync.put/pull/page/delete（端↔hub）、sync.key（端到端分发密钥）；packages/protocol/src/sync.ts AES-256-GCM sealSync/openSync（AAD 绑 kind|id|deviceId|ts，5 测试）；hub：sync_blobs 表、按 ts 覆盖、seq 游标分页、unclaimed 拒、单块 64 KiB、每类 5000 配额只算新 id（2 端到端测试）；brain：packages/brain/src/sync/history-sync.ts HistorySync push/pull/disable/setKey（4 测试）；docs「云同步」节。Swift/Kotlin 端移植归 runner
- F3.5 OSC 133 命令块 [DONE-orb 部分] 协议：TerminalBlock（三个偏移量与 terminal.ack 同尺）、terminal.block 事件；brain：packages/brain/src/terminal/osc133.ts Osc133Parser（跨 chunk、BEL/ST、cmd= 或回显抠命令、OSC 7、字节级截尾、块数上限，7 测试）；loop 终端模式先调宿主 terminal.blocks（L0）把最近 5 条命令块放进上下文（1 测试）；shell-integration/cuaremote.{zsh,bash,fish}；docs「终端命令块」节；schema/Swift 已重生成。daemon Swift 解析 + terminal.blocks 工具 + iOS 按块渲染归 runner
- F3.6 JOC 计费 [DONE-orb 部分] apps/hub/src/billing.ts：CreditLedger 接口 + JocLedger（Bearer、余额/幂等扣款、409=已扣，路径可配）+ LocalLedger（hub credits 表）；Billing：自然月免费次数（默认 50）、免费层 1 台被控设备（只数配过对的）、usd×(1+30%)×100 credit 两位向上取整、run_billing 表按 runId 幂等预占/结算、余额查不到不放行、扣款失败下次重试；CloudBrain 加 billing 钩子（reserve 不过回 credits_exhausted 无 run.created，finally 里 settle 含断线）；hub 处理 billing.get / GET /api/billing / pair.request device_limit；协议 billing.get / billing.status；server 环境变量 HUB_BILLING/JOC_*/HUB_FREE_RUNS…；MockProvider 加 mock:paid 计价；6 测试（含端到端）；docs「计费」节。JOC 真实接口字段未核对（按最小假设写、可配）
- F3.4 实时画面 [DONE-orb 部分] 协议：media.info 加 streamId（设备分配）；packages/protocol/src/media.ts MediaFrame（[flags][pts u32][w u16][h u16][data]，bit0 关键帧 / bit1 带 SPS/PPS，encode/decode、u32 回绕丢帧规则）、Bonjour 直连常量 `_cuaremote._tcp` + TXT id/v/n + lanAdvertUsable；Frame.swift 同步加 MediaFrame / LanDiscovery / terminalOpenChallenge；fixtures binary.json 加 mediaFrameHex 与 terminalOpenChallenge 向量；5 测试；docs「实时画面与局域网直连」节。SCStream+VideoToolbox 编码、iOS AVSampleBufferDisplayLayer、NWListener/NWBrowser 归 runner
- F3.7 App Store 材料 [DONE-orb 部分] apps/ios/AppStore/：PrivacyInfo.xcprivacy、权限用途文案、fastlane（Appfile/Fastfile screenshots·beta·release/Snapfile/Deliverfile/rating.json）、中英文 metadata + 审核备注、simctl 截图脚本、接入说明。bundle id dev.cuaremote.app 为占位；工程/签名/演示模式归 runner B + Sol

## M4 - Android [RUNNING]
- F4.1 adb 工具 [DONE-orb 部分] LocalBunHost 有 adb 时暴露底层 android.adb（sh -c、image 模式 sips 转 JPEG）；packages/brain/src/android/adb-host.ts AdbHost 把它包成与 Android daemon 同名同参的 10 个 android.* + android.devices（uiautomator XML 解析、index 中心点缓存、单台自动选 serial 缓存 30 s、set_text 仅 ASCII、包名校验、dumpsys 通知解析）；host-mode 链 wrapIfIpad→wrapIfAdb，云端大脑非 ipados 设备包 AdbHost；15 测试；docs「Android（adb 路径）」节。Swift 宿主的 android.adb 归 runner A；未真机验证
- F4.2 android-daemon [DONE] 已回收：无障碍/MediaProjection/十个 android.* 工具/HPKE/审批验签（gradle test 在源线程通过；orb 无 JDK 未复跑）
- F4.3 android 控制端 [DONE-部分] Compose UI 全页面就位，但状态层还是本地假数据、未接真实 WebSocket/pair.request
- F4.4 多设备 [DONE-orb 部分] 协议：DeviceSummary、devices.list/devices.page、device.rename、device.unpair、pair.removed；hub：devicesFor（配过对 ∪ 同账号，去自己和大脑，别名优先，排序）、device_aliases 表（按账号）、unpair 统一入口（WS 与 DELETE /api/pairings 都走，通知双方）、GET /api/devices 改用同一份；测试：一部手机配两台 Mac 各走各的密文通道、A↔B 未配对 not_paired、列表/别名/解绑/下线 lastSeen（hub.test 7/7）；docs「多设备管理」节；schema/Swift 已重生成。iOS/Android 设备列表页归 runner B / Android 线程
