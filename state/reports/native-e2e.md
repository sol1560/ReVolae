# 2026-09-21 原生 iPhone → Mac 验证

## 本地结果：PASS

在 sol-mac 的独立 iPhone 17 Pro 模拟器完成 local-07，不使用假模型、假设备消息或硬编码工具结果。模型为真实 ZenMux `openai/gpt-4.1-mini`。

| 检查 | 实际结果 |
|---|---|
| `xcodebuild test-without-building` | `TEST EXECUTE SUCCEEDED`，1 项测试、0 失败，92.918 秒 |
| `bun scripts/e2e/host.ts verify …/local-07` | PASS：随机文件内容正确，批准写入正确，拒绝后没有文件 |
| 批准前副作用 | 两次 `e2e.approval_pending` 时对应文件均不存在 |
| 三次模型调用 | run.ok 为 true、true、false；输入 tokens 为 3166、3260、2113 |
| `swift test --package-path packages/protocol/swift -j 4` | 7 PASS，含 TS / CryptoKit 双向加密向量、篡改/重放拒绝、P-256 allow/deny 签名与过期边界 |
| `swift test --package-path apps/daemon-macos -j 4` | 1 PASS；另已实测原生 CLI start → JWT 登录 → 配对 → status → stop |
| 整合后 `bun test` | 203 PASS、0 FAIL、1028 个断言；既有单元测试不代替上方真实 E2E |
| `bun run typecheck`、脚本严格类型检查、Python 编译、actionlint、`git diff --check` | PASS |

实际界面检查通过：读取页面展示原始工具输出；确认页面显示完整命令、明确的软件签名限制、批准及拒绝按钮；拒绝结果显示“用户拒绝了这一步，未执行”。执行记录里的“Mac 已收到任务”不表示该命令已经执行。

## 发现并修复

- 模拟器禁用签名导致 Keychain -34018，改用本地 ad-hoc 签名。
- 键盘遮挡字段/按钮；输入清理不正确造成前后任务拼接。
- 模型总结可能不复述文件内容，界面改为独立展示原始工具输出，测试精确比对。
- Swift 6 后台信号处理发生线程断言，改为显式 Sendable 回调并验证停止操作。
- 当前模拟器会报告 SecureEnclave.isAvailable=true，但不等于真实 iPhone 身份认证可用。模拟器构建使用独立命名空间下的真实软件 P-256；非模拟器硬件创建、恢复及认证失败不降级。

## 可查看的证据

- `.amp/in/artifacts/native-e2e.mp4`：76.36 秒成功录像，配对后开始，只录模拟器。
- `.amp/in/artifacts/03-real-file-read.png`、`04-awaiting-approval.png`、`07-denied-result.png`：已检查的实际截图。
- `.amp/in/artifacts/native-e2e-verification.json`：Mac 文件核验结果。
- `.amp/in/artifacts/native-evidence.tgz`：干净测试日志、宿主事件、六张截图、录像及核验 JSON。
- 截图中的十六进制串是随机文件内容，不是登录令牌。原始含短期凭据的 xcresult 不放入交付包。

## 尚未完成及范围

- GitHub 双 runner 工作流仅通过语法检查，尚未执行；等待用户批准新的模型密钥存储位置及测试分支推送。
- 两个并发 macos-26 job 分别承担接收端及 iPhone 模拟器发送端，不存在独立的 GitHub iPhone 硬件 runner。
- 模拟器测试不验证真机 Face ID / 设备密码；Mac 入口是原生 CLI，不是菜单栏 GUI。SSH、终端、iPad、Android 等旧计划不在本次完成声明内。
- 本任务所有 Mac 测试服务已停止，独立模拟器已关闭，临时 model.env 已删除；未推送、部署或保存 Actions secrets。
- VM 只完成可行性研究：建议 4 vCPU、16 GiB、120 GB 虚拟盘，并限制镜像与缓存总占用为 160 GB。未安装；默认 NAT 不能保证与主机网络隔离。
