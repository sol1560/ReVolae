# 硬件、接线与烧录

## 主方案 BOM

| 数量 | 物品 | 参考价（2026 年常见零售价） | 备注 |
| --- | --- | --- | --- |
| 1 | Espressif ESP32-S3-DevKitC-1 N8R8 | US$15–20（约 Rp250k–330k） | 必须是带原生 USB OTG 口的 S3，不要买普通 ESP32 |
| 1 | USB-C 数据线 | US$5–10 | 两头 USB-C；必须传数据，不能只是充电线 |
| 1 | 小外壳/热缩管 | US$2–5 | 避免裸板短路 |
| 可选 | 有供电的 USB-C hub | US$20–40 | iPad 报“配件耗电过多”时使用 |

开发板已经把 ESP32-S3 的 USB D+/D− 接到标有 **USB/OTG** 的接口，不需要额外接线。烧录时可用另一个 `USB-to-UART` 口；接 iPad 时用原生 OTG 口。不要同时从两个口供电，除非板卡说明允许。

## 为什么主控选 ESP32-S3

- CircuitPython 的 `usb_cdc` 只实现串口，尚无 ECM/NCM；相关功能仍是 [未完成请求](https://github.com/adafruit/circuitpython/issues/10763)。所以 Pico W/XIAO RP2040 的 CircuitPython 不能满足“同一根 USB 上跑 HTTP”。
- ESP32-S3 有原生 USB OTG，Espressif 官方 `esp_tinyusb` 同时支持[复合设备、HID 与 ECM/NCM/RNDIS](https://docs.espressif.com/projects/esp-usb/en/latest/esp32s3/usb_device.html)，并有官方 `tusb_ncm` 示例。
- 采用一个 HID 接口、键盘和鼠标两个 Report ID，可少占一个端点；NCM 本身占通知 IN、数据 IN、数据 OUT。

参考项目使用 XIAO RP2040 + Arduino-Pico 6.1.0 + 自带 TinyUSB NCM 库，证明 RP2040 硬件能做复合设备。这里仍按需求把 CircuitPython RP2040 留作串口备用；如果 ESP32-S3 在特定 iPad 上枚举失败，Arduino-Pico 方案是首要回退路线。

## 烧录主方案

1. 安装 ESP-IDF 5.5.x。
2. 进入 `firmware/dongle/esp32s3/`，执行：

   ```sh
   idf.py set-target esp32s3
   idf.py build
   idf.py -p /dev/ttyACM0 flash monitor
   ```

3. 断开电脑，把板的 **USB/OTG** 口接到 iPad。
4. 在 iPad Safari 访问 `http://172.31.254.1/status`。若打不开，先看设置里是否出现 USB Ethernet，再检查本地网络权限和线材。
5. 用 iPad app 的测试页依次验证移动、左键、`a`、`Cmd+A`；最后跑校准。

RP2040 备用方案见 `rp2040/README.md`。

## iPad 设置

菜单名称会随系统版本和语言略有不同：

1. 打开“设置 → 辅助功能 → 指针控制”（有些版本在“触控 → 辅助触控 → 指针设备”）。
2. 把指针速度固定在中间附近，记录位置；若系统提供“指针加速/轨迹速度”开关，关闭加速。**部分 iPadOS 版本没有真正的关闭加速开关**，此时必须校准，不能假设线性。
3. 指针大小固定为最小或容易截图识别的值；不要在校准后更改。
4. 关闭“自动隐藏指针”，避免截图识别不到光标。
5. 打开“设置 → 隐私与安全性 → 本地网络”中 CuaRemote app 的权限。
6. 更改显示缩放、横竖屏、指针速度或系统大版本后重新校准。

## 上电与故障排查

- iPad 报耗电过多：换短线或使用有供电 hub。
- 有键鼠但无 HTTP：NCM 没枚举、DHCP 未完成或 app 没有本地网络权限。
- HTTP 正常但无键鼠：看 `/status` 的 `hidReady`，重插后先不要发宏。
- 文字错位：确认 iPad 当前键盘布局是美式英文；Unicode 必须走 app 剪贴板。
- 指针越走越偏：设置变了或截图坐标和 UIKit 坐标比例不同，重新校准并统一坐标系。
