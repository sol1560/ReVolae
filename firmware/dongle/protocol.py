"""硬件无关的 CuaRemote dongle 请求校验与动作展开。"""

from dataclasses import dataclass
import json
import time

MAX_BODY = 16_384
MAX_STEPS = 128
MAX_TOTAL_DELAY_MS = 10_000
REPORT_INTERVAL_MS = 15
MAX_DELTA = 127

BUTTONS = {"left": 1, "right": 2, "middle": 4}
MODIFIERS = {"ctrl": 0x01, "shift": 0x02, "alt": 0x04, "option": 0x04,
             "cmd": 0x08, "command": 0x08, "meta": 0x08}
KEYS = {
    "enter": 0x28, "escape": 0x29, "backspace": 0x2A, "tab": 0x2B,
    "space": 0x2C, "delete": 0x4C, "right": 0x4F, "left": 0x50,
    "down": 0x51, "up": 0x52, "home": 0x4A, "end": 0x4D,
}


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class Event:
    kind: str
    values: tuple
    delay_ms: int = REPORT_INTERVAL_MS


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ProtocolError(f"{name} 必须是 {low}..{high} 的整数")
    return value


def _ascii_key(character):
    if "a" <= character.lower() <= "z":
        return ord(character.lower()) - ord("a") + 0x04, 0x02 if character.isupper() else 0
    if "1" <= character <= "9":
        return ord(character) - ord("1") + 0x1E, 0
    if character == "0":
        return 0x27, 0
    simple = {" ": (0x2C, 0), "\n": (0x28, 0), "\t": (0x2B, 0),
              "-": (0x2D, 0), "=": (0x2E, 0), "[": (0x2F, 0), "]": (0x30, 0),
              "\\": (0x31, 0), ";": (0x33, 0), "'": (0x34, 0), "`": (0x35, 0),
              ",": (0x36, 0), ".": (0x37, 0), "/": (0x38, 0)}
    shifted = {"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
               '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
               "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6",
               "&": "7", "*": "8", "(": "9", ")": "0"}
    if character in simple:
        return simple[character]
    if character in shifted:
        key, _ = _ascii_key(shifted[character])
        return key, 0x02
    raise ProtocolError("HID 键盘只能可靠输入美式布局 ASCII；Unicode 请由 iPad app 写剪贴板后发送 Cmd+V")


def _split_delta(dx, dy):
    while dx or dy:
        sx = max(-MAX_DELTA, min(MAX_DELTA, dx))
        sy = max(-MAX_DELTA, min(MAX_DELTA, dy))
        yield Event("mouse", (0, sx, sy, 0))
        dx -= sx
        dy -= sy


def expand_action(route, body):
    if route == "/mouse/move":
        dx = _integer(body.get("dx"), "dx", -32767, 32767)
        dy = _integer(body.get("dy"), "dy", -32767, 32767)
        return list(_split_delta(dx, dy))
    if route == "/mouse/click":
        button = BUTTONS.get(body.get("button", "left"))
        if button is None:
            raise ProtocolError("button 必须是 left、right 或 middle")
        count = _integer(body.get("count", 1), "count", 1, 3)
        return [event for _ in range(count) for event in
                (Event("mouse", (button, 0, 0, 0)), Event("mouse", (0, 0, 0, 0)))]
    if route == "/mouse/scroll":
        dx = _integer(body.get("dx", 0), "dx", -127, 127)
        dy = _integer(body.get("dy", 0), "dy", -127, 127)
        return [Event("mouse", (0, 0, 0, dy)), Event("pan", (dx,))] if dx else [Event("mouse", (0, 0, 0, dy))]
    if route == "/key/press":
        name = body.get("key")
        if not isinstance(name, str):
            raise ProtocolError("key 必须是字符串")
        if len(name) == 1:
            key, implicit = _ascii_key(name)
        else:
            key, implicit = KEYS.get(name.lower()), 0
        if key is None:
            raise ProtocolError("未知按键")
        modifiers = body.get("modifiers", [])
        if not isinstance(modifiers, list) or any(item not in MODIFIERS for item in modifiers):
            raise ProtocolError("modifiers 含未知修饰键")
        mask = implicit
        for item in modifiers:
            mask |= MODIFIERS[item]
        return [Event("key", (mask, key)), Event("key", (0, 0))]
    if route == "/key/type":
        text = body.get("text")
        if not isinstance(text, str) or len(text) > 1024:
            raise ProtocolError("text 必须是最多 1024 字符的字符串")
        events = []
        for character in text:
            key, mask = _ascii_key(character)
            events.extend((Event("key", (mask, key)), Event("key", (0, 0))))
        return events
    raise ProtocolError("未知接口")


def parse_request(route, raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    if len(raw.encode("utf-8")) > MAX_BODY:
        raise ProtocolError("请求体过大")
    try:
        body = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProtocolError("JSON 无效") from error
    if not isinstance(body, dict):
        raise ProtocolError("请求体必须是 JSON 对象")
    if route != "/macro":
        return expand_action(route, body)
    steps = body.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        raise ProtocolError(f"steps 数量必须是 1..{MAX_STEPS}")
    events, total_delay = [], 0
    for step in steps:
        if not isinstance(step, dict):
            raise ProtocolError("每个 step 必须是对象")
        if "delayMs" in step:
            delay = _integer(step["delayMs"], "delayMs", 1, 5000)
            total_delay += delay
            events.append(Event("wait", (), delay))
            continue
        action = step.get("action")
        if not isinstance(action, str):
            raise ProtocolError("step.action 缺失")
        events.extend(expand_action("/" + action.replace(".", "/"),
                                    {key: value for key, value in step.items() if key != "action"}))
    if total_delay > MAX_TOTAL_DELAY_MS:
        raise ProtocolError("宏总等待时间不能超过 10000 ms")
    return events


class ReportLimiter:
    """用单调时钟保证连续 HID 报文至少间隔 15 ms。"""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.next_at = 0.0

    def wait_seconds(self, event):
        now = self.clock()
        wait = max(0.0, self.next_at - now)
        self.next_at = max(now, self.next_at) + event.delay_ms / 1000
        return wait
