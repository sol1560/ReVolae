# 安全模型

CuaRemote 让一台手机对另一台设备发号施令，所以默认假设：hub 可能被攻破、网络可能被监听、模型可能被诱导（提示注入）、手机可能丢。下面每一节写清楚哪个部件挡哪种风险，以及挡不住什么。代码位置以 [`packages/protocol`](../packages/protocol) 与 [`packages/brain`](../packages/brain) 为准；消息细节见 [protocol.md](protocol.md)。

## 三级操作分级

按操作类型分级，不靠模型判断「敏不敏感」：

| 等级 | 例子 | 处理 |
|---|---|---|
| L0 只读 | 列目录、读文件、截屏、看运行中的应用、读命令块 | 自动放行 |
| L1 写入 | 建改删文件、跑普通脚本、AppleScript、GUI 点击输入、开关应用 | Jev 预检过且置信度够 → 自动；否则推手机确认 |
| L2 系统级 | `sudo`、装卸软件、`launchctl`、`defaults write`、钥匙串、支付 / 银行类应用、`git push --force`、`rm -rf`、打开远程终端 | 一律推手机确认（Face ID） |

静态等级 = 工具声明的等级（`ToolDescriptor.staticLevel`）+ 危险模式命中升级（[`policy.ts`](../packages/brain/src/jev/policy.ts) 里的 `L2_PATTERNS` 与 `FINANCE_HINTS`）。**Jev 只能升级不能降级**，静态 L2 不问 Jev。

已知弱点（[`packages/jev-eval`](../packages/jev-eval) 量出来的）：静态规则不解析 shell 引号，写进文档里的 `sudo` 字样也会升 L2（误报约 6.8%）；`find -delete`、`wget | bash`、读取 SSH 私钥 / 云凭据外传、`../` 路径穿越等静态规则抓不到，要靠 Jev 和作用域。规则会随评测集迭代。

## 预检顺序

`PolicyEngine.decide()` 顺序固定，不能调：

1. 静态分级；
2. 作用域：`scope.allowedDirs` / `allowedApps` / `deniedCommands`，不过直接 `deny`，不问模型；
3. Jev（TypeSafe System One Model）三问并行：操作等级（Choice）、是否符合用户原始意图（Boolean）、不可逆风险（0–1 Score），70–500 ms，不生成文本；
4. 自治档位算结论：`cautious`（risk ≤ 0.2 且置信 ≥ 0.85 才自动）/ `balanced`（0.5 / 0.6）/ `handsoff`（0.75 / 0.4）。没有 Jev 时 L1 在 cautious 与 balanced 下都要确认。

「任务是否完成」永远不在预检里问——把它和风险混在一起会让模型为了「完成」而降低风险判断。

用户在确认卡上点「以后自动」只记这一个动作的指纹（channel + 目标应用 + 详情的哈希），不会放宽同类操作。

## 手机确认 = 签名

确认不是回一个 `true`，而是手机用 Secure Enclave 的 P-256 私钥（无 SE 的平台用 Ed25519）对 `challenge + allow/deny` 签名。设备侧验四条：没过期且不晚于请求里的 `expiresAt`、nonce 没用过（记最近 1000 个）、公钥是配对时存的那把、challenge 是自己发的那条。所以：hub 伪造不了确认，重放旧确认无效，把「允许」改成「拒绝」也会验签失败。

打开远程终端等于交出一个 shell，按 L2 走同一套签名（`signTerminalOpen` / `verifyTerminalOpen`），有效期不超过 300 秒。

## 端到端加密

手机 ↔ 设备的每一帧都是 HPKE（RFC 9180，X25519 + HKDF-SHA256 + ChaCha20-Poly1305，Auth 模式）密文，AAD 绑定中继信封头，`info` 绑定收发双方 id。hub 只看得到「谁发给谁、多大、多频繁」。云端大脑是**例外**：那一档 brain 跑在 hub 里，它必须看到明文意图和截图，所以只在用户显式选 `brainLocation = cloud` 时启用，设置页要写明白。

密文同步（历史 / 截图 / 日志 / 快捷指令）用 AES-256-GCM，密钥由手机生成、经加密链路分发给同账号设备，hub 只存密文，每项单独开关，关掉即删。

## 配对

公钥交换 + 物理确认：设备打印二维码（含一次性 secret），手机扫码后带 HMAC 发请求，设备验 HMAC 并在**设备上**按 Enter 确认。没有摄像头时用 6 位码，5 分钟有效、只能用一次。之后双方只认配对时存下的公钥；解除配对（`device.unpair`）双方同时删。

## 作用域与会话

- daemon 上可以限定允许的目录、应用、禁止的命令片段；不在范围内的操作在预检第 2 步直接拒绝。
- hub 会话 token 默认 24 小时；长时间不活跃断开。
- 终端模式下模型只能看到 L0 工具和「建议命令」，其他工具即使被叫到也不执行。
- `gui.*` 只放行 cua-driver 白名单里的 19 个工具，浏览器 / 录屏 / 配置类不放。

## 数据去哪

| 数据 | 默认 | 可选 |
|---|---|---|
| 意图文字 | 手机 → 设备（密文） | 云端大脑时 hub 可见 |
| 截图 | 留在设备，模型在云上时发给模型 | 本地模型档位不出设备 |
| 操作日志 | 只写设备本地 | 开同步后以密文存 hub |
| Jev 预检输入 | 操作摘要（≤ 600 字）发给 TypeSafe | 关掉 `jevEnabled`（会更常要你确认） |
| 模型调用 | 走用户选的档位：标准 / ZDR / 自带 key / 本地 | 选 ZDR 时不支持的模型直接拒绝，不降级 |

## 挡不住的

- 用户自己确认了一个坏操作。确认卡会尽量把「要做什么、对哪里做、能不能撤销」说清楚，但最后一步是人。
- 被控设备本身已被入侵（daemon 的密钥在那台机器上）。
- 通过 GUI 自动化触及的应用内部权限：daemon 有多大权限，agent 就有多大。作用域白名单是唯一的缩小手段，建议只给需要的目录和应用。
- 云端大脑档位下 hub 运营方看到明文。自建 hub 可以避开。

## 报告漏洞

用 GitHub 的私密漏洞报告（仓库页 Security → Report a vulnerability），不要开公开 issue。收到后 72 小时内回复，修复前不公开。
