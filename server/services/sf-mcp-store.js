// Persistence for the Salesforce MCP backend.
// Two files in ~/.config/sf-activity-tracker/:
//   - sf-mcp-config.json  → clientId, callbackPort, optional discovery host overrides
//   - sf-mcp-tokens.json  → access_token + refresh_token + expiry + discovered metadata
// Both files mode 0600.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';

const CONFIG_DIR = join(homedir(), '.config', 'sf-activity-tracker');
const CONFIG_PATH = join(CONFIG_DIR, 'sf-mcp-config.json');
const TOKENS_PATH = join(CONFIG_DIR, 'sf-mcp-tokens.json');

// Default discovery host. The endpoint exposes /.well-known/oauth-authorization-server
// which returns the actual authorization_endpoint and token_endpoint to use.
const DEFAULT_DISCOVERY_HOST = 'https://api.salesforce.com';

const DEFAULT_CONFIG = {
  clientId: null,                       // Connected App client_id (public, PKCE)
  callbackPort: 8082,                   // local port for the OAuth callback
  // The full redirect_uri is built as `http://${redirectHost}:${callbackPort}${redirectPath}`.
  // It MUST exactly match one of the Connected App's Callback URLs in Salesforce
  // (Setup → App Manager → Edit → API (Enable OAuth Settings) → Callback URL).
  redirectHost: 'localhost',
  redirectPath: '/callback',            // path Claude Code uses; the SF Platform MCP Connected App accepts it
  discoveryHost: DEFAULT_DISCOVERY_HOST, // host where /.well-known lives
  scopes: ['mcp_api', 'refresh_token'], // SF Platform MCP requires `mcp_api`, NOT plain `api`
  endpoints: {
    reads:     'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads',
    mutations: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-mutations',
  },
};

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function writePrivate(path, contents) {
  ensureDir();
  writeFileSync(path, contents, 'utf8');
  try { chmodSync(path, 0o600); } catch { /* non-fatal */ }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw, endpoints: { ...DEFAULT_CONFIG.endpoints, ...(raw.endpoints || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setConfig(partial) {
  const merged = { ...getConfig(), ...partial };
  writePrivate(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export function isConfigured() {
  return Boolean(getConfig().clientId);
}

// ─── Tokens ───────────────────────────────────────────────────────────────────

export function getTokens() {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function hasTokens() {
  const t = getTokens();
  return Boolean(t && t.refresh_token);
}

export function setTokens(tokens) {
  const merged = { ...(getTokens() || {}), ...tokens };
  writePrivate(TOKENS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export function clearTokens() {
  if (existsSync(TOKENS_PATH)) unlinkSync(TOKENS_PATH);
}

// ─── Paths (for diagnostics) ─────────────────────────────────────────────────

export function configPath() { return CONFIG_PATH; }
export function tokensPath() { return TOKENS_PATH; }
