# CuaRemote 协议

单一来源：[`packages/protocol/src`](../packages/protocol/src)（zod）。Swift 端用生成的 [`Protocol.swift`](../packages/protocol/swift/Sources/CuaRemoteProtocol/Protocol.swift)，改协议只改 zod 然后 `bun run gen`。

## 三条链路

```diagram
┌─────────┐  RelayEnvelope(WS 二进制)  ┌──────┐  RelayEnvelope   ┌──────────────────────────┐
│ 手机 app │◀────────────────────────▶│ hub  │◀───────────────▶│ 设备 daemon (Swift/Kotlin) │
└─────────┘   hub 消息(WS 文本 JSON)   └──────┘                 │   │ stdio JSON lines        │
                                                                │   ▼                        │
                                                                │  brain (bun)               │
                                                                │   │ MCP stdio              │
                                                                │   ▼                        │
                                                                │  cua-driver mcp            │
                                                                └──────────────────────────┘
```

1. **端 ↔ hub（明文）**：WS 文本帧，JSON，`HubMessage` 联合。`hello` → `auth.challenge` → `auth.response` → `auth.ok`；配对 `pair.*`；`push.register`；`usage.report`；`presence`；`peer.keys`。
2. **端 ↔ 端（经 hub 中继）**：WS 二进制帧 = `RelayEnvelope`（`[u8 1][u8 toLen][to][u8 fromLen][from][u8 flags][body]`），hub 只读 `to`，把 `body` 原样转给对端。`body` 是 HPKE 密封后的 `Frame`（`[u8 kind][u32 streamId][payload]`）。kind 0 控制 JSON（`PeerMessage` 联合）、1 PTY 字节、2 媒体帧。
3. **大脑 ↔ 宿主（stdio）**：宿主（Swift daemon / hub 的云端大脑宿主 / M0 的 TS 本地宿主）spawn `brain --mode host`，双向 JSON lines（每行一个 `AnyMessage`）。

## 大脑 ↔ 宿主的路由规则（宿主实现）

宿主是「哑管道 + 工具执行器」，不做决策：

| 方向 | 消息 | 宿主怎么处理 |
|---|---|---|
| brain → 宿主 | `tools.list` | 回 `tools.list.result{tools, scope}`，列出宿主自己能执行的工具 |
| brain → 宿主 | `tools.call{callId, tool, args}` | 执行，回 `tools.result{callId, ok, output, attachments, ms}`；截图放 `attachments[].inline`（base64 JPEG）或开 kind=2 流 |
| brain → 宿主 | 其他任何 `DeviceToPhone` 消息（`run.created`、`step.*`、`run.finished`、`terminal.suggestion`、`app.*`、`history.page`…） | 原样封进 Frame(kind 0) 发给手机；同时写本地操作日志 |
| 手机 → 宿主 | `intent.submit`、`run.cancel`、`shortcut.run`、`history.list`、`app.learn.*`、`app.card.*`、`app.cards.get` | 原样写给 brain stdin |
| 手机 → 宿主 | `approval.decision` | **先验签**（P-256，见下），过期 / 重放 / 签名错 → 回 `error`；通过后原样写给 brain |
| 手机 → 宿主 | `terminal.*`、`media.*`、`stats.get`、`privacy.*`、`scope.set`、`capabilities.get` | 宿主自己处理（PTY / SCStream / IOKit / 设置），不经 brain |
| 宿主 → brain | `privacy.state`（设置变化时） | 让 brain 知道当前档位、Jev 开关、作用域 |

宿主提供的工具（`tools.list.result.tools`，M1 Swift 宿主全部实现；M0 TS 宿主同名实现）：

| 工具 | 参数 | 静态等级 | 说明 |
|---|---|---|---|
| `shell.run` | `{cmd, cwd?, timeoutMs?, stdin?}` | 1（`sudo`/`rm -rf`/`diskutil` 等命中 deniedCommands 升 2） | `/bin/zsh -lc` |
| `applescript.run` | `{script, timeoutMs?}` | 1 | `osascript -e` |
| `jxa.run` | `{script}` | 1 | `osascript -l JavaScript` |
| `shortcuts.run` | `{name, input?}` | 1 | `shortcuts run` |
| `shortcuts.list` | `{}` | 0 | |
| `fs.list` | `{path, depth?}` | 0 | 限 `scope.allowedDirs` |
| `fs.read` | `{path, maxBytes?}` | 0 | 同上 |
| `screenshot` | `{app?, window?, maxWidth?}` | 0 | SCStream 单帧 JPEG |
| `apps.running` | `{}` | 0 | |
| `app.explore` | `{bundleId, layer: sdef\|menu\|window\|shortcuts\|explore}` | 0 / explore=1 | 学习应用的数据源，回 JSON 文本 |
| `android.adb` | `{serial?, cmd, timeoutMs?, image?, maxWidth?}` | 1 | 机器上有 `adb`（PATH 或 `CUAREMOTE_ADB`）时才出现。`cmd` 是 adb 子命令（不含 `adb`），`image=true` 时把 stdout 当 PNG、缩成 JPEG 放附件。模型看不到它，见「Android（adb 路径）」 |

`gui.*` 不在宿主里：brain 自己 spawn `cua-driver mcp` 并做白名单过滤（见 brain 文档）。宿主负责保证 cua-driver 的 TCC 归属（M1 用 `EmbeddedCuaDriverHost` 或让 brain 用 `cua-driver mcp --direct`）。

## 审批签名

手机收到 `step.approval_required{challenge, expiresAt}`，用 Secure Enclave P-256 私钥对 `approvalSignedPayload(challenge, allow)`（UTF-8）做 ECDSA-SHA256，回 `approval.decision{signature:{alg:"ES256", keyId, sig(base64 raw r||s), expiresAt, nonce}}`。`alg` 也可以是 `Ed25519`（没有 Secure Enclave 的平台，比如 Android 控制端或测试）。ES256 公钥接受 x963（65 字节）/ raw（64 字节，CryptoKit `rawRepresentation`）/ 压缩（33 字节），签名接受 raw r||s 或 DER。宿主（`ApprovalVerifier`，`packages/protocol/src/approval.ts`）：

1. `expiresAt` 未过期且 ≤ 请求时的 `expiresAt`；
2. `nonce` 未用过（宿主保留最近 1000 个）；
3. 用配对时存的手机签名公钥验签；
4. `challenge` 与自己发出的一致（宿主按 runId+stepId 缓存）。

`challenge = approvalChallenge({runId, stepId, actionDetail, nonce, expiresAt})`，两端实现见 `frame.ts` / `Frame.swift`，测试向量在 `swift/Tests/.../fixtures/binary.json`；两种算法的签名向量（固定私钥、确定性签名）在 `fixtures/approval.json`。

## 端到端加密

HPKE（RFC 9180）：DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305，Auth 模式（发送方用自己的 X25519 静态私钥认证）。每个方向一个上下文，`info = "cuaremote-v1|" + from + "|" + to`，每帧 `seal(aad = RelayEnvelope 头部字节, pt = Frame 字节)`。会话建立：先发 `enc`（32 字节）作为第一帧 body，之后都是密文。TS 实现在 `apps/hub`/`packages/brain` 共用的 `packages/protocol/src/hpke.ts`（`E2ELink`：`handshake()` 出握手帧，`sealFrame()` / `openRelay()` 收发；拒绝路由不符、重复握手、未握手密文），Swift 用 CryptoKit `HPKE.Sender(recipientKey:ciphersuite:info:authenticatedBy:)` / `HPKE.Recipient(...)`，ciphersuite `.Curve25519_HKDF_SHA256_ChachaPoly`。互通向量 `fixtures/hpke.json`（密钥由 `DeriveKeyPair(ikm)` 派生、enc 由固定 ekm 派生、含 aad 与两帧密文和 exporter），RFC 9180 A.2.3 官方向量 `fixtures/rfc9180-a2-3.json`，都由 `bun run gen:fixtures` 复制到 Swift 测试目录。

## 配对

Mac `cuaremote pair` 打印 `PairOffer` 二维码（JSON）。手机扫码后：
1. 手机连 hub，发 `pair.request{deviceId, phoneId, phonePubKeys, hmac}`，`hmac = HMAC-SHA256(secret, deviceKem || phoneKem)`（base64 原始字节拼接）。
2. hub 转给设备；设备验 HMAC、检查 `expiresAt`、终端提示「iPhone 请求配对，按 Enter 确认」，回 `pair.confirm`。
3. hub 把 `pair.result` 发给双方，双方保存对方 `PublicKeys`。

没摄像头（或不想扫码）时：设备用会话 token `POST /api/pair/code`（body = PairOffer 去掉 hubURL/expiresAt）拿 6 位码，5 分钟有效、只能用一次；手机发 `pair.code.claim{code}`，hub 回 `pair.offer{...}`（内容和二维码一样），之后照常走上面 1–3。两端实现：`pairHmac()` / `pairHmacEquals()`（`packages/protocol/src/pairing.ts`）。

## hub 登录与中继

一条 WebSocket（`/ws`）两种帧：文本帧是 `HubMessage` JSON（明文控制），二进制帧是 `RelayEnvelope`（hub 只读 `to/from`，body 原样转发）。

登录：`hello{role, deviceId, pubKeys, token?}` → hub 回 `auth.challenge{nonce}` → 端用签名私钥对 `hubAuthPayload(deviceId, nonce)`（`"cuaremote-hub-auth-v1\n" + deviceId + "\n" + nonce` 的 UTF-8）签名，发 `auth.response{nonce, signature(base64)}` → `auth.ok{sessionToken, expiresAt}`。之后 hub 立刻推 `peer.keys` + `presence`（每个配过对的对端一条），并向对端广播我方上线。

规则：
- 同一个 `deviceId` 只认第一次登记的公钥（换公钥回 `key_mismatch` 并断开，关闭码 4003）；换设备要先解绑（`DELETE /api/pairings?peer=`）。
- 同一个 `deviceId` 只保留最新一条连接，旧的被 4000 `replaced` 踢掉。
- 中继只在「配过对」的两端之间放行；信封 `from` 必须等于自己，否则 `from_mismatch`。对端不在线回 `error{code:"peer_offline", ref: to}`，不排队（端到端密文没法给离线方补发，改走推送）。
- 多账号模式（hub 设 `HUB_JWT_SECRET`）：手机 `hello.token` 必须是 HS256 JWT（`sub` = 账号）；被控设备首次连上时归 `unclaimed`，配对成功那一刻归入手机的账号，之后别的账号的手机配不上（`account_mismatch`）。不设 secret 是单机模式，所有端同属 `local`。
- 推送：手机 `push.register{platform, token, pushKem}`；设备在手机离线时发 `push.send{to, sealed, category}`，`sealed` 由设备用 `pushKem` HPKE 封好，hub 不解密。没 APNs 配置时 hub 只记 `push_outbox`（status `dry-run`）。
- 计量：`usage.report` 按账号入库，`GET /api/usage?since=` 查汇总。

HTTP 接口都用 `Authorization: Bearer <sessionToken>`：`POST /api/pair/code`、`GET /api/devices`、`GET /api/usage`、`DELETE /api/pairings?peer=`；`GET /healthz` 免鉴权。

### 多设备管理

一部手机可以和任意多台被控设备配对（每对一条 pairings 记录，中继按对放行；免费层由计费限制台数）。同一部手机对不同设备各建一条端到端链路，密文只到 `to` 指的那台。控制端管理这些设备用的消息（WebSocket，和 HTTP 同源）：

| 消息 | 方向 | 说明 |
|---|---|---|
| `devices.list{}` → `devices.page{devices:[DeviceSummary]}` | 端 → hub | 我配过对的对端 ∪ 同账号下其它端，去掉自己和大脑；`paired=false` 的可以发起配对。`name` 优先本账号起的别名；在线的 `lastSeen` 是现在，离线的是下线时刻。排序：配过对 > 在线 > 名字。`GET /api/devices` 返回同一份 |
| `device.rename{deviceId, name}` → `ack` | 端 → hub | 给自己或配过对的对端起别名（1–64 字，去首尾空白），存 `device_aliases(account_id, device_id)`，只在本账号内可见，不改设备自报的 `hello.name`。没配过对回 `not_paired` |
| `device.unpair{deviceId}` → `ack` | 端 → hub | 解绑（等价 `DELETE /api/pairings?peer=`）。两个方向的配对都删，之后中继回 `not_paired` |
| `pair.removed{deviceId, phoneId, by}` | hub → 双方 | 解绑通知，在线的一方立刻收到；离线的一方下次登录时 `announce` 里自然没有这个对端。`by` 是发起解绑的 id |

## 云端大脑

hub 设了 `HUB_CLOUD_BRAIN_PROVIDER=<provider:model>` 时，每个账号在第一个端登录时会挂上一个进程内的虚拟端点 `brain:<accountId>`（role `brain`，platform `cloud`）。它不走 WebSocket 也不走 hello/auth，但在 hub 眼里和别的端一样：有 devices 表记录、有 presence、发信封同样受 `from`/`canTalk` 校验。它的长期密钥存在 `brain_keys` 表（X25519 种子 + Ed25519 签名密钥），hub 重启后 id 和公钥不变，手机固定过的公钥不会失效。

谁能和大脑说话：`canTalk` 放行「配过对」或「同账号且一方是 brain」。所以手机和被控设备登录后，hub 会额外推一条 `brain:<account>` 的 `peer.keys` + `presence`；大脑上线时也会推给账号里所有在线的端。

手机侧的用法：隐私设置 `brainLocation = cloud` 时，把 `intent.submit`（`deviceId` 填目标设备）、`approval.decision`、`run.cancel` 用端到端链路封给 `brain:<account>`，而不是封给设备。大脑回来的 `run.*` / `step.*` / `plan.*` / `error` 也是密文，from 是 `brain:<account>`。

设备侧的义务（daemon 实现）：来自 `brain:<account>` 的 `tools.list` / `tools.call` 要像响应本地大脑一样响应（`tools.list.result` / `tools.result`），并在隐私设置变化时把 `privacy.state` 也发一份给大脑，大脑用其中的 `jevEnabled` / `autonomy` 给这台设备上的 run 定档位。大脑不处理 pty / media 帧。

确认步骤：大脑发 `step.approval_required{challenge, expiresAt}` 给手机并记住 challenge；手机回的 `approval.decision` 必须带签名，大脑按「审批签名」一节的规则用手机的签名公钥验（无签名、过期、nonce 重复、challenge 不匹配都判拒绝，并回 `error{code:"approval_<原因>"}`），验不过这一步按用户拒绝处理，设备上什么都不会跑。

顺序保证：同一个对端发来的信封大脑按到达顺序串行处理（握手帧建链路是异步的，紧跟着的密文不能抢在前面）。对端掉线时，大脑里等它回结果的调用全部判失败，涉及它的 run 取消，链路作废，重连要重新握手。

## 学习应用

「学习应用」= 设备扒原料，大脑总结成卡片，设备存卡片，手机按控件渲染。大脑侧在 `packages/brain/src/learn/`。

原料由 daemon 提供两个工具：
- `app.inventory {bundleId, phase}`：`phase` 依次是 `sdef` / `menu` / `window` / `shortcuts`，每次返回一份 `AppInventory` JSON（`items[].id` 在同一应用内要稳定：sdef 用 `suite/command`，菜单用路径 `File > Export…`，快捷指令用名字）。某个阶段失败只汇报进度不中断。
- `app.card.get {cardId}`：返回一张已存的 `CapabilityCard` JSON；找不到返回 `ok:false`。

大脑收到 `app.learn.start{bundleId, explore}` 后：逐阶段调 `app.inventory` 并发 `app.learn.progress{phase, found, message?}`（phase 还有 `explore` / `summarize` / `done` / `failed`）→ 模型 `propose_cards` → 校验（模板里每个 `{{key}}` 必须在 `fields` 里声明；控件和字段要配；来源和动作类型要配，例如 `sdef` 不能出 `shell`；`fromItem` 必须在清单里；`staticLevel` 只能比模型标的高、不能低）→ 发 `app.cards{cards}`。**存卡是设备的事**：daemon 收到 `app.cards` 后持久化，手机端只读缓存。`explore=true` 目前只汇报跳过，GUI 探索留给后续。

`app.card.run{cardId, params}`：大脑用 `app.card.get` 取卡 → 渲染模板（applescript/jxa/shell 三种通道按各自规则转义；shell 参数自动加单引号；bool/number 不转义）→ 过同一套策略引擎（静态分级 → 作用域 → Jev → 自治档位），卡片自带的 `staticLevel` 是下限，L2 卡一律要确认 → 调 `applescript.run` / `jxa.run` / `shortcuts.run` / `shell.run` / `gui.act`。事件复用 `run.created` / `step.*` / `run.finished`，手机上和普通 run 走同一条时间线。

云端大脑：手机发给 `brain:<account>` 的 `app.learn.start` / `app.card.run` **必须带 `deviceId`**（本地大脑可省略），确认同样走签名校验。

## iPad 被控

iPad 上没有可用的系统级自动化接口，靠 USB dongle 模拟键鼠（`firmware/dongle/`）。dongle 只收**相对**增量、只能从 iPad 自己的 USB 子网访问，所以 iPad app 作为设备端只提供几个底层工具，大脑侧（`packages/brain/src/ipad/ipad-host.ts`）把它们包成模型能用的绝对坐标工具。

iPad app 在 `tools.list.result` 里要报这些工具（platform 填 `ipados`）：
- `ipad.screen {}`：截屏。`output` 是 JSON `{width, height, pointer?: {x, y}}`，附件一张 JPEG。**截图像素坐标和 pointer 必须是同一坐标系**，大脑会用截图坐标去点。
- `ipad.pointer {}`：只读当前指针位置（校准页里用 UIPointerInteraction / hover 拿），`output` 是 `{x, y, width, height}`。没有这个工具就不能校准，只能用设备存的模型。
- `ipad.hid.macro {steps}`：把 `steps` 原样 POST 到 dongle `/macro`（≤128 步，大脑已分批），然后轮询 `/status` 到 `busy=false` 再回 `tools.result`。dongle 回 4xx/409 时 `ok:false` 并把状态码放进 `error`。
- `ipad.clipboard.write {text}`：写系统剪贴板（非 ASCII 文本靠它 + Cmd+V 输入）。要求 app 在前台。
- `ipad.calibration.get {}` / `ipad.calibration.put {model}`：读 / 存校准模型 JSON（`fitCalibration` 的输出），让大脑重连后不用重新校准。

大脑给模型的工具：`ipad.screenshot`、`ipad.tap {x, y, count?}`、`ipad.scroll {x?, y?, dx?, dy?}`（dy 正数向下）、`ipad.type {text}`、`ipad.key {key, modifiers?}`、`ipad.calibrate`。这些都走普通策略引擎和确认流程（`channel: "ipad"`）。底层工具不会出现在模型的工具表里。

行为约定：
- 指针位置由大脑预测跟踪；`ipad.screen` 带回 `pointer` 时以设备为准；宏失败或设备重连后视为未知，下一次点击先往左上角撞墙归零（用户会看到指针飞到左上角）。
- 校准：先把指针挪到屏幕中部，再对 1/2/4/8/12/16/24/32/48/64/80 每个幅度按 +x/−x/+y/−y 各发一个**单报文**宏并读指针，共 44 个样本，拟合后存回设备。改了指针速度 / 显示缩放 / 横竖屏要重新校准。
- 文本：美式键盘可直接敲的 ASCII 走 `key.type`（1024 字符一块）；含其它字符时整段写剪贴板再 Cmd+V。

## Android（adb 路径）

Android 被控有两条路：装 `apps/android-daemon`（无障碍 + MediaProjection，功能全），或者**不装任何东西**，把手机用 USB / 无线调试连到一台有 `adb` 的 Mac 上。第二条路由 Mac 宿主的 `android.adb` 底层工具承担，大脑侧 `AdbHost`（`packages/brain/src/android/adb-host.ts`）把它翻成和 daemon **同名同参数**的工具，模型不用区分两条路：

| 工具 | adb 实现 | 与 daemon 的差别 |
|---|---|---|
| `android.devices` | `adb devices -l` | daemon 没有此工具；多台在线时其它工具必须带 `serial` |
| `android.screenshot{maxWidth?}` | `exec-out screencap -p`（image 模式） | 同 |
| `android.ui_tree{maxElements?, maxDepth?}` | `uiautomator dump` + XML 解析 | 元素少、约 1 s；`index` 只到下一次 ui_tree 前有效 |
| `android.tap / long_press{index \| x,y}` | `input tap` / `input swipe` 600 ms | 同 |
| `android.swipe{fromX,fromY,toX,toY,durationMs?}` | `input swipe` | 同 |
| `android.set_text{index,text}` | 先 `input tap` 元素再 `input text` | **只支持 ASCII**，非 ASCII 报错提示装 daemon |
| `android.key{key}` | `input keyevent` 4/3/187/66/24/25 | 同 |
| `android.launch{packageName}` | `monkey -p … -c LAUNCHER 1` | 同 |
| `android.apps` | `pm list packages -3` | 只列第三方包 |
| `android.notifications` | `dumpsys notification --noredact` | 只有包名 / 标题 / 正文 |

接入位置：`brain --mode host` 里宿主链是 `StdioHost → wrapIfIpad → wrapIfAdb`；云端大脑对非 ipados 设备总是包一层 `AdbHost`（对没有 adb 的宿主透明）。只有一台在线时自动选它并缓存 30 s（命令失败即重查）。Swift 宿主的 `android.adb` 实现归 daemon-macos（`/bin/sh -c "adb [-s serial] <cmd>"`，`image=true` 时 stdout 走 `sips -Z maxWidth` 转 JPEG）。

## 模型设置

手机上的模型设置页 = 大脑回的清单 + 用户在隐私设置里的选择。大脑侧在 `packages/brain/src/llm/catalog.ts`。

拿清单：手机发 `models.list{}`（本地大脑发给设备，云端大脑发给 `brain:<account>`），大脑回 `models.catalog{models, defaultModel, brainLocation}`。`models[]` 每条是 `ModelEntry`：`id`（`provider:model`）、`label`、`provider`、`tier`（这个模型能满足的最严档位：`local` / `zdr` / `byok` / `standard`）、`zdr`、`vision`、`priceIn` / `priceOut`（每百万 token 美元）、`available` / `unavailableReason`（缺 key、本机 Ollama / LM Studio 没开）、`custom`。本地大脑会探一次本机 Ollama（`/api/tags`）和 LM Studio（`/models`），云端大脑回的清单里本地条目一律不可用。

用户选什么：`PrivacySettings` 里 `modelTier` 是档位，`localBrainModel` 是 `local` 档用的模型，`cloudModel` 是其它档用的模型；`intent.submit.provider` 可以临时指定一个。

档位强制（`resolveProvider`），**选错直接报 `error{code:"provider"}`，绝不悄悄换成别的模型**：
- `local`：只收 `ollama:` / `lmstudio:` 这类本地模型；
- `zdr`：只收 `zdr=true` 的模型。厂商账号级 ZDR 是运营方和厂商签的合同，大脑靠环境变量 `ANTHROPIC_ZDR` / `OPENAI_ZDR` / `ZENMUX_ZDR` / `OPENAI_COMPAT_ZDR`=1 认；
- `byok`：只收 `openai-compat:<model>@<baseUrl>`（用户自己的网关 / key）和本地模型；
- `standard`：都收。

选模型的顺序：`intent.submit.provider` → 档位对应的设置字段 → 大脑默认模型；每一步都要过档位检查。BYOK 的 key 建议只放本地大脑（Mac daemon 的环境变量），云端大脑不代管用户的 key。

## 云同步（密文）

默认什么都不上云。用户在隐私设置 `sync` 里逐项打开（`history` / `shortcuts` / `logs` / `screenshots`）才会同步，且 hub 只存密文块，解密密钥只在用户自己的端上。

密钥：手机第一次打开任一同步开关时生成 `{keyId, key}`（32 字节），用 `sync.key{keyId, key}` 走端到端链路发给每台配过对的设备（也可反向由设备发给新手机）。hub 和云端大脑都见不到这条消息的内容。用户重新生成密钥（keyId 变了）= 之前上传的全部作废，端会整份重传。

块格式 `SyncBlob`：`kind` / `id`（history 用 runId）/ `deviceId` / `ts` / `keyId` / `alg="aes-256-gcm"` / `nonce` / `ct`。AAD 绑定 `kind|id|deviceId|ts`，hub 改任何一个明文字段都解不开。单块明文 ≤ 64 KiB。实现见 `packages/protocol/src/sync.ts`（`sealSync` / `openSync`）。

端 ↔ hub 的消息（明文 JSON 走 hub 连接，内容是密文）：
- `sync.put{items}`：≤100 块。同 `(kind,id)` 以 `ts` 新的为准（相同也覆盖，允许重传），旧的忽略；每次写入拿新序号。只收已登录账号的端（unclaimed 设备回 `token_required`）；单块超限回 `sync_too_big`；每类每账号默认 5000 条（只算新 id，覆盖不占），超了整批拒 `sync_quota`。
- `sync.pull{kind, cursor?, limit}` → `sync.page{kind, items, cursor?, more}`：按序号增量拉，`cursor` 是这页最后一条的序号，`more` 表示后面还有；从头拉不带 cursor。
- `sync.delete{kind, ids?}`：删指定 id；不带 ids 抹掉该账号这一类全部（关掉开关时端要发这个）。没有墓碑：别的端已经拉走的本地副本不受影响。

历史同步的端侧逻辑（参考实现 `packages/brain/src/sync/history-sync.ts`，Swift / Kotlin 照抄）：只传已结束的 run（有 `finishedAt`），本地 `finishedAt` 变新才重传；谁手里有明文谁传——本地大脑的 run 由设备传，云端大脑的 run 由手机传；拉取按游标增量、解不开的块跳过计数、合并时 `finishedAt` 大的赢、拉回来的不再回传；关掉开关 → `sync.delete` 整类 + 清空「已上传」记录。持久化 `{uploaded: runId→finishedAt, cursor}`。

## 远程终端

手机 ↔ 设备之间的一个真 PTY 会话。控制消息走 Frame(kind 0)，PTY 字节走 Frame(kind 1)，两个方向共用同一个 `streamId`。参考实现 `packages/brain/src/terminal/{pty,session,manager}.ts`（Bun 版宿主用 `Bun.spawn({terminal})`，Swift daemon 用 `forkpty` 照同样规则实现）。

打开（手机 → 设备）：`terminal.open{sessionId, cols, rows, cwd?, signature?}`。开终端等于给对方一个 shell，按 L2 处理：生产 daemon 必须验签，`signature` 是 `signTerminalOpen(...)` 签出来的 `ApprovalSignature`，签名内容 = `approvalSignedPayload(terminalOpenChallenge({sessionId, nonce, expiresAt}), true)`，也就是把 `runId="terminal"`、`stepId=sessionId`、`actionDetail="terminal.open"` 套进普通审批的 challenge 格式，手机端可以复用 Face ID 审批的那把 Secure Enclave 密钥和同一段签名代码。设备侧 `verifyTerminalOpen`：没签名、已过期、有效期超过 300 秒、nonce 用过（记最近 1000 个）、签名对不上（含签的是别的 sessionId）都拒，回 `error{code:"approval_invalid", ref: sessionId}`。M0 网页 PoC / 同机调试可以不配手机公钥，那时不验签。

其他拒绝码：`terminal_exists`（sessionId 已在用）、`terminal_limit`（同时最多 8 个）、`terminal_spawn_failed`。

成功后设备回 `terminal.opened{sessionId, streamId, pid?}`。`streamId` 由**设备**分配（会话内递增、关掉的不复用），手机此后用它发 kind 1 帧。子进程是用户的登录 shell（`$SHELL -l`），环境里加 `TERM=xterm-256color`、`COLORTERM=truecolor`、`CUAREMOTE_SESSION=<sessionId>`（shell 集成脚本靠它决定是否发 OSC 133）。

字节流：
- 设备 → 手机：PTY 输出按 ≤ 16 KiB 切成 kind 1 帧。窗口式背压：设备记累计发出 `sent`，手机用 `terminal.ack{sessionId, bytes}` 报**累计**收到字节数；`sent - acked` 达到 256 KiB 后设备停发、先攒着；`bytes ≤ 已确认` 或 `bytes > sent` 的 ack 忽略。攒到 8 MiB 还没人确认就认为对端死了：关 PTY，发 `terminal.exit` + `error{code:"terminal_closed"}`（宁可断也不悄悄丢字节）。手机端建议每收 32–64 KiB 或 100 ms 发一次 ack。
- 手机 → 设备：kind 1 帧原样写进 PTY，没有背压（键盘输入量很小）。
- `terminal.resize{sessionId, cols, rows}` → `TIOCSWINSZ`；`terminal.close{sessionId}` → 关 PTY（SIGHUP）。

结束：子进程退出时设备**不等 ack**把剩余输出全部发完，再发 `terminal.exit{sessionId, code?}`（被信号杀掉时没有 `code`）。手机主动 close 也会收到 `terminal.exit`（无 code）。`terminal.exit` 之后同一 `streamId` 的帧两边都丢弃。

大脑：`terminal.blocks` 工具（见下一节）由 `TerminalManager.callBlocks` 提供，`LocalBunHost({terminals})` 只在给了管理器时把它放进工具表。网页 PoC（`apps/poc-web`）目前不含终端页，终端只在 iOS app 里做。

## 终端命令块

终端会话（`terminal.open` / `terminal.data`）里的字节流原本是一整条，手机端只能当成一个滚动屏幕看。命令块把它按「一条命令 = 一块」切开：手机上可以按块折叠、复制、分享，终端模式问大脑「刚才为什么报错」时大脑也能直接看到最近几条命令和输出，而不是整屏字符。

切分靠 shell 发的 OSC 133 标记（和 iTerm2 / WezTerm / Warp 同一套）：
- `ESC ] 133 ; A BEL`：提示符开始（上一块没收到 D 也在这里收尾，比如被 Ctrl-C 打断）；
- `ESC ] 133 ; B BEL`：提示符画完，用户开始输入；
- `ESC ] 133 ; C ; cmd=<百分号编码的命令> BEL`：命令开始执行。`cmd=` 是我们自己加的参数，标准里没有；没有它时从 B→C 之间的回显里抠命令（会处理退格和颜色码）；
- `ESC ] 133 ; D ; <退出码> BEL`：命令结束；
- `ESC ] 7 ; file://host/path BEL`：当前目录。
终止符 BEL 或 `ESC \` 都认，序列被切成两个 `terminal.data` 也能拼回来。

`TerminalBlock`：`sessionId` / `blockId`（会话内递增）/ `state`（`prompt` / `running` / `done`）/ `command` / `cwd` / `exitCode` / `startedAt` / `finishedAt` / `startOffset` / `outputOffset` / `endOffset`。三个偏移量是**从会话开始累计的字节数**，和 `terminal.ack.bytes` 同一把尺，手机端用它在自己的环形缓冲里定位这块对应的字节，所以块本身不带输出内容（`terminal.data` 已经送过一遍）。

设备 → 手机：`terminal.block{block}`，块状态每变一次发一条（prompt → running → done）。同一 `blockId` 以最后一条为准。

大脑 → 宿主：`terminal.blocks` 工具（L0，daemon 实现，只在开了 shell 集成的会话里有意义）。参数 `{sessionId, limit}`，返回 JSON `{blocks: [{blockId, state, command, cwd, exitCode, output}]}`，`output` 是去掉 ANSI 的纯文本尾部（建议 ≤ 8 KiB）。终端模式的大脑在 `intent.submit` 带 `terminalSessionId` 且宿主工具表里有这个工具时，会先调一次，把最近 5 条命令块放进上下文，再看用户意图；宿主没有这个工具就跳过。

解析器参考实现 `packages/brain/src/terminal/osc133.ts`（`Osc133Parser`：`feed(bytes)` 吐出状态变化的块，`recent(n)` 拿最近几块，`plain(block)` 出纯文本），Swift daemon 照这个逻辑实现。shell 集成脚本在 `packages/brain/shell-integration/cuaremote.{zsh,bash,fish}`：daemon 打开会话时设置环境变量 `CUAREMOTE_SESSION=<sessionId>`，用户 rc 文件里按注释加一行 `source`，普通终端里不生效；daemon 安装时可以提议帮用户加这一行（要经用户确认，不能自己改 rc）。

## 计费

只有**云端大脑**跑的 run 计费。本地大脑（Mac daemon 里的 brain）用的是用户自己的 key 或本机模型，hub 看不到成本也不收钱；`usage.report` 只是统计。实现在 `apps/hub/src/billing.ts`。

规则：
- 免费层：每个自然月（UTC）`HUB_FREE_RUNS`（默认 50）次云端 run；最多绑 `HUB_FREE_DEVICES`（默认 1）台被控设备（只数已和手机配过对的）。
- 付费层：run 结束后按真实模型成本 `usd × (1 + HUB_MARGIN) × HUB_CREDITS_PER_USD`（默认 30% 加成、1 美元 = 100 credit，两位小数向上取整）扣 credit。
- run 开始前预占：先占免费次数，没有了看余额，余额 ≤ 0 或查不到余额都不开跑，手机收到 `error{code:"credits_exhausted"}`（`ref` 指向那条 `intent.submit`，不会有 `run.created`）。
- 一次 run 只扣一次（`run_billing` 表按 runId 幂等）；断线或报错的 run 按已发生的成本结算；扣款失败留着下次重试，不影响手机端。
- 免费层已满时手机再配一台**新**设备，hub 回 `error{code:"device_limit"}`。

手机 ↔ hub：`billing.get{}` → `billing.status{plan: free|paid, freeRunsTotal, freeRunsUsed, periodEndsAt, credits, creditsPerUsd, freeDeviceLimit, topUpURL?}`；HTTP `GET /api/billing` 同一份。没开计费的 hub 回 `error{code:"billing_disabled"}`。

credit 账本：`HUB_BILLING=joc` 用 JustOne Connector（`JOC_BASE_URL` / `JOC_API_KEY` / `JOC_TOPUP_URL`，路径默认 `/api/credits/balance` 与 `/api/credits/charge`，可用 `JOC_BALANCE_PATH` / `JOC_CHARGE_PATH` 改）。接口按「查余额 + 幂等扣款」的最小假设：`GET …/balance?account=` 回 `{credits}`；`POST …/charge {account, credits, ref, memo}` 回 `{credits}`，同 `ref` 再扣回 409 视为已扣。`HUB_BILLING=local` 用 hub 自己的 `credits` 表（开发 / 自建，`store.addCredits` 充值）。不设 = 关。
