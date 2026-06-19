// Salesforce Platform MCP — OAuth 2.0 Authorization Code + PKCE with discovery.
//
// Pattern (RFC 8414 + RFC 7636):
//   1. GET https://api.salesforce.com/.well-known/oauth-authorization-server
//      → { authorization_endpoint, token_endpoint, scopes_supported, ... }
//   2. Generate PKCE verifier + challenge.
//   3. Spawn a temporary HTTP listener on `callbackPort` to capture the redirect.
//   4. Open browser to authorization_endpoint with PKCE challenge + state.
//   5. User completes SSO in browser. Salesforce redirects to
//      http://127.0.0.1:<callbackPort>/sf-mcp/oauth/callback?code=...&state=...
//   6. Local listener captures it, exchanges code for tokens at token_endpoint.
//   7. Persist tokens, shut listener down. Browser shown a "you can close this tab" page.
//
// All zero-deps — uses node:http, node:crypto and global fetch (Node 20+).

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getConfig, getTokens, setTokens, setConfig } from './sf-mcp-store.js';

// In-memory state for the current pending flow. Only one at a time.
let _pending = null;

function base64url(buf) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Discover OAuth endpoints by GETting /.well-known/oauth-authorization-server
 * against the configured discovery host. Falls back to RFC 8414 defaults if the
 * server returns something usable but incomplete.
 *
 * @returns {Promise<{authorization_endpoint: string, token_endpoint: string, scopes_supported?: string[], registration_endpoint?: string, raw: object}>}
 */
export async function discover() {
  const cfg = getConfig();
  const url = `${cfg.discoveryHost.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    throw new Error(`OAuth discovery failed (${r.status}) at ${url}: ${await r.text().catch(() => '')}`);
  }
  const meta = await r.json();
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`Discovery response missing authorization_endpoint or token_endpoint: ${JSON.stringify(meta).slice(0, 500)}`);
  }
  return {
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    scopes_supported: meta.scopes_supported || null,
    registration_endpoint: meta.registration_endpoint || null,
    raw: meta,
  };
}

/**
 * Run the full interactive OAuth flow:
 *   - discover endpoints
 *   - spawn callback listener on cfg.callbackPort
 *   - open browser to auth URL
 *   - capture code, exchange for tokens, persist, return them
 *
 * Resolves with the persisted token blob. Rejects on timeout (5 min), state
 * mismatch, or token endpoint failure.
 *
 * @param {{onAuthUrl?: (url: string) => void}} [opts]
 * @returns {Promise<object>}
 */
export async function runAuthFlow(opts = {}) {
  const cfg = getConfig();
  if (!cfg.clientId) throw new Error('clientId not configured. Save it in Settings → Backend Salesforce first.');

  const meta = await discover();

  const code_verifier = base64url(randomBytes(64));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  const state = base64url(randomBytes(16));

  // Build the redirect URI from config. Default `http://localhost:8082/callback` —
  // the SF Platform MCP Connected App accepts the same path Claude Code uses.
  const callbackPath = cfg.redirectPath || '/callback';
  const redirectHost = cfg.redirectHost || 'localhost';
  const redirectUri = `http://${redirectHost}:${cfg.callbackPort}${callbackPath}`;

  // SF Platform MCP requires the `mcp_api` scope, not the generic `api` scope.
  const scope = (cfg.scopes && cfg.scopes.length ? cfg.scopes : ['mcp_api', 'refresh_token']).join(' ');

  // Use the URL API so any query params already present in authorization_endpoint
  // (e.g. Salesforce returns `...?prompt=select_account`) survive correctly.
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', code_challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  const authUrl = u.toString();

  // Stash so a parallel call rejects cleanly
  if (_pending) {
    try { _pending.cleanup(); } catch {}
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => { if (done) return; done = true; cleanup(); fn(val); };

    const server = createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${cfg.callbackPort}`);
        if (u.pathname !== callbackPath) {
          res.statusCode = 404;
          return res.end('Not found');
        }
        const code = u.searchParams.get('code');
        const gotState = u.searchParams.get('state');
        const err = u.searchParams.get('error');

        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h2>Auth failed</h2><pre>${escapeHtml(err)}: ${escapeHtml(u.searchParams.get('error_description') || '')}</pre><p>You can close this tab.</p>`);
          return finish(reject, new Error(`OAuth error: ${err}`));
        }
        if (!code || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Auth callback missing code or state mismatch.</h2><p>Restart the connect flow.</p>');
          return finish(reject, new Error('State mismatch or missing code'));
        }

        // Exchange code for tokens
        exchangeCode(meta.token_endpoint, cfg.clientId, code, code_verifier, redirectUri)
          .then((tokens) => {
            // Persist + bonus: persist the discovered metadata so refresh can use it
            setTokens({
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              token_type: tokens.token_type,
              expires_at: Date.now() + (tokens.expires_in || 3500) * 1000,
              scope: tokens.scope,
              instance_url: tokens.instance_url || null,
              issued_at: tokens.issued_at || Date.now(),
              discovered: {
                authorization_endpoint: meta.authorization_endpoint,
                token_endpoint: meta.token_endpoint,
              },
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(SUCCESS_HTML);
            finish(resolve, getTokens());
          })
          .catch((e) => {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>Token exchange failed</h2><pre>${escapeHtml(e.message)}</pre>`);
            finish(reject, e);
          });
      } catch (e) {
        res.writeHead(500);
        res.end('Internal error');
        finish(reject, e);
      }
    });

    const timeoutMs = 5 * 60 * 1000;
    const timer = setTimeout(() => finish(reject, new Error('Auth flow timed out (5 min). Click Connect again.')), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try { server.close(); } catch {}
      _pending = null;
    };

    _pending = { cleanup };

    server.on('error', (e) => finish(reject, e));
    server.listen(cfg.callbackPort, '127.0.0.1', () => {
      // Hand the URL back to caller (so it can be displayed) AND open the browser ourselves.
      try { opts.onAuthUrl?.(authUrl); } catch {}
      openBrowser(authUrl);
    });
  });
}

/**
 * Exchange the authorization code for tokens. Public client (PKCE), no client_secret.
 */
async function exchangeCode(tokenEndpoint, clientId, code, codeVerifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Token exchange ${r.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

/**
 * Use the refresh_token to obtain a new access_token. Persists the new token.
 * @returns {Promise<string>} the new access_token
 */
export async function refreshAccessToken() {
  const tokens = getTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh token. Reconnect Salesforce MCP.');
  const cfg = getConfig();
  if (!cfg.clientId) throw new Error('clientId not configured.');

  // Prefer the previously discovered token endpoint to avoid a second discovery roundtrip.
  let tokenEndpoint = tokens.discovered?.token_endpoint;
  if (!tokenEndpoint) {
    const meta = await discover();
    tokenEndpoint = meta.token_endpoint;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: cfg.clientId,
  });
  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Token refresh ${r.status}: ${text.slice(0, 600)}`);
  const j = JSON.parse(text);
  setTokens({
    access_token: j.access_token,
    expires_at: Date.now() + (j.expires_in || 3500) * 1000,
    scope: j.scope || tokens.scope,
    token_type: j.token_type || tokens.token_type,
    // SF often issues a NEW refresh_token on each refresh — use it if present
    ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}),
  });
  return j.access_token;
}

/**
 * Return a usable access_token, refreshing if it's near expiry.
 */
export async function getActiveAccessToken() {
  const tokens = getTokens();
  if (!tokens) throw new Error('No tokens. Connect to Salesforce MCP first.');
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  return refreshAccessToken();
}

function openBrowser(url) {
  // execFile (not exec) — args array, no shell, no injection.
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font:14px system-ui,sans-serif;padding:48px;max-width:600px;margin:auto;text-align:center}h1{color:#047857}</style>
</head><body>
<h1>✓ Connected to Salesforce MCP</h1>
<p>Tokens stored. You can close this tab and return to sf-activity-tracker.</p>
</body></html>`;
