# Apple 客户端核心

`packages/apple` 提供适用于 iOS 18 和 macOS 15 的 `CuaRemoteCore`。它包含协议、身份、传输、配对和信任逻辑；不包含 SwiftUI 界面、Mac 工具执行或 brain 进程。

## 创建并连接

```swift
import CuaRemoteCore
import CuaRemoteProtocol

let client = try RemoteClient(role: .phone, name: "iPhone")
client.onControl = { peerId, message in /* 更新应用状态 */ }
client.onFrame = { peerId, frame in /* 处理 PTY / 媒体帧 */ }
client.onTransportEnded = { /* 取消 daemon 管理的任务 */ }
try await client.connect(to: hubURL, token: token)
```

默认初始化器从 Keychain 读取或创建持久身份；测试可注入 `SecureValueStore` 或现成的 `DeviceIdentity`。ES256 使用 CryptoKit P-256，线上签名为 64 字节 raw `r || s`，公钥为 X9.63 格式。X25519 和签名私钥保存在 Keychain，访问级别为 `WhenUnlockedThisDeviceOnly`。Hub token 由 UI 作为 `connect` 参数传入，不会持久化。

`RemoteClient` 使用 hub 现有的 `hello → auth.challenge → auth.response → auth.ok` 流程，并对 UTF-8 `cuaremote-hub-auth-v1\n<deviceId>\n<nonce>` 签名。默认使用 `wss`。只有显式设置 `allowInsecureLocalDevelopment: true` 且主机为本机或局域网地址时才允许 `ws`，不能用于公网主机。

`status`、`peers` 和 `readyPeers` 暴露传输状态、已 pin 对端及链路就绪状态。两种角色都在认证后收到对端在线 presence 时，各自发送一次 FreshLink hello。`peer.keys` 只检查现有 pin；未知密钥或被替换的密钥会触发安全事件，不会被自动信任。离线 presence 或传输断开会清除会话。宿主应在 `onTransportEnded` / `onPeerUnavailable` 中取消任务；核心不会悄悄重放帧。`send(_:to:)` 仅向链路就绪且已 pin 的对端发送生成的 `AnyMessage`；`sendFrame(_:to:)` 可发送其他 `Frame`。非控制帧通过 `onFrame` 回调。

## 配对

设备调用 `makePairOffer()`，返回可用于二维码或手动转发的 JSON，内容包括当前 hub URL、身份公钥、随机 16 字节 secret，以及最多五分钟的过期时间。手机调用 `acceptPairOffer(json:phoneName:)` 校验 URL、公钥长度和过期时间，计算协议 HMAC，暂存配对并发送 `pair.request`。设备通过 `pendingPairRequest` / `onPendingPairRequest` 展示待确认请求；只有本地用户确认后才调用 `confirmPair(deviceId:phoneId:)`。

只有成功且与暂存 tuple 匹配的 `pair.result` 才会提交信任。对端信任写入 Keychain，并按本机身份与 hub URL 隔离。不会接受未请求的结果，也不会替换不一致的 pin。`unpair(_:)` 发送既有 `device.unpair` 消息并清理本地信任和会话；收到 `pair.removed` 时也会清理。

`PairingCrypto`、`PeerTrustStore` 和 `PairingCoordinator` 可配合内存版 `SecureValueStore` 使用，无需 Keychain 或网络即可测试。

## 原生宿主边界

后续 macOS 宿主可用 `onControl` 作为受授权工具的边界，例如 `shell.run`、`applescript.run`、`shortcuts.run`、`fs.read` 和 `fs.list`；核心本身不执行这些工具。Apple Events/TCC 授权由未来的宿主处理，不自动回退到盲目 CUA。Brain `--native` 模式保持谨慎：拒绝、策略阻止或工具失败都会结束任务。
