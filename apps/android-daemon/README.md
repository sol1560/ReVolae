# CuaRemote Android 被控端

Android 10（API 29）以上。它通过出站 WebSocket 连接 hub，以 HPKE Auth 模式收发端到端帧，并执行 `android.*` 工具。

## 构建与安装

```bash
./gradlew :apps:android-daemon:app:assembleDebug
adb install -r apps/android-daemon/app/build/outputs/apk/debug/app-debug.apk
```

## 首次使用要开的权限

1. 在应用首页进入系统设置，打开 **CuaRemote 无障碍服务**（读取元素树、点击、输入、滑动和按键）。
2. 点“授权录屏”，接受系统的 MediaProjection 提示（截屏；重启后需要重新授权）。
3. 在系统设置打开 **通知使用权**（读取当前通知；未开启时工具明确返回错误）。
4. 填写 hub 的 `wss://` 地址和设备标识后启动连接。应用只建立出站连接。

无障碍节点的 `index` 只在一次 `android.ui_tree` 结果和紧接着的操作之间有效；界面变化后应重新读取。
