#!/usr/bin/env bash
# Pre-flight checks before installing sf-activity-tracker.
#
# Verifies you have all required CLIs at the right versions and that `sf` is
# already authenticated against org62. Prints copy-pasteable fixes for each
# failure. Safe to re-run; doesn't modify anything.
#
# Usage:
#   ./bin/preflight-check.sh

set -u

GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
DIM=$'\e[2m'
RESET=$'\e[0m'

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ${GREEN}✓${RESET} $*"; PASS=$((PASS+1)); }
fail() { echo "  ${RED}✗${RESET} $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ${YELLOW}!${RESET} $*"; WARN=$((WARN+1)); }
hint() { echo "    ${DIM}↳ $*${RESET}"; }

echo
echo "─── sf-activity-tracker · pre-flight check ──────────────────────────"
echo

# ─── Node ────────────────────────────────────────────────────────────────────
echo "Node.js (>= 20)"
if ! command -v node >/dev/null 2>&1; then
  fail "node not found in PATH"
  hint "Install: brew install node    (or: nvm install 20)"
else
  NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
    fail "node $NODE_VERSION found, need >= 20"
    hint "Upgrade: nvm install 20 && nvm use 20"
  else
    ok "node $NODE_VERSION"
  fi
fi
echo

# ─── Salesforce CLI ──────────────────────────────────────────────────────────
echo "Salesforce CLI (sf v2)"
if ! command -v sf >/dev/null 2>&1; then
  fail "sf not found in PATH"
  hint "Install: npm install -g @salesforce/cli"
  hint "  (or: brew install --cask sfdx-cli)"
else
  SF_VERSION="$(sf --version 2>/dev/null | head -1)"
  if echo "$SF_VERSION" | grep -q "@salesforce/cli/2\."; then
    ok "$SF_VERSION"
  else
    warn "sf found but not v2: $SF_VERSION"
    hint "We rely on v2 syntax (\`sf data create record\`). Upgrade with:"
    hint "  npm install -g @salesforce/cli@latest"
  fi
fi
echo

# ─── git ─────────────────────────────────────────────────────────────────────
echo "git"
if ! command -v git >/dev/null 2>&1; then
  fail "git not found"
  hint "Install: brew install git"
else
  ok "$(git --version)"
fi
echo

# ─── Claude Code (optional) ──────────────────────────────────────────────────
echo "Claude Code CLI (optional — only needed for the calendar fallback)"
if command -v claude >/dev/null 2>&1; then
  ok "claude found at $(command -v claude)"
  hint "Used as fallback if Google Calendar API direct is not configured."
else
  warn "claude not found"
  hint "OK if you'll use the Google Calendar API direct path (recommended)."
  hint "Without it, you also lose the slow Claude+MCP fallback."
  hint "Install: see DevBar T&P canvas (Salesforce internal)."
fi
echo

# ─── sf authenticated against org62 ──────────────────────────────────────────
echo "Salesforce auth (sf org login → alias 'org62')"
if ! command -v sf >/dev/null 2>&1; then
  warn "skipped (sf not installed)"
else
  if sf org list --json 2>/dev/null | grep -q '"alias": *"org62"'; then
    if sf org display --target-org org62 --json >/dev/null 2>&1; then
      ORG_USERNAME="$(sf org display --target-org org62 --json 2>/dev/null | grep -o '"username": *"[^"]*"' | head -1 | sed 's/.*"username": *"\([^"]*\)".*/\1/')"
      ok "alias 'org62' authenticated as $ORG_USERNAME"
    else
      fail "alias 'org62' exists but auth is broken (token expired?)"
      hint "Re-authenticate: sf org login web --alias org62"
    fi
  else
    fail "no 'org62' alias configured"
    hint "Authenticate: sf org login web --alias org62"
    hint "  (browser opens, log in with your @salesforce.com account)"
  fi
fi
echo

# ─── Port 7825 free ──────────────────────────────────────────────────────────
echo "Port 7825 (the server's listen port)"
if lsof -nP -iTCP:7825 -sTCP:LISTEN >/dev/null 2>&1; then
  PID="$(lsof -nP -iTCP:7825 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')"
  warn "port 7825 already in use by PID $PID"
  hint "If that's a previous sf-activity-tracker run, that's fine."
  hint "Inspect: lsof -nP -iTCP:7825"
else
  ok "port 7825 is free"
fi
echo

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "─── Summary ─────────────────────────────────────────────────────────"
echo
if [ $FAIL -eq 0 ]; then
  echo "  ${GREEN}${PASS} OK${RESET}, ${WARN} warning(s), 0 errors."
  echo
  echo "  All hard pre-requisites satisfied. Continue with SETUP.md → step 1."
  echo
  exit 0
else
  echo "  ${GREEN}${PASS} OK${RESET}, ${YELLOW}${WARN} warning(s)${RESET}, ${RED}${FAIL} error(s)${RESET}."
  echo
  echo "  Fix the errors above before running setup."
  echo
  exit 1
fi
