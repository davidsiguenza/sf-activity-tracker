#!/usr/bin/env bash
# Double-click to restart the SF Activity Tracker server (launchd-managed).
# Useful after changing backend code or if the server is stuck.

set -e

# Resolve real path even if invoked through a symlink
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PROJECT_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

URL="http://127.0.0.1:7825"
PORT=7825
LABEL="com.dsp.sf-activity-tracker"

cd "$PROJECT_ROOT"

is_up() {
  nc -z -G 1 127.0.0.1 "$PORT" > /dev/null 2>&1 && return 0
  curl -fs -m 2 --noproxy '*' "$URL/api/health" > /dev/null 2>&1
}

echo "🔄 Restarting SF Activity Tracker"
echo

# If LaunchAgent isn't loaded yet, install it first (covers the edge case where
# the user ran this before launchd-install.sh).
if ! launchctl list 2>/dev/null | grep -q "$LABEL"; then
  echo "→ LaunchAgent not loaded — installing first…"
  "$PROJECT_ROOT/bin/launchd-install.sh" install
else
  echo "→ Bouncing the agent"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi

# Wait up to 10s for the server to come back
echo -n "→ Waiting for server"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if is_up; then echo " ✓"; break; fi
  echo -n "."
  sleep 1
done

if is_up; then
  echo "→ Server is up at $URL"
  echo "→ Opening browser"
  open "$URL"
else
  echo
  echo "✗ Server didn't come up within 10s. Diagnostics:"
  echo
  echo "── launchctl state ──"
  launchctl print "gui/$(id -u)/$LABEL" 2>&1 | grep -iE "state|pid|last exit|program =" | head -10
  echo
  echo "── port $PORT listeners ──"
  lsof -nP -iTCP:$PORT 2>/dev/null | head -5 || echo "(nothing listening)"
  echo
  echo "── last 15 log lines ──"
  tail -15 ~/Library/Logs/sf-activity-tracker.log 2>/dev/null || echo "(no log file)"
  echo
  echo "Press any key to close…"
  read -n 1 -s
  exit 1
fi

# Auto-close the Terminal window
osascript -e 'tell application "Terminal" to close (every window whose name contains "Restart SF Activity Tracker")' 2>/dev/null &
sleep 1
exit 0
