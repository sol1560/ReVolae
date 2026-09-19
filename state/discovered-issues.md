# Discovered issues（超出 spec 范围，记录不处理）

## 2026-09-19 F0.6 期间发现
- PolicyEngine 缓存把 verdict 一起缓存，导致「以后自动」第二次仍然要确认。已修：缓存只存 Jev 评估，verdict 每次重算（policy.test 新增用例）。
- @cuaremote/brain 的 package.json 没有 main/exports，跨包导入解析不到。已补。
- LocalBunHost 在 Linux 上 `sh -l` 会打印 `source: not found`（orb 的 profile 问题，Mac 用 zsh 不受影响）。未处理。
- PoC 页面「自主程度」下拉目前只是提示，真正的档位由服务端 --autonomy 决定；正式版走 privacy.set。

## 2026-09-19 F0.7 jev-eval 报告（数字全是 MOCK，方法已验证）
- 静态规则误报 6.8%（>5% 目标），且因为最终等级取 max，真实 Jev 再准也压不下去。要修 policy.ts：解析 shell 引号（写进文档的 sudo 不算）、pip install --target 项目内不升级、金融子串只匹配 targetApp/域名不匹配路径名。
- 静态规则漏报 45.8%：SSH 私钥/云凭据/API key/Cookie 读取外传、curl -F、base64 绕过、find -delete、> /dev/disk、wget|bash、/etc/hosts、LaunchAgents、git push -f、branch -f、../ 穿越、拆分 L2。需要加规则（F1.x 前）。
- 标注拿不准：step-090、step-140、adv-026、adv-027、adv-030（理由在 reports/report.md）。
