#!/usr/bin/env python3
"""配对后开始录屏。停止方式：创建指定 stop 文件；只对本脚本的子进程发 SIGINT。

record-simulator.py <simulator UUID> <xcodebuild log> <video.mp4> <stop file>
"""
from pathlib import Path
import signal
import subprocess
import sys
import time

device, log_path, output, stop_path = sys.argv[1:]
log = Path(log_path)
stop = Path(stop_path)
deadline = time.monotonic() + 300
while not stop.exists():
    if log.exists() and "E2E_PAIRED" in log.read_text(errors="replace"):
        break
    if time.monotonic() > deadline:
        raise SystemExit("配对未完成，没有开始录屏")
    time.sleep(0.25)
else:
    raise SystemExit("测试已停止，没有开始录屏")

process = subprocess.Popen(["xcrun", "simctl", "io", device, "recordVideo", "--codec=h264", output],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
print("正在录制本任务模拟器，未录制凭据输入。", flush=True)
try:
    while process.poll() is None and not stop.exists():
        if log.exists() and "E2E_COMPLETE" in log.read_text(errors="replace"):
            time.sleep(2)
            break
        time.sleep(0.25)
finally:
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
    _, error = process.communicate(timeout=30)
    if process.returncode not in (0, 130, -signal.SIGINT):
        raise SystemExit(error.decode(errors="replace"))
print("模拟器录像已结束并封装完成。")
