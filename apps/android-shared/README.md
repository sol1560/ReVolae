# Android 共享模块

`core-protocol` 是不依赖 Android 的 Kotlin/JVM 模块，供控制端与被控端复用。它包含消息数据类、帧与中继信封编解码、配对 HMAC、审批规范字符串，以及 RFC 9180 Auth 模式 HPKE。

```bash
./gradlew :apps:android-shared:core-protocol:test
```

提交进仓库的 HPKE 互通向量在 `apps/android-shared/core-protocol/test-vectors/hpke-auth.json`；测试每次也会生成一份到 `build/test-vectors/hpke-auth.json`。
