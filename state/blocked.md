# Blocked（需要 Sol 亲手做）

| 项 | 为什么自动做不了 | 代码侧已准备到什么程度 |
|---|---|---|
| macOS 辅助功能 / 录屏 / Automation 授权 | TCC 弹窗只能人点 | `cuaremote setup` 会检测并引导 |
| ANTHROPIC / OPENAI / TYPESAFE API key | 只有 KIMI key | 环境变量 / 设置页填入即可 |
| Apple 开发者证书、真机、App Store、APNs 证书 | 账号持有人操作 | 模拟器可跑；APNs 无证书时 dry-run |
| iPad dongle 板子采购与刷固件 | 硬件 | 固件与校准代码已写，附刷写说明 |
| ZDR 账号签约、JOC 计费密钥 | 商务 | hub 里档位标签与计费接口已留 |
| Ollama / LM Studio 拉模型（~40GB） | 大下载，runner 线程会尝试，失败则留在这 | 适配器已写 |

## 2026-09-19 13:07 runner sol-mac 离线
- `list_runners` 返回空。Swift daemon（F1.4）与 iOS app（F1.5…）线程无法创建。orb 侧继续 F0.3–F0.7 / M1 hub / M2 固件 / M4 android；每完成一个 feature 重查一次 runner。
- 交付包已备好：`.amp/cuaremote-kit.tgz`（Swift 协议包 + mock 大脑 + docs/protocol.md），runner 恢复后 `upload_thread_file` 到 `/Users/sol/cuaremote-kit.tgz`。
