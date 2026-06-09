// Persistence for OAuth credentials and tokens, separate from app config.
// Two files in ~/.config/sf-activity-tracker/:
//   - oauth-client.json  → user's OAuth2 client_id + client_secret (from GCP Console)
//   - oauth-tokens.json  → access_token + refresh_token + expiry, written after auth flow
//
// File mode 0600 — only owner can read.

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
const CLIENT_PATH = join(CONFIG_DIR, 'oauth-client.json');
const TOKENS_PATH = join(CONFIG_DIR, 'oauth-tokens.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function writePrivate(path, contents) {
  ensureDir();
  writeFileSync(path, contents, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-fatal on systems that don't honor mode */
  }
}

// ─── Client credentials (from GCP Console) ───────────────────────────────────

/** @returns {{client_id, client_secret, project_id?, auth_uri?, token_uri?, redirect_uris?} | null} */
export function getClient() {
  if (!existsSync(CLIENT_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLIENT_PATH, 'utf8'));
    // Support both shapes: bare object or wrapped in { installed: {...} } / { web: {...} }
    if (raw.installed) return raw.installed;
    if (raw.web) return raw.web;
    if (raw.client_id) return raw;
    return null;
  } catch {
    return null;
  }
}

export function hasClient() {
  return getClient() !== null;
}

/**
 * Persist user's client JSON (the file they downloaded from GCP Console).
 * Accepts raw contents — we parse and validate.
 * @param {string} contents - the JSON string of the client_secret_*.json file
 * @returns {{client_id, project_id?: string}}
 */
export function setClient(contents) {
  let parsed;
  try {
    parsed = typeof contents === 'string' ? JSON.parse(contents) : contents;
  } catch (e) {
    throw new Error(`Could not parse client JSON: ${e.message}`);
  }
  const inner = parsed.installed || parsed.web || parsed;
  if (!inner.client_id || !inner.client_secret) {
    throw new Error('Missing client_id or client_secret in JSON. Did you download the right file?');
  }
  writePrivate(CLIENT_PATH, JSON.stringify(parsed, null, 2));
  return { client_id: inner.client_id, project_id: inner.project_id };
}

export function clearClient() {
  if (existsSync(CLIENT_PATH)) unlinkSync(CLIENT_PATH);
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/**
 * @returns {{access_token, refresh_token, expires_at, scope, token_type}|null}
 */
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
  return !!(t && t.refresh_token);
}

export function setTokens(tokens) {
  const merged = { ...(getTokens() || {}), ...tokens };
  writePrivate(TOKENS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export function clearTokens() {
  if (existsSync(TOKENS_PATH)) unlinkSync(TOKENS_PATH);
}

export function clientPath() {
  return CLIENT_PATH;
}

export function tokensPath() {
  return TOKENS_PATH;
}
