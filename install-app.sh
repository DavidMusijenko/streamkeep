#!/bin/bash
# Builds the Safari app, installs it to /Applications, and unregisters the
# build-folder copy (otherwise Safari lists the extension twice).
# To sign with your own Apple ID: TEAM=<your team id> ./install-app.sh
set -euo pipefail
cd "$(dirname "$0")"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
python3 build.py safari
R="safari/StreamKeep/StreamKeep Extension/Resources"
rm -rf "$R"; cp -R dist/safari "$R"
xcodebuild -project safari/StreamKeep/StreamKeep.xcodeproj -scheme StreamKeep -configuration Release \
  -derivedDataPath safari/build -allowProvisioningUpdates ${TEAM:+DEVELOPMENT_TEAM=$TEAM} build | grep -E "error:|BUILD"
B="safari/build/Build/Products/Release/StreamKeep.app"
# the old name, if installed
osascript -e 'quit app "YT Offline"' 2>/dev/null || true
if [[ -d "/Applications/YT Offline.app" ]]; then "$LSR" -u "/Applications/YT Offline.app" 2>/dev/null || true; rm -rf "/Applications/YT Offline.app"; fi
osascript -e 'quit app "StreamKeep"' 2>/dev/null || true
rm -rf /Applications/StreamKeep.app
cp -R "$B" /Applications/
pluginkit -r "$PWD/$B/Contents/PlugIns/StreamKeep Extension.appex" 2>/dev/null || true
"$LSR" -u "$PWD/$B" 2>/dev/null || true
rm -rf "$B"
"$LSR" -f /Applications/StreamKeep.app
open /Applications/StreamKeep.app
echo "Installed $(grep -o '"version": "[0-9.]*"' extension/manifest.json)"
