# @cuaremote/hub

手机和被控设备之间的中继。只做四件事：认证（公钥挑战应答）、配对撮合、转发端到端密文、离线推送 + 计量。它看不到指令内容。

```sh
bun run apps/hub/src/server.ts --port 8788 --db hub.db
```

| 环境变量 | 作用 |
|---|---|
| `HUB_PORT` / `HUB_DB` | 端口、SQLite 路径（默认 8788 / hub.db） |
| `HUB_JWT_SECRET` | 设了就是多账号模式：手机必须带 HS256 JWT（`sub` = 账号）。不设 = 单机模式 |
| `HUB_PUBLIC_URL` | 写进配对码 / 二维码的 ws 地址 |
| `APNS_TEAM_ID` `APNS_KEY_ID` `APNS_KEY_PEM` `APNS_TOPIC` `APNS_SANDBOX` | 四个都给才真发 APNs，否则推送只记账（dry-run）。APNs 走 HTTP/2，这条没在真实证书上验过 |

协议细节见 `docs/protocol.md`「hub 登录与中继」「配对」。测试：`bun test apps/hub`（起真实 Bun.serve，跑完整配对 + HPKE 中继 + 推送 + 多账号隔离）。
