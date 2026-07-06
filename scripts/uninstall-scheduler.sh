#!/bin/bash
# Remove the DashOS launchd agents (server + hourly sync).
set -uo pipefail
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
LA="$HOME/Library/LaunchAgents"
for label in com.legenex.dashos.server com.legenex.dashos.sync; do
  echo "==> Removing $label"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  rm -f "$LA/$label.plist"
done
echo "Done. (The API server has been stopped. Start it manually with: npm start)"
