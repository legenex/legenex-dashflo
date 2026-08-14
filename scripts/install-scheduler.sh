#!/bin/bash
# Install (or reinstall) the DashOS launchd agents:
#   1. com.legenex.dashos.server  — keeps the API server running (auto-restart)
#   2. com.legenex.dashos.sync    — pulls the repo hourly and replicates changes
#   3. com.legenex.dashos.updater — daily code sync + full data refresh + import
#
# Safe to re-run; it re-bootstraps both agents.
# Note: no `-e` — launchctl bootout/bootstrap can return transient non-zero
# during agent reloads; we handle those explicitly rather than aborting.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UID_NUM="$(id -u)"
HOME_DIR="$HOME"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$UID_NUM"

# Pick a Node that behaves under launchd. Avoid a version-manager shim (e.g. the
# Claude Code bundled runtime under ~/.hermes), which fails EX_CONFIG for short
# scripts spawned by launchd. Prefer a standard Homebrew/system node.
pick_node() {
  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do
    if [ -x "$cand" ]; then
      case "$(readlink "$cand" 2>/dev/null || echo "$cand")" in
        *".hermes"*|*"/.local/"*) continue ;;  # skip shims that break under launchd
      esac
      echo "$cand"; return
    fi
  done
  command -v node
}
NODE_BIN="$(pick_node)"
echo "==> Using node: $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null))"
mkdir -p "$LA" "$ROOT/sync/state"

SERVER_LABEL="com.legenex.dashos.server"
SYNC_LABEL="com.legenex.dashos.sync"
UPDATER_LABEL="com.legenex.dashos.updater"
SERVER_PLIST="$LA/$SERVER_LABEL.plist"
SYNC_PLIST="$LA/$SYNC_LABEL.plist"
UPDATER_PLIST="$LA/$UPDATER_LABEL.plist"

# Common PATH for the agents (git, gh, npm, node, claude, postgres client).
AGENT_PATH="/opt/homebrew/bin:$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
# The updater shells out to the `claude` CLI, which lives in ~/.local/bin.
UPDATER_PATH="$HOME_DIR/.local/bin:$AGENT_PATH"
# Hour of day (local time) for the daily data refresh.
UPDATER_HOUR="${DASHOS_UPDATER_HOUR:-3}"
UPDATER_MINUTE="${DASHOS_UPDATER_MINUTE:-30}"

# NOTE: launchd runs `node` directly on absolute paths (no bash wrapper, no
# WorkingDirectory). The server/config resolve all paths absolutely, so cwd is
# irrelevant — and this avoids launchd permission quirks reading a wrapper script.
echo "==> Writing $SERVER_PLIST"
cat > "$SERVER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <!-- Run node directly (no bash -l login-shell wrapper, which is fragile under
       launchd), and keep the agent's stdout on its own file — pointing launchd
       at a path the process also opens fails the job with EX_CONFIG (78). -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$ROOT/sync/state/server-run.log</string>
  <key>StandardErrorPath</key><string>$ROOT/sync/state/server-run.log</string>
</dict>
</plist>
PLIST

echo "==> Writing $SYNC_PLIST"
cat > "$SYNC_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SYNC_LABEL</string>
  <!-- Run node directly (no bash -l wrapper). -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/sync/sync.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>CLAUDE_NOTIFIER_DISABLE</key><string>1</string>
  </dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><false/>
  <!-- No StandardOut/ErrorPath on purpose: launchd failing to (re)open a fixed
       log file was the recurring EX_CONFIG(78) cause that silently killed this
       agent. sync.mjs writes its own log to sync/state/sync.log, so nothing is
       lost. Do NOT add StandardOutPath back here. -->
</dict>
</plist>
PLIST

echo "==> Writing $UPDATER_PLIST"
cat > "$UPDATER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$UPDATER_LABEL</string>
  <!-- Run node directly (no bash -l wrapper). PATH includes ~/.local/bin so the
       data-refresh step can shell out to the \`claude\` CLI. -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/sync/daily-update.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$UPDATER_PATH</string>
    <key>HOME</key><string>$HOME_DIR</string>
    <key>CLAUDE_NOTIFIER_DISABLE</key><string>1</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$UPDATER_HOUR</integer>
    <key>Minute</key><integer>$UPDATER_MINUTE</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <!-- No StandardOut/ErrorPath on purpose — same EX_CONFIG(78) reason as the
       sync agent. daily-update.mjs writes sync/state/daily-update.log itself. -->
</dict>
</plist>
PLIST

reload() {
  local label="$1" plist="$2"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "$DOMAIN" "$plist" || { sleep 2; launchctl bootstrap "$DOMAIN" "$plist" || true; }
  launchctl enable "$DOMAIN/$label" 2>/dev/null || true
}

echo "==> Initializing sync baseline (records current commit, no transform)"
"$NODE_BIN" "$ROOT/sync/sync.mjs" --init || true

echo "==> Stopping any manually-started server"
pkill -f "node src/index.js" 2>/dev/null || true
sleep 1

echo "==> Bootstrapping launchd agents"
reload "$SERVER_LABEL" "$SERVER_PLIST"
reload "$SYNC_LABEL" "$SYNC_PLIST"
reload "$UPDATER_LABEL" "$UPDATER_PLIST"

echo "==> Kickstarting server"
launchctl kickstart -k "$DOMAIN/$SERVER_LABEL" 2>/dev/null || true

echo ""
echo "Installed:"
echo "  • $SERVER_LABEL  (API server, auto-restart)  -> http://localhost:4000"
echo "  • $SYNC_LABEL    (hourly repo sync)"
echo "  • $UPDATER_LABEL (daily code+data refresh at ${UPDATER_HOUR}:$(printf '%02d' "$UPDATER_MINUTE"))"
echo ""
echo "Logs:    $ROOT/sync/state/sync.log, server.log, daily-update.log"
echo "Status:  launchctl list | grep legenex"
echo "Run sync now:     node sync/sync.mjs --force"
echo "Run updater now:  node sync/daily-update.mjs"
echo "Uninstall:        bash scripts/uninstall-scheduler.sh"
