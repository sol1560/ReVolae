# CuaRemote iPad 输入 Dongle

这个目录实现插在 iPad USB-C 口上的复合设备：USB 键盘、相对坐标鼠标和 USB 网络适配器。iPad app 通过固定 USB 子网向 dongle 发 HTTP JSON，dongle 再发真实 HID 报文。

## 方案

- `esp32s3/`：主方案。ESP32-S3 + ESP-IDF + TinyUSB，目标是 HID + NCM 复合设备和板载 HTTP 服务。
- `rp2040/`：CircuitPython 备用方案。它只有 HID + USB CDC 串口 JSON，因为 CircuitPython 的 `usb_cdc` 是串口，不是 ECM/NCM 网络。
- `protocol.py`：与硬件无关的请求校验、按键映射、宏展开和发送间隔规则，也是固件行为的可执行规格。
- `tests/`：上述纯逻辑的 pytest 测试。
- `calibration/`：相对鼠标加速曲线校准和绝对目标转增量算法。

接口见 [`protocol.md`](protocol.md)，采购与烧录见 [`hardware.md`](hardware.md)，绝对坐标 HID 调研见 [`absolute-hid.md`](absolute-hid.md)。

## 本地检查

```sh
python3 -m py_compile firmware/dongle/protocol.py firmware/dongle/rp2040/code.py firmware/dongle/rp2040/boot.py
pytest -q firmware/dongle/tests
cd firmware/dongle/calibration
bun test
bunx tsc --noEmit
```

没有接板时，ESP-IDF 部分只能检查源代码和配置；USB 枚举、iPad NCM 驱动、HID 时序仍必须用真机验证。
