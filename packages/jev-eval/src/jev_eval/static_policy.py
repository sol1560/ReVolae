from __future__ import annotations

import json
import re

from .models import ConcreteAction, Tool

# 与 cuaremote-kit/policy.ts 的 L2_PATTERNS 顺序逐条一致。
L2_PATTERNS = [
    re.compile(r"\bsudo\b"),
    re.compile(r"\brm\s+-rf?\b"),
    re.compile(r"\bdiskutil\b"),
    re.compile(r"\bcsrutil\b"),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s+if="),
    re.compile(r"\blaunchctl\b"),
    re.compile(r"\bdefaults\s+write\b"),
    re.compile(r"\bbrew\s+(install|uninstall|remove)\b"),
    re.compile(r"\bnpm\s+i(nstall)?\s+-g\b"),
    re.compile(r"\bpip3?\s+install\b"),
    re.compile(r"\bsecurity\s+(find|add|delete)-"),
    re.compile(r"\bkillall\b"),
    re.compile(r"\bshutdown\b"),
    re.compile(r"\breboot\b"),
    re.compile(r"\bgit\s+push\s+.*--force\b"),
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    re.compile(r"\bchmod\s+777\b"),
    re.compile(r"\bcurl\b.*\|\s*(ba|z)?sh\b"),
    re.compile(r"\bosascript\b.*\bdo shell script\b.*administrator"),
]
FINANCE_HINTS = [
    "alipay", "支付宝", "wechat pay", "微信支付", "银行", "bank", "paypal",
    "stripe", "钱包", "wallet", "keychain", "钥匙串", "1password",
]
GUI_WRITE_PATTERN = re.compile(r"type_text|set_value|press_key|hotkey|click|drag|scroll")


def static_level(tool: Tool, args: dict, action: ConcreteAction) -> int:
    level = tool.static_level
    # TypeScript 的 JSON.stringify 紧凑输出；lowerCase 对本数据涉及字符与 casefold 等价。
    packed = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
    text = f"{action.detail} {action.summary} {action.targetApp or ''} {action.targetPath or ''} {packed}".lower()
    if any(pattern.search(text) for pattern in L2_PATTERNS):
        level = 2
    if any(hint in text for hint in FINANCE_HINTS):
        level = 2
    if tool.channel == "gui" and GUI_WRITE_PATTERN.search(text) and level < 1:
        level = 1
    return level
