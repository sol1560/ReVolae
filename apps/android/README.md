# CuaRemote Android 控制端

Android 10（API 29）以上，Jetpack Compose + Material 3。包含多设备列表、意图输入与步骤时间线、审批卡片、操作历史和隐私设置。

```bash
./gradlew :apps:android:app:assembleDebug
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

## 权限和安全

- 扫码配对会调用相机；二维码内容必须是协议里的 `PairOffer` JSON。
- 审批时系统会弹出 BiometricPrompt。应用在 Android Keystore 生成 P-256 密钥，要求每次使用都通过强生物识别认证。
- 私钥不可导出；签名是 ECDSA-SHA256 的 64 字节 raw `r || s`，不是 DER。
- 控制端不需要无障碍、通知或录屏权限；这些权限只在被控端开启。
