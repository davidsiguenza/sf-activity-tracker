// Google OAuth 2.0 flow with PKCE for desktop installed apps.
//
// Flow:
//   1. UI calls POST /api/oauth/start → server returns auth URL
//   2. Browser navigates to Google (or we use child_process to open it)
//   3. User authorizes scopes
//   4. Google redirects to http://127.0.0.1:7825/api/oauth/callback?code=...&state=...
//   5. Our existing HTTP server handles that callback path → exchanges code for tokens
//   6. Tokens saved to oauth-tokens.json, browser shown a "you can close this tab" page
//
// Same redirect URI must be added to the OAuth client in GCP Console: http://127.0.0.1:7825/api/oauth/callback

import { randomBytes, createHash } from 'node:crypto';
import { getClient, setTokens, getTokens } from './oauth-store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

// In-memory state for the current pending auth flow.
// Only one auth at a time — second call replaces the previous.
let _pending = null;

const REDIRECT_URI = 'http://127.0.0.1:7825/api/oauth/callback';

/**
 * Begin a new auth flow. Generates PKCE verifier/challenge + state.
 * @returns {{authUrl: string}}
 */
export function startAuthFlow() {
  const client = getClient();
  if (!client) throw new Error('No OAuth client configured. Upload your client JSON first.');
  if (!client.client_id) throw new Error('Client JSON missing client_id.');

  const code_verifier = base64url(randomBytes(64));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  const state = base64url(randomBytes(16));

  _pending = {
    code_verifier,
    state,
    startedAt: Date.now(),
  };

  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // we want a refresh_token
    prompt: 'consent',      // force-show consent so refresh_token is reliably issued
  });

  return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
}

/**
 * Handle the redirect from Google. Validates state and exchanges code for tokens.
 * @param {string} code
 * @param {string} state
 * @returns {Promise<{access_token, refresh_token, expires_at, scope}>}
 */
export async function handleCallback(code, state) {
  if (!_pending) throw new Error('No pending auth flow. Click Connect again to restart.');
  if (state !== _pending.state) {
    _pending = null;
    throw new Error('State mismatch — possible CSRF, restarting flow.');
  }
  if (Date.now() - _pending.startedAt > 10 * 60 * 1000) {
    _pending = null;
    throw new Error('Auth flow expired (>10 min). Click Connect again.');
  }

  const client = getClient();
  if (!client) throw new Error('Client JSON disappeared mid-flow.');

  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: _pending.code_verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await r.text();
  if (!r.ok) {
    _pending = null;
    throw new Error(`Token exchange failed (${r.status}): ${text.slice(0, 400)}`);
  }
  const j = JSON.parse(text);

  _pending = null;
  const expiresAt = Date.now() + (j.expires_in || 3500) * 1000;
  return setTokens({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    scope: j.scope,
    token_type: j.token_type,
    expires_at: expiresAt,
    obtained_at: Date.now(),
  });
}

/**
 * Use the saved refresh_token to obtain a fresh access_token.
 * @returns {Promise<string>} access_token
 */
export async function refreshAccessToken() {
  const tokens = getTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh token. Reconnect Google.');
  const client = getClient();
  if (!client) throw new Error('Client JSON missing.');

  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Token refresh failed (${r.status}): ${text.slice(0, 400)}`);
  }
  const j = JSON.parse(text);
  const expiresAt = Date.now() + (j.expires_in || 3500) * 1000;
  setTokens({
    access_token: j.access_token,
    expires_at: expiresAt,
    scope: j.scope || tokens.scope,
    token_type: j.token_type || tokens.token_type,
  });
  return j.access_token;
}

/**
 * Get a usable access token. Refreshes if expired.
 */
export async function getActiveAccessToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('No tokens stored.');
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  return refreshAccessToken();
}

// ─── PKCE helper ─────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const REDIRECT_PATH = '/api/oauth/callback';
export { REDIRECT_URI };
