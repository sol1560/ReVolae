#!/usr/bin/env python3
"""将真实连接配置放进 build-for-testing 的 xctestrun；不改变 App 或跳过验证。

python3 apps/ios/scripts/configure-ui-test.py build.xctestrun private-config.json
配置字段为 E2E_HUB_URL、E2E_TOKEN、E2E_PAIR_CODE、E2E_READ_PATH、
E2E_READ_EXPECTED、E2E_APPROVE_PATH、E2E_DENY_PATH、E2E_WRITE_CONTENT。
生成的 xctestrun 含短时账号凭据，不得上传为公开产物。
"""
import json
import os
import plistlib
import sys
from pathlib import Path

path, configuration = sys.argv[1:3]
device_pages = "--device-pages" in sys.argv[3:]
network_test = "--network-test" in sys.argv[3:]
cancel_test = "--cancel-test" in sys.argv[3:]
if cancel_test and network_test:
    raise SystemExit("取消专项与重连专项不能混用")
if Path(path).is_dir():
    candidates = list(Path(path).glob("*.xctestrun"))
    if len(candidates) != 1:
        raise SystemExit("构建目录必须包含唯一的 xctestrun")
    path = str(candidates[0])
with open(configuration, encoding="utf-8") as source:
    values = json.load(source)
keys = ("E2E_HUB_URL", "E2E_TOKEN", "E2E_READ_PATH",
        "E2E_READ_EXPECTED", "E2E_APPROVE_PATH", "E2E_DENY_PATH", "E2E_WRITE_CONTENT")
mode = values.get("E2E_CONNECTION_MODE", "new-pairing")
if mode not in ("new-pairing", "existing-pairing"):
    raise SystemExit("未知真实连接模式")
extra = ("E2E_DEVICE_ID", "E2E_PHONE_ID", "E2E_HISTORY_BASELINE")
if network_test:
    keys = ("E2E_RECONNECT_URL", "E2E_RECONNECT_TOKEN", "E2E_RECONNECT_CONTROL")
elif cancel_test:
    if mode != "existing-pairing":
        raise SystemExit("取消专项必须使用既有配对")
    keys = ("E2E_HUB_URL", "E2E_TOKEN", *extra, "E2E_DEVICE_KEM", "E2E_DEVICE_SIG",
            "E2E_CANCEL_ID", "E2E_CANCEL_TARGET", "E2E_CANCEL_INTENT", "E2E_CANCEL_CONTROL_URL", "E2E_CANCEL_CONTROL")
else:
    keys += extra if mode == "existing-pairing" else ("E2E_PAIR_CODE",)
if any(not isinstance(values.get(key), str) or not values[key] for key in keys):
    raise SystemExit("真实测试配置缺少必填字段")
if mode == "existing-pairing" and not values["E2E_HISTORY_BASELINE"].isdigit():
    raise SystemExit("历史基数必须是非负整数")
with open(path, "rb") as source:
    run = plistlib.load(source)
targets = [target for config in run.get("TestConfigurations", []) for target in config.get("TestTargets", [])]
if not targets:
    targets = [value for value in run.values() if isinstance(value, dict) and "TestBundlePath" in value]
matched = 0
target_names = ["CuaRemoteTests", "CuaRemoteUITests"] if cancel_test else ["CuaRemoteTests" if network_test else "CuaRemoteUITests"]
for target in targets:
    if any(name in target.get("BlueprintName", "") or name in target.get("TestBundlePath", "") for name in target_names):
        environment = target.setdefault("EnvironmentVariables", {})
        for key in list(environment):
            if key.startswith("E2E_") or key.startswith("CUA_CANCEL_FIXTURE") or key.startswith("CUA_HISTORY_FIXTURE"):
                environment.pop(key, None)
        environment.update({key: values[key] for key in keys})
        environment["E2E_CONNECTION_MODE"] = mode
        if cancel_test:
            environment["E2E_CANCEL_PHASE"] = "cleanup" if "--cancel-cleanup" in sys.argv[3:] else "before"
        target["EnvironmentVariables"]["E2E_DEVICE_PAGES"] = "1" if device_pages else "0"
        environment["E2E_PRESERVE_PAIRING"] = "1" if "--preserve-pairing" in sys.argv[3:] else "0"
        matched += 1
if matched != len(target_names):
    raise SystemExit("没有找到所需的唯一测试target")
os.chmod(path, 0o600)
with open(path, "wb") as destination:
    plistlib.dump(run, destination)
print("真实连接配置已写入私有 xctestrun；未输出凭据。")
