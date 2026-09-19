"""RP2040 CircuitPython HID + 行分隔 JSON 备用固件。"""

import json
import time
import usb_cdc
import usb_hid
from adafruit_hid.keyboard import Keyboard
from adafruit_hid.keyboard_layout_us import KeyboardLayoutUS
from adafruit_hid.keycode import Keycode
from adafruit_hid.mouse import Mouse

REPORT_DELAY = 0.015
keyboard = Keyboard(usb_hid.devices)
layout = KeyboardLayoutUS(keyboard)
mouse = Mouse(usb_hid.devices)
serial = usb_cdc.data

KEYS = {
    "enter": Keycode.ENTER, "escape": Keycode.ESCAPE, "backspace": Keycode.BACKSPACE,
    "tab": Keycode.TAB, "space": Keycode.SPACE, "delete": Keycode.DELETE,
    "left": Keycode.LEFT_ARROW, "right": Keycode.RIGHT_ARROW,
    "up": Keycode.UP_ARROW, "down": Keycode.DOWN_ARROW,
}
MODIFIERS = {"ctrl": Keycode.CONTROL, "shift": Keycode.SHIFT,
             "alt": Keycode.ALT, "option": Keycode.ALT,
             "cmd": Keycode.GUI, "command": Keycode.GUI, "meta": Keycode.GUI}
BUTTONS = {"left": Mouse.LEFT_BUTTON, "right": Mouse.RIGHT_BUTTON,
           "middle": Mouse.MIDDLE_BUTTON}


def pause():
    time.sleep(REPORT_DELAY)


def integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise ValueError("%s out of range" % name)
    return value


def execute(path, body):
    if path == "/mouse/move":
        dx = integer(body.get("dx"), "dx", -32767, 32767)
        dy = integer(body.get("dy"), "dy", -32767, 32767)
        while dx or dy:
            sx = max(-127, min(127, dx)); sy = max(-127, min(127, dy))
            mouse.move(x=sx, y=sy); pause(); dx -= sx; dy -= sy
    elif path == "/mouse/click":
        button = BUTTONS.get(body.get("button", "left"))
        count = integer(body.get("count", 1), "count", 1, 3)
        if button is None: raise ValueError("unknown button")
        for _ in range(count):
            mouse.press(button); pause(); mouse.release(button); pause()
    elif path == "/mouse/scroll":
        if body.get("dx", 0): raise ValueError("CircuitPython Mouse has no horizontal pan")
        mouse.move(wheel=integer(body.get("dy", 0), "dy", -127, 127)); pause()
    elif path == "/key/press":
        name = body.get("key", "").lower()
        key = KEYS.get(name)
        if key is None and len(name) == 1 and "a" <= name <= "z": key = getattr(Keycode, name.upper())
        if key is None: raise ValueError("unknown key")
        modifiers = [MODIFIERS[item] for item in body.get("modifiers", [])]
        keyboard.press(*(modifiers + [key])); pause(); keyboard.release_all(); pause()
    elif path == "/key/type":
        text = body.get("text")
        if not isinstance(text, str) or len(text) > 1024: raise ValueError("invalid text")
        if any(ord(character) > 127 for character in text): raise ValueError("Unicode requires clipboard + Cmd+V")
        for character in text:
            layout.write(character); pause()
    else:
        raise ValueError("unknown path")


def dispatch(message):
    path = message.get("path")
    if path != "/macro":
        execute(path, message)
        return
    steps = message.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 128: raise ValueError("invalid steps")
    total_wait = 0
    for step in steps:
        if "delayMs" in step:
            delay = integer(step["delayMs"], "delayMs", 1, 5000)
            total_wait += delay
            if total_wait > 10000: raise ValueError("macro waits too long")
            time.sleep(delay / 1000)
        else:
            execute("/" + step["action"].replace(".", "/"), step)


buffer = bytearray()
while True:
    if not serial or not serial.connected:
        time.sleep(0.05)
        continue
    incoming = serial.read(serial.in_waiting or 1)
    if not incoming:
        continue
    for byte in incoming:
        if byte == 10:
            try:
                dispatch(json.loads(buffer.decode("utf-8")))
                reply = {"ok": True}
            except Exception as error:  # 串口协议边界：把错误回给调用方，继续服务。
                keyboard.release_all(); mouse.release_all()
                reply = {"ok": False, "error": str(error)}
            serial.write((json.dumps(reply) + "\n").encode("utf-8"))
            buffer = bytearray()
        elif byte != 13 and len(buffer) < 16384:
            buffer.append(byte)
