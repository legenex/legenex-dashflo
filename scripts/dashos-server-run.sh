#!/bin/bash
# Launch the DashOS API server. Used by the launchd server agent (KeepAlive).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/Users/$(whoami)/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
cd "$DIR/server"
exec node src/index.js
