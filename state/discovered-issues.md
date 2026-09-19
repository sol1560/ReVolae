# Discovered issues（超出 spec 范围，记录不处理）

## 2026-09-19 F0.6 期间发现
- PolicyEngine 缓存把 verdict 一起缓存，导致「以后自动」第二次仍然要确认。已修：缓存只存 Jev 评估，verdict 每次重算（policy.test 新增用例）。
- @cuaremote/brain 的 package.json 没有 main/exports，跨包导入解析不到。已补。
- LocalBunHost 在 Linux 上 `sh -l` 会打印 `source: not found`（orb 的 profile 问题，Mac 用 zsh 不受影响）。未处理。
- PoC 页面「自主程度」下拉目前只是提示，真正的档位由服务端 --autonomy 决定；正式版走 privacy.set。
