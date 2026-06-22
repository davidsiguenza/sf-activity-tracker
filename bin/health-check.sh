#!/usr/bin/env bash
# Post-deploy health check for sf-activity-tracker.
#
# Verifies the running server can reach Salesforce, Google API tokens are
# present, and the config file exists. Run this after first setup to confirm
# everything is wired up correctly, or any time you suspect something broke.
#
# Usage:
#   ./bin/health-check.sh

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

CONFIG_DIR="$HOME/.config/sf-activity-tracker"
SERVER_URL="http://127.0.0.1:7825"

echo
echo "─── sf-activity-tracker · health check ──────────────────────────────"
echo

# ─── Server reachable ────────────────────────────────────────────────────────
echo "Server ($SERVER_URL)"
HEALTH_JSON="$(curl -fsS --max-time 5 "$SERVER_URL/api/health" 2>/dev/null || echo "")"
if [ -z "$HEALTH_JSON" ]; then
  fail "server not responding on $SERVER_URL"
  hint "Start it: ./bin/launchd-install.sh status      (and: install if not running)"
  hint "Logs:     tail -f ~/Library/Logs/sf-activity-tracker.log"
  echo
  echo "─── Aborted — server must be running for the rest of the checks ───────"
  exit 1
else
  ok "server is up"
fi
echo

# ─── /api/health reports ok ──────────────────────────────────────────────────
echo "Health endpoint"
HEALTH_OK="$(echo "$HEALTH_JSON" | grep -o '"ok": *[a-z]*' | head -1 | awk -F: '{print $2}' | tr -d ' ')"
CONFIGURED="$(echo "$HEALTH_JSON" | grep -o '"configured": *[a-z]*' | awk -F: '{print $2}' | tr -d ' ')"

if [ "$HEALTH_OK" = "true" ]; then
  ok "/api/health → ok"
else
  fail "/api/health → not ok"
  hint "Raw response: $HEALTH_JSON"
fi

if [ "$CONFIGURED" = "true" ]; then
  ok "config.json exists"
else
  fail "config.json missing — setup wizard not completed"
  hint "Open $SERVER_URL in your browser and run the setup wizard."
fi
echo

# ─── Backend org62 — test BOTH CLI and MCP in parallel ─────────────────────
echo "org62 backends"
BACKEND_JSON="$(curl -fsS --max-time 15 -X POST "$SERVER_URL/api/sf-backend/test" 2>/dev/null || echo "")"
if [ -z "$BACKEND_JSON" ]; then
  warn "couldn't reach /api/sf-backend/test"
else
  MODE="$(echo "$BACKEND_JSON" | grep -o '"mode": *"[^"]*"' | head -1 | awk -F'"' '{print $4}')"
  ACTIVE="$(echo "$BACKEND_JSON" | grep -o '"active": *"[^"]*"' | head -1 | awk -F'"' '{print $4}')"
  CLI_OK="$(echo "$BACKEND_JSON" | grep -o '"cli":{[^}]*}' | grep -o '"ok": *[a-z]*' | head -1 | awk -F: '{print $2}' | tr -d ' ')"
  MCP_OK="$(echo "$BACKEND_JSON" | grep -o '"mcp":{[^}]*}' | grep -o '"ok": *[a-z]*' | head -1 | awk -F: '{print $2}' | tr -d ' ')"
  CLI_ERR="$(echo "$BACKEND_JSON" | grep -o '"cli":{[^}]*}' | sed -E 's/.*"error": *"([^"]+)".*/\1/' | head -1)"
  MCP_ERR="$(echo "$BACKEND_JSON" | grep -o '"mcp":{[^}]*}' | sed -E 's/.*"error": *"([^"]+)".*/\1/' | head -1)"

  if [ "$CLI_OK" = "true" ]; then
    ok "CLI backend reachable (sf data query on org62)"
  else
    warn "CLI backend not reachable"
    [ -n "$CLI_ERR" ] && [ "$CLI_ERR" != "$BACKEND_JSON" ] && hint "$CLI_ERR"
    hint "Fix: sf org login web --alias org62  (or use mode='mcp')"
  fi

  if [ "$MCP_OK" = "true" ]; then
    ok "MCP backend reachable (Platform MCP soqlQuery)"
  else
    warn "MCP backend not reachable"
    [ -n "$MCP_ERR" ] && [ "$MCP_ERR" != "$BACKEND_JSON" ] && hint "$MCP_ERR"
    hint "Fix: Settings → Backend Salesforce — MCP config → Connect via OAuth"
  fi

  if [ "$CLI_OK" != "true" ] && [ "$MCP_OK" != "true" ]; then
    fail "neither backend works — analyses will fail"
  else
    ok "active backend: ${ACTIVE:-?} · mode: ${MODE:-?}"
  fi
fi
echo

# ─── Config file presence ────────────────────────────────────────────────────
echo "Config files in $CONFIG_DIR"
if [ -f "$CONFIG_DIR/config.json" ]; then
  SE_NAME="$(grep -o '"seName": *"[^"]*"' "$CONFIG_DIR/config.json" 2>/dev/null | sed 's/.*"seName": *"\([^"]*\)".*/\1/')"
  SE_EMAIL="$(grep -o '"seEmail": *"[^"]*"' "$CONFIG_DIR/config.json" 2>/dev/null | sed 's/.*"seEmail": *"\([^"]*\)".*/\1/')"
  if [ -n "${SE_NAME:-}" ]; then
    ok "config.json — logged in as $SE_NAME ($SE_EMAIL)"
  else
    warn "config.json exists but seName/seEmail not parsable"
  fi
else
  fail "config.json not found"
fi

if [ -f "$CONFIG_DIR/oauth-client.json" ]; then
  ok "oauth-client.json present (Google OAuth client uploaded)"
else
  warn "oauth-client.json missing"
  hint "You'll fall back to the slow Claude+MCP path for calendar fetches."
  hint "Upload your GCP OAuth client JSON in Settings → Google Calendar backend."
fi

if [ -f "$CONFIG_DIR/oauth-tokens.json" ]; then
  ok "oauth-tokens.json present (Google authorized)"
else
  warn "oauth-tokens.json missing"
  hint "Click 'Connect with Google' in Settings to authorize."
fi
echo

# ─── Calendar backend self-report ────────────────────────────────────────────
echo "Calendar backend status"
CAL_JSON="$(curl -fsS --max-time 5 "$SERVER_URL/api/calendar/status" 2>/dev/null || echo "")"
if [ -n "$CAL_JSON" ]; then
  if echo "$CAL_JSON" | grep -q '"googleApiConfigured": *true'; then
    ok "Google Calendar API configured (fast path)"
  else
    warn "Google Calendar API not configured — using Claude+MCP fallback (slow)"
    hint "To enable the fast path: Settings → Connect with Google."
  fi
else
  warn "couldn't fetch calendar backend status"
fi
echo

# ─── launchd agent status ────────────────────────────────────────────────────
echo "launchd auto-start"
if launchctl list 2>/dev/null | grep -q "com.dsp.sf-activity-tracker"; then
  ok "launchd agent loaded (server auto-starts on login)"
else
  warn "launchd agent not loaded"
  hint "Install with: ./bin/launchd-install.sh install"
  hint "(Optional — without it, you have to start the server manually after reboot.)"
fi
echo

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "─── Summary ─────────────────────────────────────────────────────────"
echo
if [ $FAIL -eq 0 ]; then
  echo "  ${GREEN}${PASS} OK${RESET}, ${YELLOW}${WARN} warning(s)${RESET}, 0 errors."
  echo
  echo "  Deploy looks healthy. You can run an analysis from $SERVER_URL."
  echo
  exit 0
else
  echo "  ${GREEN}${PASS} OK${RESET}, ${YELLOW}${WARN} warning(s)${RESET}, ${RED}${FAIL} error(s)${RESET}."
  echo
  echo "  Fix the errors above. Most failures are auth-related — re-run after"
  echo "  fixing and the picture should be clean."
  echo
  exit 1
fi
