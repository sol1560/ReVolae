# Blocked（需要 Sol 亲手做）

## 2026-09-21 当前请求
- 本轮原生五栏及v2的 iPhone 模拟器 → Mac E2E 已通过；完整功能仍在做，以产品验收清单为准。
- GitHub 联测尚未执行：需要批准把现有 ZENMUX_API_KEY 保存到 sol1560/ReVolae 的 Actions Secrets，并推送 e2e/native-iphone-mac 测试分支触发两个并发 macOS job；不合并 main、不部署。
- 此次没有把模型密钥写入 GitHub。Mac在local-16完成后已删除临时model.env并清理xctestrun测试字段；orb侧私有配置仍供后续实现验证，按600保存，全部回归完成后删除。凭据只能用私有文件工具传送，不能在命令或消息中打印；纯视觉补测不重新传模型凭据。
- 当前Mac辅助功能和录屏未授权；不能自动修改，界面/画面验收需用户在系统设置授权。本机配对确认不等于系统授权，二者单独测试。
- 本机配对诊断曾实际点击拒绝并返回accept:false；但local-12正式确认及随后独立诊断无法读取确认窗。采样证明停在NSAlert.runModal，窗口列表显示在屏幕上，不能猜测为未显示或盲点。诊断及host已停止，新人工配对仍未验收。local-14使用严格核对后复制的旧身份/配对与新随机任务，Mac报告完整扩展通过，不能替代新人工确认验收。
- 原生线程随后只读检查CGSession发现当前screenLocked=true、onConsole=true；它是本次窗口验收的明确阻塞，不能倒推local-12当时一定同因。需要用户解锁后再验收新人工配对与新版Mac窗口，不需要为此切换系统权限。local-14证据包及7项源码已独立核验，录像已交付。
- Bun1.3.9/1.3.10把远端WebSocket关闭1001报告为1000；保守不自动重连。1006/1012/1013分类测试通过，不放宽普通1000及认证/身份异常。Mac及iPhone模拟器原生有限自动重连均已通过真实网络测试；仅从已认证连接的明确网络错误开始，新连接认证前失败仍停止，不承诺持续离线无限恢复。
- 真机 Face ID、iPad dongle、Android硬件、推送证书和真实计费服务尚未验收。尚未写完的UI/宿主功能不是外部阻塞，继续实施。

## 旧任务书的历史记录（不代表本次功能均已实现）

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
