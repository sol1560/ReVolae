# RP2040 CircuitPython 备用固件

目标板：**Seeed Studio XIAO RP2040**（推荐，小）或 Raspberry Pi Pico W。两者在 CircuitPython 下都只能作为 USB HID + USB CDC 串口设备使用；Pico W 的 Wi-Fi 不会变成插线即用的 USB 网络。

CircuitPython 当前 `usb_cdc` 只提供 CDC-ACM 串口。ECM/NCM 仍是待实现功能，见 [CircuitPython issue #10763](https://github.com/adafruit/circuitpython/issues/10763)。因此这个目录不是 HTTP 主方案。

## 安装

1. 下载对应板子的 CircuitPython 9.x UF2。
2. 按住 BOOT，把板接电脑，将 UF2 拖进 `RPI-RP2`。
3. 用 `circup install adafruit_hid` 安装库。
4. 把 `boot.py` 和 `code.py` 复制到 `CIRCUITPY` 根目录。
5. 重插后，用 115200 波特率打开第二个 USB CDC data 串口，每行发送一个 JSON。

串口格式把 HTTP 路径放在 `path` 字段：

```json
{"path":"/mouse/move","dx":20,"dy":-5}
{"path":"/key/type","text":"hello"}
{"path":"/macro","steps":[{"action":"key.press","key":"enter"},{"delayMs":50}]}
```

固件每行回复 `{"ok":true}` 或 `{"ok":false,"error":"..."}`。Unicode 与主协议一样不伪造：非 ASCII 会报错，iPad app 应走剪贴板后发 `Cmd+V`。

> 参考项目证明 XIAO RP2040 使用 **Arduino-Pico + 自带 TinyUSB NCM 库**可以实现 HID + NCM，但那不是 CircuitPython。若 ESP32-S3 真机兼容性不理想，可以把参考项目的 NCM 实现作为下一候选，而不是误以为 `usb_cdc` 就是网络。
