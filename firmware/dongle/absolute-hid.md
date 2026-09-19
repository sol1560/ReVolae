# iPadOS 绝对坐标 HID 调研

## 结论：不确定，不能作为当前主方案

USB HID 规范允许绝对坐标，但截至本次调研，没有找到 Apple 官方资料明确承诺 iPadOS 会把**外接 USB** Digitizer Touch Screen（Usage Page `0x0D`、Usage `0x04`）当作系统触摸输入，也没有找到足够可靠的 iPad 真机复现。相反，现实中的 USB 触摸显示器通常不能直接控制 iPad。因此当前固件继续用标准相对鼠标 + 校准。

已确认的只有：

1. [USB-IF HID Usage Tables](https://www.usb.org/sites/default/files/documents/hut1_12v2.pdf) 定义了 Digitizers Page `0x0D`，Touch Screen usage `0x04`，X/Y 可以标为绝对坐标。
2. Apple 的 [HID Usage Tables](https://developer.apple.com/documentation/hiddriverkit/hid-usage-tables) 和 [Touch Screen usage](https://developer.apple.com/documentation/corehid/hidusage/digitizersusage/touchscreen) 表明 Apple 平台的软件栈认识这些 usage；这**不能证明 iPadOS 接受外接 USB 触摸屏并注入系统触摸**。
3. Apple 官方明确支持外接鼠标/触控板作为 iPad 指针设备，但公开支持文档没有承诺 USB HID touchscreen。
4. 社区有描述符在 macOS/Linux/Android 工作的记录，例如 [PJRC 讨论](https://forum.pjrc.com/index.php?threads/usb-hid-touchscreen-support-needed.32331/)，其中也说明不同系统行为并不一致，不能外推到 iPadOS。

## 候选单点触摸描述符

以下是符合 HID 规范的实验描述符，坐标为 0..32767。它不是已证实可用的 iPad 描述符：

```c
static const uint8_t absolute_touch_descriptor[] = {
  0x05, 0x0D,       // Usage Page (Digitizers)
  0x09, 0x04,       // Usage (Touch Screen)
  0xA1, 0x01,       // Collection (Application)
  0x85, 0x03,       //   Report ID 3
  0x09, 0x22,       //   Usage (Finger)
  0xA1, 0x02,       //   Collection (Logical)
  0x09, 0x42,       //     Usage (Tip Switch)
  0x09, 0x32,       //     Usage (In Range)
  0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x02,
  0x81, 0x02,       //     2 bits: tip, in-range
  0x75, 0x06, 0x95, 0x01,
  0x81, 0x03,       //     padding
  0x05, 0x01,       //     Usage Page (Generic Desktop)
  0x09, 0x30,       //     X
  0x09, 0x31,       //     Y
  0x15, 0x00,
  0x26, 0xFF, 0x7F, //     Logical Maximum 32767
  0x75, 0x10, 0x95, 0x02,
  0x81, 0x02,       //     absolute X, Y
  0xC0,
  0xC0
};
// report: [3, tip|in_range, x_lo, x_hi, y_lo, y_hi]
```

也应单独测试 Generic Desktop Mouse 下把 X/Y 的 Input 标志从 Relative 改为 Absolute。它可能被 iPadOS 忽略、被当作异常鼠标，或映射为指针而不是触摸；不要和 Digitizer 结果混为一谈。

## 实验步骤

1. 先烧录当前相对鼠标固件并记录 iPad 型号、iPadOS 版本、USB 枚举与点击结果，作为对照。
2. 新建实验分支，在同一个 HID 接口加入 Report ID 3 的上述描述符；保留键盘，暂时移除相对鼠标，避免系统选错设备。
3. 用 Linux `lsusb -v` 和 HID descriptor 解析器确认 X/Y 是 `Data,Var,Abs`，报告长度为 6 字节。
4. 接 iPad 后依次发送：悬停中心（tip=0, in-range=1）、中心按下、移动到四角、释放。录屏并确认是系统触摸、指针移动还是完全无反应。
5. 在主屏、Safari、画图 app 各测一次；测试旋转、显示缩放和锁屏重连。
6. 若 Touch Screen 无效，再把顶层 Usage 改为 Pen (`0x02`) 和 Touch Pad (`0x05`) 分开测；一次只改一个变量。
7. 只有至少两台 iPad、两个 iPadOS 大版本都能稳定绝对定位和点击，才考虑用它替代校准；否则继续保留相对鼠标。

注意：若 Digitizer 被识别为真实触摸，它可能改变应用行为，也会削弱“看起来只是普通键鼠”的兼容性。即使实验成功，也应作为可选模式，而不是静默替换鼠标。
