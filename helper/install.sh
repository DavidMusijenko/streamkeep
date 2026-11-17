#!/bin/bash
# Installs the YT Offline helper as a LaunchAgent (starts at login, restarts if it dies).
# Uninstall: ./install.sh --uninstall
set -euo pipefail
LABEL="com.ytoffline.helper"
DEST="$HOME/Library/Application Support/YT Offline"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"; rm -rf "$DEST"
  echo "Uninstalled (cache in ~/Movies/YT Offline Cache left in place)."; exit 0
fi

command -v yt-dlp >/dev/null || { echo "yt-dlp missing: brew install yt-dlp"; exit 1; }
PY="$(command -v /opt/homebrew/bin/python3 || command -v python3)"
mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/yto_helper.py" "$DEST/yto_helper.py"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DEST/yto_helper.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/helper.log</string>
  <key>StandardErrorPath</key><string>$DEST/helper.log</string>
</dict></plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
sleep 1
curl -fsS http://127.0.0.1:8765/ping >/dev/null && echo "Helper running on http://127.0.0.1:8765" || echo "Helper failed, see $DEST/helper.log"
