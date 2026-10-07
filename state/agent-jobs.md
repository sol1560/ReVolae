| id | kind | target | status | notes |
|---|---|---|---|---|
| T-01a0c39c-d19b-70ba-97a6-796b65826178 | runner sol-mac | 恢复原设计、接真实页面、Mac常驻与原生E2E | RUNNING | pages-14及native-foundation-18已收并核对；扩展页面待完整复跑。Keychain路径/清理和常驻实际进程测试通过；人工确认已实际拒绝，准备全新配对。已传TS foundation-15至18，18修复批准等待时关闭挂住。继续重命名/解绑、重连及local-12联测；开机自启/自动重连尚未完成。独占原生手写源码；orb负责TS/生成Swift/Android。临时凭据600保留供回归，完成后删。未推送或写Actions secrets |

## 2026-09-19 13:35 已创建的并行线程（orb）
| 线程 | 范围 | 状态 |
|---|---|---|
| T-01a0b9e0-5482-775c-8305-05d5f2e9dea9 | F4.2 apps/android-daemon、F4.3 apps/android、F4.4 UI | RUNNING（已上传 kit） |
| T-01a0b9e1-33fc-72fc-ada2-36d89ca6b5c0 | F2.1 firmware/dongle、F2.2 校准、absolute-hid 调研 | RUNNING |
| T-01a0b9e2-1583-7465-994e-5271f77f815b | F0.7 packages/jev-eval | RUNNING（已上传 kit） |
| （待 runner 上线）线程 A | apps/daemon-macos + F0.8 本地模型 | 未创建，runner 离线 |
| （待 runner 上线）线程 B | apps/ios | 未创建，runner 离线 |

回收：`download_thread_changes(thread, destination=/home/user/workspace/repo, paths=[...])`，然后本地 commit。
