# Dongle HTTP JSON 接口

主方案地址：`http://172.31.254.1`，只通过 iPad 与 dongle 之间的 USB NCM 子网访问。所有回复都是 JSON。动作成功入队返回 `202`；参数错误返回 `400`；队列放不下返回 `409`；请求体上限 16 KiB。

## 接口

| 方法与路径 | 请求体 | 说明 |
| --- | --- | --- |
| `GET /status` | 无 | 返回 `device`、`hidReady`、`busy`、累计 `reports` |
| `POST /mouse/move` | `{"dx":20,"dy":-5}` | 相对 HID 增量；单轴范围 ±32767，自动拆成 ±127 的报文 |
| `POST /mouse/click` | `{"button":"left","count":1}` | `left/right/middle`，次数 1..3，每次均按下后释放 |
| `POST /mouse/scroll` | `{"dx":0,"dy":-2}` | 水平 pan 与垂直 wheel，范围 ±127 |
| `POST /key/press` | `{"key":"enter","modifiers":["cmd"]}` | 单字符或命名键；修饰键为 `ctrl/shift/alt/option/cmd/command/meta` |
| `POST /key/type` | `{"text":"hello"}` | 最多 1024 个美式键盘 ASCII 字符 |
| `POST /macro` | 见下 | 最多 128 个步骤，一次排队，减少 HTTP 往返 |

命名键：`enter escape backspace tab space delete left right up down home end`。

宏示例：

```json
{
  "steps": [
    {"action":"mouse.move","dx":20,"dy":-5},
    {"delayMs":30},
    {"action":"mouse.click","button":"left","count":1},
    {"action":"key.type","text":"hello"},
    {"action":"key.press","key":"enter","modifiers":[]}
  ]
}
```

单次等待为 1..5000 ms，一批宏的显式等待总和不超过 10000 ms。一个 HTTP `202` 只表示动作已入队；需要确定完成时轮询 `/status`，直到 `busy=false`。不要在结果不明时自动重发，否则可能重复点击或输入。

## Unicode

USB boot keyboard 报告发送的是物理键位，不携带 Unicode。固件只按美式布局可靠输入 ASCII；遇到非 ASCII 会明确返回 `400`，绝不把中文误打成其它字符。

输入中文、emoji 等内容时，由 iPad app 把 UTF-8 文本写入系统剪贴板，然后调用：

```json
{"key":"v","modifiers":["cmd"]}
```

这需要 iPad app 在前台且拥有写剪贴板能力。如果未来要避免剪贴板，可在 app 与 dongle 协议之外增加输入法适配，但不能假定用户启用了某种 Unicode Hex Input 键盘。

## HID 时序

- 普通鼠标、滚轮、键盘按下、键盘释放之间固定至少 **15 ms**。这是参考实现采用并在 iPad/iPhone 上实测过的保守值。
- 点击的按下与释放各占一个报文，中间 15 ms。
- 目标移动完成到点击建议在宏中额外等 **30 ms**，让 iPadOS 完成指针合成。
- 校准期间必须保持每个增量为独立报文；不能合并，否则 iPadOS 加速结果不同。
- 固件队列严格串行发送，不同时按住鼠标按钮并处理新的 HTTP 请求。

真机若出现丢键，先把间隔提高到 20 ms；不要低于 HID 描述符的 10 ms轮询间隔。iPadOS 升级后要重新做长文本和组合键测试。

## 安全边界

此版本依靠 USB 私有子网隔离，没有应用层令牌。不要把 `172.31.254.1` 路由到其它网络。生产版可加入每台板唯一密钥请求头，但密钥不能硬编码在公开仓库。
