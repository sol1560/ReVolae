# ESP32-S3 主固件

主目标板是 **Espressif ESP32-S3-DevKitC-1（N8R8）**。原生 USB OTG 口枚举为 NCM 网络 + 一个 HID 接口；HID 内用 Report ID 区分键盘和鼠标。固定地址为 `172.31.254.1/29`，板上 DHCP 给 iPad 分配地址，HTTP 监听 80 端口。

代码基于 ESP-IDF 5.5+ 和 `espressif/esp_tinyusb` 2.x。官方明确支持 ESP32-S3 的复合 USB 设备、ECM/NCM/RNDIS 和 HID，参考 [USB Device Stack](https://docs.espressif.com/projects/esp-usb/en/latest/esp32s3/usb_device.html)。

## 构建与烧录

```sh
. "$HOME/esp/esp-idf/export.sh"
cd firmware/dongle/esp32s3
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

烧录使用板上的 `USB-to-UART` 口或按住 BOOT 后用原生 USB；实际连接 iPad 时必须插标有 **USB/OTG** 的原生口。首次真机测试先访问 `GET http://172.31.254.1/status`，再在空白文本框验证单键和小幅鼠标移动。

## 尚需真机验证

- iPadOS 是否接受这个 NCM + HID 描述符组合，DHCP 是否自动拿到地址。
- 不同 iPadOS 版本下 15 ms 报文间隔是否仍无丢键。
- USB-C 线材、板载 LDO 峰值及 iPad 供电是否稳定。

`http_api.c` 是 HTTP 到 HID 队列的实现；`usb_descriptors.c` 是 NCM + 键鼠描述符；`usb_network.c` 把 TinyUSB NCM 接入 lwIP；`hid_output.c` 串行发送 HID 报文。HTTP 对照逻辑另有可在电脑上跑的 `../protocol.py` 和 pytest。
