#!/usr/bin/env bash
# Install / reinstall the launchd agent that keeps sf-activity-tracker running.
#
# Usage:
#   ./bin/launchd-install.sh          # install + load
#   ./bin/launchd-install.sh restart  # bounce after a code change
#   ./bin/launchd-install.sh uninstall # remove

set -e

LABEL="com.dsp.sf-activity-tracker"
SOURCE_PLIST="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/sf-activity-tracker.log"

cmd="${1:-install}"

case "$cmd" in
  install)
    echo "→ Copying $SOURCE_PLIST → $TARGET_PLIST"
    mkdir -p "$HOME/Library/LaunchAgents"
    mkdir -p "$LOG_DIR"
    cp "$SOURCE_PLIST" "$TARGET_PLIST"

    # Bootout if it's already loaded (idempotent)
    if launchctl list | grep -q "$LABEL"; then
      echo "→ Existing agent found, bootstrapping out first…"
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$TARGET_PLIST" 2>/dev/null || true
    fi

    echo "→ Loading agent"
    launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"

    # Some macOS versions don't reliably honor RunAtLoad on a freshly-bootstrapped
    # agent — force-start with kickstart so the server is definitely up after install.
    echo "→ Kickstarting"
    launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true

    sleep 1
    if launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running"; then
      echo "→ Done. Server is running at http://127.0.0.1:7825"
    else
      echo "→ Agent loaded but not running yet. Check: tail -f $LOG_FILE"
    fi
    echo "   Logs: tail -f $LOG_FILE"
    ;;

  restart)
    echo "→ Bouncing $LABEL"
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "→ Done. tail -f $LOG_FILE"
    ;;

  uninstall)
    echo "→ Stopping $LABEL"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$TARGET_PLIST" 2>/dev/null || true
    if [ -f "$TARGET_PLIST" ]; then
      rm "$TARGET_PLIST"
      echo "→ Removed $TARGET_PLIST"
    fi
    echo "→ Done."
    ;;

  status)
    if launchctl list | grep -q "$LABEL"; then
      launchctl list "$LABEL"
      echo "→ Tail logs: tail -f $LOG_FILE"
    else
      echo "Not running. Run: $0 install"
    fi
    ;;

  *)
    echo "Usage: $0 {install|restart|uninstall|status}"
    exit 1
    ;;
esac
