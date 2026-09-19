#!/usr/bin/env bash
# 不用 fastlane 时的手动截图：起模拟器 → 装 app → 用 launch argument 进演示模式 → 按页面深链截图。
# 用法：apps/ios/AppStore/scripts/screenshots.sh <path/to/CuaRemote.app> [输出目录]
# 页面深链由 app 的 -CUAREMOTE_SCREEN 参数决定：devices / run / approval / terminal / settings（runner B 实现时保持这几个名字）。
set -euo pipefail
APP=${1:?CuaRemote.app 路径}
OUT=${2:-"$(dirname "$0")/../screenshots/manual"}
BUNDLE=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist")
DEVICES=("iPhone 17 Pro Max" "iPad Pro 13-inch (M5)")
SCREENS=(devices run approval terminal settings)
LANGS=(zh-Hans en-US)
mkdir -p "$OUT"
for dev in "${DEVICES[@]}"; do
  udid=$(xcrun simctl list devices available -j | python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print(next(x['udid'] for v in d.values() for x in v if x['name']=='$dev'))")
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
  xcrun simctl install "$udid" "$APP"
  for lang in "${LANGS[@]}"; do
    for screen in "${SCREENS[@]}"; do
      xcrun simctl terminate "$udid" "$BUNDLE" 2>/dev/null || true
      xcrun simctl launch "$udid" "$BUNDLE" -AppleLanguages "($lang)" -CUAREMOTE_DEMO 1 -CUAREMOTE_SCREEN "$screen" >/dev/null
      sleep 2
      xcrun simctl io "$udid" screenshot "$OUT/${dev// /_}-$lang-$screen.png"
    done
  done
  xcrun simctl status_bar "$udid" clear
done
echo "截图在 $OUT"
