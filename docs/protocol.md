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

手机收到 `step.approval_required{challenge, expiresAt}`，用 Secure Enclave P-256 私钥对 `approvalSignedPayload(challenge, allow)`（UTF-8）做 ECDSA-SHA256，回 `approval.decision{signature:{alg:"ES256", keyId, sig(base64 raw r||s), expiresAt, nonce}}`。宿主：

1. `expiresAt` 未过期且 ≤ 请求时的 `expiresAt`；
2. `nonce` 未用过（宿主保留最近 1000 个）；
3. 用配对时存的手机签名公钥验签；
4. `challenge` 与自己发出的一致（宿主按 runId+stepId 缓存）。

`challenge = approvalChallenge({runId, stepId, actionDetail, nonce, expiresAt})`，两端实现见 `frame.ts` / `Frame.swift`，测试向量在 `swift/Tests/.../fixtures/binary.json`。

## 端到端加密

HPKE（RFC 9180）：DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305，Auth 模式（发送方用自己的 X25519 静态私钥认证）。每个方向一个上下文，`info = "cuaremote-v1|" + from + "|" + to`，每帧 `seal(aad = RelayEnvelope 头部字节, pt = Frame 字节)`。会话建立：先发 `enc`（32 字节）作为第一帧 body，之后都是密文。TS 实现在 `apps/hub`/`packages/brain` 共用的 `packages/protocol/src/hpke.ts`（M1），Swift 用 CryptoKit `HPKE.Sender/Recipient`，测试向量 `fixtures/hpke.json`。

## 配对

Mac `cuaremote pair` 打印 `PairOffer` 二维码（JSON）。手机扫码后：
1. 手机连 hub，发 `pair.request{deviceId, phoneId, phonePubKeys, hmac}`，`hmac = HMAC-SHA256(secret, deviceKem || phoneKem)`（base64 原始字节拼接）。
2. hub 转给设备；设备验 HMAC、检查 `expiresAt`、终端提示「iPhone 请求配对，按 Enter 确认」，回 `pair.confirm`。
3. hub 把 `pair.result` 发给双方，双方保存对方 `PublicKeys`。
