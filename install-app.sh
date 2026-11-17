#!/bin/bash
# Builds the Safari app, installs it to /Applications, and unregisters the
# build-folder copy (otherwise Safari lists the extension twice).
set -euo pipefail
cd "$(dirname "$0")"
R="safari/YT Offline/YT Offline Extension/Resources"
cp extension/manifest.json extension/background.js extension/content.js extension/popup.html extension/popup.js extension/icon-*.png "$R/"
xcodebuild -project "safari/YT Offline/YT Offline.xcodeproj" -scheme "YT Offline" -configuration Release \
  -derivedDataPath safari/build -allowProvisioningUpdates build | grep -E "error:|BUILD"
B="safari/build/Build/Products/Release/YT Offline.app"
osascript -e 'quit app "YT Offline"' 2>/dev/null || true
rm -rf "/Applications/YT Offline.app"
cp -R "$B" /Applications/
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
pluginkit -r "$PWD/$B/Contents/PlugIns/YT Offline Extension.appex" 2>/dev/null || true
"$LSR" -u "$PWD/$B" 2>/dev/null || true
rm -rf "$B"
"$LSR" -f "/Applications/YT Offline.app"
open "/Applications/YT Offline.app"
echo "Installed $(grep -o '"version": "[0-9.]*"' extension/manifest.json)"
