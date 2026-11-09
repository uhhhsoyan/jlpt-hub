#!/usr/bin/env bash
# Schedule the Hindsight mirror with launchd (macOS, per-user LaunchAgent).
#
#   bash scripts/hindsight-launchd.sh install     # write the plist and load it (idempotent)
#   bash scripts/hindsight-launchd.sh uninstall   # unload and remove it
#   bash scripts/hindsight-launchd.sh status      # loaded? last exit code? recent log lines
#   bash scripts/hindsight-launchd.sh run         # trigger a run now through launchd
#
# Runs scripts/hindsight-mirror-job.sh four times a day (02:15, 08:15, 14:15, 20:15 local).
# A run with nothing new only queries Postgres (no LLM cost). launchd output goes to
# .hindsight/launchd.log; the job's own summary lines go to .hindsight/mirror.log.
set -euo pipefail

LABEL="com.jlpt-hub.hindsight-mirror"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

install() {
  mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.hindsight"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/hindsight-mirror-job.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>15</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$REPO/.hindsight/launchd.log</string>
  <key>StandardErrorPath</key><string>$REPO/.hindsight/launchd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "installed $LABEL (02:15 / 08:15 / 14:15 / 20:15 daily) → $PLIST"
  status
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "removed $LABEL"
}

status() {
  if launchctl print "$DOMAIN/$LABEL" >/tmp/.hs-launchd.$$ 2>/dev/null; then
    local state exit
    state=$(grep -E '^\s*state = ' /tmp/.hs-launchd.$$ | head -1 | sed 's/^[[:space:]]*//')
    exit=$(grep -E 'last exit code' /tmp/.hs-launchd.$$ | head -1 | sed 's/^[[:space:]]*//')
    echo "agent:   loaded (${state:-state unknown}; ${exit:-no run yet})"
  else
    echo "agent:   not loaded"
  fi
  rm -f /tmp/.hs-launchd.$$
  echo "plist:   $PLIST $([ -f "$PLIST" ] && echo present || echo missing)"
  echo "log:     $REPO/.hindsight/mirror.log"
  if [ -f "$REPO/.hindsight/mirror.log" ]; then
    tail -n 3 "$REPO/.hindsight/mirror.log" | sed 's/^/         /'
  fi
}

run() {
  launchctl kickstart "$DOMAIN/$LABEL"
  echo "kicked $LABEL; watch: tail -f $REPO/.hindsight/mirror.log"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  run) run ;;
  *) echo "usage: bash scripts/hindsight-launchd.sh install|uninstall|status|run"; exit 2 ;;
esac
