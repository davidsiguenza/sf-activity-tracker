#!/usr/bin/env bash
# Double-click this in Finder (or your Desktop copy) to:
#   1. Make sure the LaunchAgent is loaded and the server is running
#   2. Open the app in your default browser
#
# Symlink-safe: resolves its own path so you can place it anywhere
# (Desktop, Dock, anywhere) and it'll find the project.

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

# Two-step status check: first that something is listening on the port,
# then that it responds to /api/health. Either signal counts as "up".
is_up() {
  # nc -z is a TCP-only probe (no proxy interference, no HTTP overhead)
  nc -z -G 1 127.0.0.1 "$PORT" > /dev/null 2>&1 && return 0
  # Fall back to curl in case nc isn't available for some reason
  curl -fs -m 2 --noproxy '*' "$URL/api/health" > /dev/null 2>&1
}

echo "🗓  SF Activity Tracker"
echo

if is_up; then
  echo "✓ Server already running at $URL"
else
  echo "→ Server not responding yet, kicking it…"
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else
    echo "  (LaunchAgent not installed — installing now)"
    "$PROJECT_ROOT/bin/launchd-install.sh" install
  fi

  # Wait up to 10s for the server to come up
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if is_up; then break; fi
    sleep 1
  done

  if is_up; then
    echo "✓ Server is up"
  else
    echo "✗ Server didn't come up within 10s. Diagnostics:"
    echo
    echo "── launchctl state ──"
    launchctl print "gui/$(id -u)/$LABEL" 2>&1 | grep -iE "state|pid|last exit|program =" | head -10
    echo
    echo "── port 7825 listeners ──"
    lsof -nP -iTCP:$PORT 2>/dev/null | head -5 || echo "(nothing listening)"
    echo
    echo "── last 15 log lines ──"
    tail -15 ~/Library/Logs/sf-activity-tracker.log 2>/dev/null || echo "(no log file)"
    echo
    echo "Press any key to close…"
    read -n 1 -s
    exit 1
  fi
fi

echo "→ Opening $URL"
open "$URL"

# Auto-close the Terminal window after a moment (looks cleaner)
osascript -e 'tell application "Terminal" to close (every window whose name contains "SF Activity Tracker")' 2>/dev/null &
sleep 1
exit 0
