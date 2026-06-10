#!/usr/bin/env bash
# Copy the .command launchers to your Desktop so you can double-click them
# like any other launcher.
#
# Defaults to a hard copy (so it survives moving the project folder) but
# pass --symlink if you'd rather have it follow updates from the project.

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

LAUNCHERS=(
  "SF Activity Tracker.command"
  "Restart SF Activity Tracker.command"
)

USE_SYMLINK=0
if [ "$1" = "--symlink" ]; then USE_SYMLINK=1; fi

for name in "${LAUNCHERS[@]}"; do
  source="$PROJECT_ROOT/bin/$name"
  dest="$HOME/Desktop/$name"

  if [ ! -f "$source" ]; then
    echo "✗ $source not found, skipping"
    continue
  fi

  chmod +x "$source"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm "$dest"
  fi

  if [ "$USE_SYMLINK" = "1" ]; then
    ln -s "$source" "$dest"
    echo "✓ Symlinked $name → $source"
  else
    cp "$source" "$dest"
    chmod +x "$dest"
    echo "✓ Copied $name to Desktop"
  fi
done

echo
echo "On your Desktop:"
echo "  • SF Activity Tracker         → starts (if needed) + opens the app"
echo "  • Restart SF Activity Tracker → bounces the server (after backend changes)"
if [ "$USE_SYMLINK" = "0" ]; then
  echo
  echo "Re-run this script after a git pull to refresh the desktop copies."
fi
