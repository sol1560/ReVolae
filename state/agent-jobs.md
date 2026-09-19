| id | kind | target | status | notes |
|---|---|---|---|---|

## 2026-09-19 13:35 已创建的并行线程（orb）
| 线程 | 范围 | 状态 |
|---|---|---|
| T-01a0b9e0-5482-775c-8305-05d5f2e9dea9 | F4.2 apps/android-daemon、F4.3 apps/android、F4.4 UI | RUNNING（已上传 kit） |
| T-01a0b9e1-33fc-72fc-ada2-36d89ca6b5c0 | F2.1 firmware/dongle、F2.2 校准、absolute-hid 调研 | RUNNING |
| T-01a0b9e2-1583-7465-994e-5271f77f815b | F0.7 packages/jev-eval | RUNNING（已上传 kit） |
| （待 runner 上线）线程 A | apps/daemon-macos + F0.8 本地模型 | 未创建，runner 离线 |
| （待 runner 上线）线程 B | apps/ios | 未创建，runner 离线 |

回收：`download_thread_changes(thread, destination=/home/user/workspace/repo, paths=[...])`，然后本地 commit。
