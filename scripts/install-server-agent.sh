#!/bin/bash
# Install or repoint ONLY the DashFlo API server launchd agent.
#
# This exists because scripts/install-scheduler.sh installs three agents: the
# server, the hourly upstream sync, and the daily updater. The sync and updater
# are mutating writers on this checkout, they are deliberately unloaded during
# the cutover, and reviving them would overwrite work. This script never touches
# them. scripts/uninstall-scheduler.sh is equally unusable here, because it
# stops the API server along with the writers.
#
# Safe to re-run. Idempotent. Verifies before it retires anything.
#
#   bash scripts/install-server-agent.sh              build, install, verify
#   bash scripts/install-server-agent.sh --no-build   skip the client build
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
LA="$HOME/Library/LaunchAgents"

NEW_LABEL="com.legenex.dashflo.server"
OLD_LABEL="com.legenex.dashos.server"
SYNC_LABEL="com.legenex.dashos.sync"
UPDATER_LABEL="com.legenex.dashos.updater"
NEW_PLIST="$LA/$NEW_LABEL.plist"
OLD_PLIST="$LA/$OLD_LABEL.plist"

DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

fail() { echo "ERROR: $*" >&2; exit 1; }

echo "==> Repository root: $ROOT"
[ -f "$ROOT/server/src/index.js" ] || fail "server/src/index.js not found under $ROOT"

# Refuse to run from the deleted pre-rename path, which is the exact fault this
# script repairs.
case "$ROOT" in
  *"Legenex DashOS"*) fail "Running from the old DashOS path. Run this from the renamed folder." ;;
esac

# launchd fails EX_CONFIG(78) on version-manager shims, so prefer a real node.
pick_node() {
  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
    if [ -x "$cand" ]; then
      case "$(readlink "$cand" 2>/dev/null || echo "$cand")" in
        *".hermes"*|*"/.local/"*) continue ;;
      esac
      echo "$cand"; return
    fi
  done
  command -v node
}
NODE_BIN="$(pick_node)"
[ -x "$NODE_BIN" ] || fail "no usable node binary found"
echo "==> Using node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"

if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> Building client"
  npm --prefix "$ROOT/client" run build >/dev/null 2>&1 || fail "client build failed"
fi
[ -f "$ROOT/client/dist/index.html" ] || fail "client/dist/index.html missing. Build the client first."
echo "==> Verified $ROOT/client/dist/index.html"

mkdir -p "$LA" "$ROOT/sync/state"

echo "==> Writing $NEW_PLIST"
cat > "$NEW_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$NEW_LABEL</string>
  <!-- Run node directly on an absolute path. No bash -l wrapper, and keep the
       log on its own file: pointing launchd at a path the process also opens
       fails the job with EX_CONFIG(78). -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/sync/state/server-run.log</string>
  <key>StandardErrorPath</key><string>$ROOT/sync/state/server-run.log</string>
</dict>
</plist>
PLIST

# Free the port: the stale agent and any hand-started server both hold 4000.
echo "==> Stopping the stale server agent (server only)"
launchctl bootout "$DOMAIN/$OLD_LABEL" 2>/dev/null || true
launchctl bootout "$DOMAIN/$NEW_LABEL" 2>/dev/null || true
sleep 1
pkill -f "Legenex DashOS/server/src/index.js" 2>/dev/null || true
sleep 1

echo "==> Bootstrapping $NEW_LABEL"
launchctl bootstrap "$DOMAIN" "$NEW_PLIST" || { sleep 2; launchctl bootstrap "$DOMAIN" "$NEW_PLIST" || true; }
launchctl enable "$DOMAIN/$NEW_LABEL" 2>/dev/null || true
launchctl kickstart -k "$DOMAIN/$NEW_LABEL" 2>/dev/null || true

echo "==> Waiting for health"
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/api/health 2>/dev/null)"
  [ "$HEALTH" = "200" ] && break
  sleep 1
done
ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/ 2>/dev/null)"

echo ""
echo "  /api/health : $HEALTH"
echo "  /           : $ROOT_CODE"

if [ "$HEALTH" != "200" ] || [ "$ROOT_CODE" != "200" ]; then
  echo ""
  echo "Verification FAILED. The old agent has been left in place so it can be"
  echo "restored. Recent log lines:"
  tail -20 "$ROOT/sync/state/server-run.log" 2>/dev/null
  exit 1
fi

# Only now that the replacement is proven serving, retire the old definition.
# Renamed rather than deleted, so it is reversible.
if [ -f "$OLD_PLIST" ]; then
  echo "==> Retiring $OLD_LABEL (renamed to .disabled, reversible)"
  mv "$OLD_PLIST" "$OLD_PLIST.disabled"
fi

# The writers must still be absent. Report, never revive.
echo ""
echo "==> Writer agents (must remain unloaded)"
for l in "$SYNC_LABEL" "$UPDATER_LABEL"; do
  if launchctl print "$DOMAIN/$l" >/dev/null 2>&1; then
    echo "  WARNING: $l is LOADED. It writes to this checkout. Bru must review."
  else
    echo "  ok: $l not loaded"
  fi
done

echo ""
echo "DashFlo server is running from: $ROOT"
echo "  http://localhost:4000        (application)"
echo "  http://localhost:4000/api/health"
echo "Log:   $ROOT/sync/state/server-run.log"
echo "Status: launchctl list | grep legenex"
