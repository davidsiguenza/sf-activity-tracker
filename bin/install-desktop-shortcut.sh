#!/usr/bin/env bash
# Copy "SF Activity Tracker.command" to your Desktop so you can double-click
# it like any other launcher.
#
# Defaults to a hard copy (so it survives moving the project folder) but
# pass --symlink if you'd rather have it follow updates from the project.

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$PROJECT_ROOT/bin/SF Activity Tracker.command"
DESTINATION="$HOME/Desktop/SF Activity Tracker.command"

if [ ! -f "$SOURCE" ]; then
  echo "✗ $SOURCE not found"
  exit 1
fi

# Make sure source is executable (git might have lost the bit on clone)
chmod +x "$SOURCE"

if [ "$1" = "--symlink" ]; then
  if [ -e "$DESTINATION" ] || [ -L "$DESTINATION" ]; then rm "$DESTINATION"; fi
  ln -s "$SOURCE" "$DESTINATION"
  echo "✓ Symlinked $DESTINATION → $SOURCE"
  echo "  (changes in the project will be picked up automatically)"
else
  cp "$SOURCE" "$DESTINATION"
  chmod +x "$DESTINATION"
  echo "✓ Copied $SOURCE → $DESTINATION"
  echo "  Re-run this script after a git pull to update the desktop copy."
fi

echo
echo "Double-click 'SF Activity Tracker' on your Desktop to launch the app."
echo "It will start the server if needed and open your browser at http://127.0.0.1:7825"
