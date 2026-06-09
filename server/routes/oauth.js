// Routes for the in-app Google OAuth2 flow.

import { execFile } from 'node:child_process';
import {
  getClient,
  hasClient,
  setClient,
  clearClient,
  getTokens,
  hasTokens,
  clearTokens,
  clientPath,
  tokensPath,
} from '../services/oauth-store.js';
import { startAuthFlow, handleCallback } from '../services/oauth-flow.js';
import { clearCalendarCache } from '../services/calendar.js';

/**
 * GET /api/oauth/status
 * Cheap snapshot for the UI: do we have a client? Tokens? Which scopes?
 */
export async function status({ sendJson, res }) {
  const client = getClient();
  const tokens = getTokens();
  return sendJson(res, 200, {
    hasClient: hasClient(),
    hasTokens: hasTokens(),
    clientId: client?.client_id ? maskClientId(client.client_id) : null,
    projectId: client?.project_id || null,
    scopes: tokens?.scope || null,
    obtainedAt: tokens?.obtained_at || null,
    expiresAt: tokens?.expires_at || null,
    paths: {
      client: clientPath(),
      tokens: tokensPath(),
    },
  });
}

/**
 * POST /api/oauth/set-client
 * Body: { contents: string } — full text of client_secret_*.json downloaded from GCP Console
 */
export async function setClientHandler({ body, sendJson, res }) {
  const contents = body?.contents;
  if (!contents || typeof contents !== 'string') {
    return sendJson(res, 400, { error: 'body.contents must be the JSON string from GCP Console' });
  }
  try {
    const info = setClient(contents);
    return sendJson(res, 200, { ok: true, clientId: maskClientId(info.client_id), projectId: info.project_id });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

/**
 * POST /api/oauth/start
 * Returns the Google auth URL. The frontend opens it in a new tab; the user authorizes;
 * Google redirects to /api/oauth/callback (handled below).
 */
export async function startHandler({ sendJson, res }) {
  if (!hasClient()) {
    return sendJson(res, 400, { error: 'Upload your OAuth client JSON first.' });
  }
  try {
    const { authUrl } = startAuthFlow();
    // Try to open the browser server-side too (best-effort, may not work in all envs)
    if (process.platform === 'darwin') execFile('open', [authUrl], () => {});
    return sendJson(res, 200, { authUrl });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

/**
 * GET /api/oauth/callback?code=...&state=...
 * Google redirects here. NOT a JSON endpoint — we render an HTML page and close.
 */
export async function callbackHandler({ url, res }) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return renderClosingPage(res, false, `Google returned error: ${errorParam}`);
  }
  if (!code || !state) {
    return renderClosingPage(res, false, 'Missing code or state.');
  }

  try {
    await handleCallback(code, state);
    // Important: drop any cached calendar data so the next analyze refetches
    // with the new auth source.
    clearCalendarCache();
    return renderClosingPage(res, true, 'Connected. You can close this tab.');
  } catch (e) {
    return renderClosingPage(res, false, e.message);
  }
}

/**
 * POST /api/oauth/disconnect
 * Drops the stored tokens. Keeps the client JSON so user can reconnect easily.
 */
export async function disconnectHandler({ body, sendJson, res }) {
  clearTokens();
  if (body && body.alsoForgetClient) clearClient();
  clearCalendarCache();
  return sendJson(res, 200, { ok: true });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function maskClientId(id) {
  if (!id) return null;
  // 928393740898-3jpuig...apps.googleusercontent.com → 928393…apps.googleusercontent.com
  return id.length > 20 ? `${id.slice(0, 6)}…${id.slice(-25)}` : id;
}

function renderClosingPage(res, ok, message) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const safeMsg = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const color = ok ? '#1a7f37' : '#cf222e';
  const icon = ok ? '✓' : '✗';
  const title = ok ? 'Connected' : 'Connection failed';
  res.end(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${title}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh; margin: 0; background: #f6f8fa; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 32px 40px; max-width: 480px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
h1 { margin: 0 0 8px 0; font-size: 20px; color: ${color}; }
p { color: #57606a; line-height: 1.5; margin: 0 0 16px 0; }
button { background: #0969da; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font: inherit; cursor: pointer; }
</style></head>
<body><div class="card">
<h1>${icon} ${title}</h1>
<p>${safeMsg}</p>
<button onclick="window.close()">Close tab</button>
</div></body></html>`);
}
