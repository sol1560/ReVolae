"""在 USB 枚举前启用独立 data 串口；HID 使用 CircuitPython 默认设备。"""

import usb_cdc

usb_cdc.enable(console=True, data=True)
