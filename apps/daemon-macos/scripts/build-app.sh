#!/bin/bash
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
PACKAGE="$ROOT/apps/daemon-macos"
swift build --package-path "$PACKAGE" -j 4
APP="$PACKAGE/.build/CuaRemote.app"
mkdir -p "$APP/Contents/MacOS"
for name in cuaremote-menu cuaremote-macos cuaremote-native-helper; do
  cp "$PACKAGE/.build/debug/$name" "$APP/Contents/MacOS/$name"
done
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.cuaremote.macos</string>
<key>CFBundleName</key><string>CuaRemote</string>
<key>CFBundleExecutable</key><string>cuaremote-menu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP/Contents/MacOS/cuaremote-native-helper"
codesign --force --sign - "$APP/Contents/MacOS/cuaremote-macos"
codesign --force --sign - "$APP"
printf '%s\n' "$APP"
