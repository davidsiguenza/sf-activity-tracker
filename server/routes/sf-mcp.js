// HTTP routes for the Salesforce MCP backend (Fase 1):
//   GET  /api/sf-mcp/config        → current config (no secrets — clientId is public)
//   PUT  /api/sf-mcp/config        → update clientId / callbackPort / scopes / endpoints
//   GET  /api/sf-mcp/status        → has clientId? has tokens? connected?
//   POST /api/sf-mcp/oauth/start   → kicks off the browser-based OAuth flow.
//                                     Resolves when tokens land OR rejects on timeout.
//   POST /api/sf-mcp/oauth/disconnect → wipes the tokens file
//   POST /api/sf-mcp/test          → calls tools/list against both endpoints and returns
//                                     the lists. Used to validate that auth is wired up
//                                     and to discover the tool names we'll wrap in Fase 2.

import { runAuthFlow } from '../services/sf-mcp-oauth.js';
import * as store from '../services/sf-mcp-store.js';
import { listReadsTools, listMutationsTools } from '../services/sf-mcp-client.js';

function computeRedirectUri(cfg) {
  return `http://${cfg.redirectHost || 'localhost'}:${cfg.callbackPort}${cfg.redirectPath || '/oauth/callback'}`;
}

export async function getConfigHandler({ sendJson, res }) {
  const cfg = store.getConfig();
  sendJson(res, 200, {
    clientId: cfg.clientId,
    callbackPort: cfg.callbackPort,
    redirectHost: cfg.redirectHost,
    redirectPath: cfg.redirectPath,
    redirectUri: computeRedirectUri(cfg), // computed for convenience — register THIS in the Connected App
    discoveryHost: cfg.discoveryHost,
    scopes: cfg.scopes,
    endpoints: cfg.endpoints,
    hasTokens: store.hasTokens(),
  });
}

export async function putConfigHandler({ body, sendJson, res }) {
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'JSON body required' });
  }
  const allowed = {};
  if (typeof body.clientId === 'string')      allowed.clientId = body.clientId.trim() || null;
  if (Number.isInteger(body.callbackPort))    allowed.callbackPort = body.callbackPort;
  if (typeof body.redirectHost === 'string')  allowed.redirectHost = body.redirectHost.trim() || 'localhost';
  if (typeof body.redirectPath === 'string')  allowed.redirectPath = body.redirectPath.trim() || '/oauth/callback';
  if (typeof body.discoveryHost === 'string') allowed.discoveryHost = body.discoveryHost.trim();
  if (Array.isArray(body.scopes))             allowed.scopes = body.scopes.filter((s) => typeof s === 'string');
  if (body.endpoints && typeof body.endpoints === 'object') allowed.endpoints = body.endpoints;
  const merged = store.setConfig(allowed);
  sendJson(res, 200, { ok: true, config: merged, redirectUri: computeRedirectUri(merged) });
}

export async function statusHandler({ sendJson, res }) {
  const cfg = store.getConfig();
  const tokens = store.getTokens();
  sendJson(res, 200, {
    configured: store.isConfigured(),
    hasTokens: store.hasTokens(),
    expiresAt: tokens?.expires_at || null,
    scope: tokens?.scope || null,
    instanceUrl: tokens?.instance_url || null,
    clientId: cfg.clientId,
    callbackPort: cfg.callbackPort,
  });
}

export async function oauthStartHandler({ sendJson, res }) {
  if (!store.isConfigured()) {
    return sendJson(res, 400, { error: 'clientId not configured. Save it first.' });
  }
  try {
    let authUrlSent = false;
    // runAuthFlow resolves when tokens are persisted (or rejects on timeout/error).
    // We want to send the authUrl back to the UI ASAP so it can show "browser opened",
    // but the response only completes when the flow finishes. Use a chunked-style
    // pattern: write a tiny progress payload first, then the final result.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const tokens = await runAuthFlow({
      onAuthUrl: (url) => {
        if (authUrlSent) return;
        authUrlSent = true;
        // Note: we don't actually flush partial JSON here — the UI just waits
        // for the final response. Logging the URL is enough for diagnostics.
        console.log('[sf-mcp] OAuth URL:', url);
      },
    });
    res.end(JSON.stringify({
      ok: true,
      hasTokens: true,
      scope: tokens.scope,
      expiresAt: tokens.expires_at,
      instanceUrl: tokens.instance_url || null,
    }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

export async function oauthDisconnectHandler({ sendJson, res }) {
  store.clearTokens();
  sendJson(res, 200, { ok: true });
}

/**
 * Calls tools/list against both endpoints. Used to:
 *   1. Validate that auth is working (any 401/403 surfaces here).
 *   2. Discover the actual tool names the server exposes — needed before we can
 *      wrap query/createRecord in Fase 2.
 */
export async function testHandler({ sendJson, res }) {
  const out = { reads: null, mutations: null };
  try {
    out.reads = await listReadsTools();
  } catch (e) {
    out.reads = { error: e.message };
  }
  try {
    out.mutations = await listMutationsTools();
  } catch (e) {
    out.mutations = { error: e.message };
  }
  sendJson(res, 200, out);
}
