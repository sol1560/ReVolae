# App Store 材料

这个目录是 iOS app 上架用的非代码文件，Xcode 工程建好后按下面接进去（runner B 的活）。签名、账号、提审都要 Sol 亲手。

| 文件 | 接到哪 |
|---|---|
| `PrivacyInfo.xcprivacy` | 拖进 app target（Copy Bundle Resources）。申报了 UserDefaults / 文件时间戳 / 系统启动时间三类 API 和两类收集数据（账号 id、用户输入的指令）；用到新的受限 API 要补 |
| `InfoPlist-usage.strings` | 权限用途文案，放进 `zh-Hans.lproj/InfoPlist.strings`，英文版在注释里；另有 `NSBonjourServices` / `UIBackgroundModes` / `ITSAppUsesNonExemptEncryption` 三个键要加进 Info.plist |
| `fastlane/` | 整个目录移到 `apps/ios/fastlane/`。`Appfile` 的 bundle id 现在是 `dev.cuaremote.app`（占位，和工程一致即可）；账号信息走环境变量 |
| `fastlane/metadata/` | 中英文商店文案、关键词、更新说明、审核备注。文案里承诺的功能（语音、iPad、多设备、SSH）以实际版本为准，删掉没做的 |
| `scripts/screenshots.sh` | 不用 fastlane 的截图脚本，靠 `-CUAREMOTE_DEMO 1 -CUAREMOTE_SCREEN <页面>` 两个启动参数进演示模式并直达页面，app 里要实现这两个参数 |

审核用的演示模式：不连真实 hub，内置一台假设备，能走完「发指令 → 看步骤 → Face ID 确认 → 开终端」。这是审核员没有 Mac 也能验收的唯一办法，必须做。

上架前 Sol 要做：Xcode 登录开发者账号生成证书；App Store Connect 建 app 记录并设 bundle id；`Deliverfile` 里的隐私政策 / 支持 URL 换成正式地址；确认出口合规（目前按「只用标准加密」填 `ITSAppUsesNonExemptEncryption = NO`）。
