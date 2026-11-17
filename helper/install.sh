#!/bin/bash
# Installs the StreamKeep helper as a background service that starts at login
# and restarts if it dies: a LaunchAgent on macOS, a systemd user unit on Linux.
# Uninstall: ./install.sh --uninstall
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="streamkeep-helper"

need() { command -v "$1" >/dev/null || { echo "$1 is missing. Install it first (macOS: brew install $2)."; exit 1; }; }

if [[ "$(uname)" == "Darwin" ]]; then
  LABEL="com.streamkeep.helper"
  DEST="$HOME/Library/Application Support/StreamKeep"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  DOMAIN="gui/$(id -u)"
  CACHE="$HOME/Movies/StreamKeep"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # migrate from the old name (YT Offline)
  launchctl bootout "$DOMAIN/com.ytoffline.helper" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.ytoffline.helper.plist"
  rm -rf "$HOME/Library/Application Support/YT Offline"
  if [[ -d "$HOME/Movies/YT Offline Cache" && ! -e "$CACHE" ]]; then
    mv "$HOME/Movies/YT Offline Cache" "$CACHE"
  fi
  if [[ "${1:-}" == "--uninstall" ]]; then
    rm -f "$PLIST"; rm -rf "$DEST"
    echo "Uninstalled (saved videos in $CACHE left in place)."; exit 0
  fi
  need yt-dlp yt-dlp; need ffmpeg ffmpeg
  PY="$(command -v /opt/homebrew/bin/python3 || command -v python3)"
  mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
  cp "$HERE/streamkeep_helper.py" "$DEST/"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DEST/streamkeep_helper.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/helper.log</string>
  <key>StandardErrorPath</key><string>$DEST/helper.log</string>
</dict></plist>
PLIST
  launchctl bootstrap "$DOMAIN" "$PLIST"
  LOG="$DEST/helper.log"
else
  DEST="${XDG_DATA_HOME:-$HOME/.local/share}/streamkeep"
  UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service"
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  if [[ "${1:-}" == "--uninstall" ]]; then
    rm -f "$UNIT"; rm -rf "$DEST"; systemctl --user daemon-reload
    echo "Uninstalled (saved videos left in place)."; exit 0
  fi
  need yt-dlp yt-dlp; need ffmpeg ffmpeg; need python3 python
  mkdir -p "$DEST" "$(dirname "$UNIT")"
  cp "$HERE/streamkeep_helper.py" "$DEST/"
  cat > "$UNIT" <<UNIT
[Unit]
Description=StreamKeep helper (saves YouTube videos for offline playback)

[Service]
ExecStart=$(command -v python3) $DEST/streamkeep_helper.py
Restart=always

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$NAME"
  LOG="journalctl --user -u $NAME"
fi

sleep 1
curl -fsS http://127.0.0.1:8765/ping >/dev/null && echo "Helper running on http://127.0.0.1:8765" || echo "Helper failed, see $LOG"
