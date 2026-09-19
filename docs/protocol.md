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
| `android.adb` | `{serial, cmd}` | 1 | M4 |

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
