// MCP HTTP/Streamable transport client for the Salesforce Platform MCP servers.
//
// Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
// The Streamable HTTP transport requires a handshake BEFORE any other method:
//   1. POST initialize        → response carries an `Mcp-Session-Id` header.
//   2. POST notifications/initialized (with that header) → server returns 202.
//   3. All subsequent calls MUST send the `Mcp-Session-Id` header.
// Skipping it yields: HTTP 400 "Session Key missing, but it's not an initialize request".
//
// We POST JSON-RPC 2.0 envelopes and accept either:
//   - application/json (single response)
//   - text/event-stream (SSE; we read the first message:json event then close)
//
// All zero-deps. Auto-refreshes the access token on 401 once per call, and
// re-initializes the session on a dropped/expired session once per call.

import { getActiveAccessToken, refreshAccessToken } from './sf-mcp-oauth.js';
import { getConfig } from './sf-mcp-store.js';

const PROTOCOL_VERSION = '2025-03-26';

let _rpcId = 0;
function nextId() { return ++_rpcId; }

// One MCP session per endpoint URL. reads and mutations are independent sessions.
// Map<endpointUrl, string sessionId>
const _sessions = new Map();

/** True when the server response means "your session is gone / never initialized". */
function isSessionError(status, text) {
  if (status === 404) return true;
  if (status === 400 && /session/i.test(text)) return true;
  return false;
}

/** Read the Mcp-Session-Id header case-insensitively. */
function readSessionId(headers) {
  return headers.get('mcp-session-id') || headers.get('Mcp-Session-Id') || null;
}

/**
 * Low-level POST of a JSON-RPC envelope. Adds the bearer token, the negotiated
 * protocol version, and (when present) the session header. Returns the raw Response.
 */
async function postRpc(endpointUrl, bearer, sessionId, message) {
  const headers = {
    'Authorization': `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return fetch(endpointUrl, { method: 'POST', headers, body: JSON.stringify(message) });
}

/**
 * Ensure there is a live MCP session for `endpointUrl`, performing the
 * initialize + notifications/initialized handshake if needed. Caches the
 * session id per endpoint. Returns the session id.
 */
async function ensureSession(endpointUrl, bearer) {
  const cached = _sessions.get(endpointUrl);
  if (cached) return cached;

  // 1. initialize
  const initRes = await postRpc(endpointUrl, bearer, null, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sf-activity-tracker', version: '0.1' },
    },
  });

  if (initRes.status === 401) {
    // Let the caller handle token refresh + retry.
    const text = await initRes.text().catch(() => '');
    const err = new Error(`MCP initialize → HTTP 401: ${text.slice(0, 300)}`);
    err.status = 401;
    throw err;
  }
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => '');
    throw new Error(`MCP initialize → HTTP ${initRes.status}: ${text.slice(0, 600)}`);
  }

  const sessionId = readSessionId(initRes.headers);
  if (!sessionId) {
    throw new Error('MCP initialize succeeded but no Mcp-Session-Id header was returned.');
  }
  // Drain the initialize body so the connection can be reused (we don't need the result).
  await initRes.text().catch(() => {});

  // 2. notifications/initialized (a notification — no id, server replies 202 with no body)
  const notifRes = await postRpc(endpointUrl, bearer, sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  // 202 Accepted is the expected outcome; anything 2xx is fine. Don't hard-fail on
  // a non-2xx here — some servers tolerate skipping it — but surface a clear error
  // if it's an auth/session problem we can act on.
  if (notifRes.status === 401) {
    const err = new Error('MCP notifications/initialized → HTTP 401');
    err.status = 401;
    throw err;
  }
  await notifRes.text().catch(() => {});

  _sessions.set(endpointUrl, sessionId);
  return sessionId;
}

/**
 * @param {string} endpointUrl - reads or mutations endpoint
 * @param {string} method - JSON-RPC method, e.g. "tools/list", "tools/call"
 * @param {object} [params]
 * @returns {Promise<any>} the JSON-RPC `result`
 */
export async function rpc(endpointUrl, method, params = undefined) {
  let token = await getActiveAccessToken();
  let refreshed = false;
  let reinitialized = false;

  // The actual request, retried at most once per failure cause (401 → refresh,
  // session error → re-init).
  while (true) {
    let sessionId;
    try {
      sessionId = await ensureSession(endpointUrl, token);
    } catch (e) {
      if (e.status === 401 && !refreshed) {
        refreshed = true;
        _sessions.delete(endpointUrl);
        token = await refreshAccessToken();
        continue;
      }
      throw e;
    }

    const res = await postRpc(endpointUrl, token, sessionId, {
      jsonrpc: '2.0',
      id: nextId(),
      method,
      ...(params !== undefined ? { params } : {}),
    });

    // Token expired between calls → refresh once and retry.
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      _sessions.delete(endpointUrl);
      token = await refreshAccessToken();
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Session dropped/expired → drop it, re-init once and retry.
      if (isSessionError(res.status, text) && !reinitialized) {
        reinitialized = true;
        _sessions.delete(endpointUrl);
        continue;
      }
      throw new Error(`MCP ${method} → HTTP ${res.status}: ${text.slice(0, 600)}`);
    }

    const ct = res.headers.get('content-type') || '';
    let payload;
    if (ct.includes('text/event-stream')) {
      payload = await readFirstSseJson(res);
    } else {
      payload = await res.json();
    }

    if (payload.error) {
      throw new Error(`MCP ${method} JSON-RPC error ${payload.error.code}: ${payload.error.message}`);
    }
    return payload.result;
  }
}

/**
 * Read an SSE stream until we see a `data: {jsonrpc...}` line, then return the parsed
 * JSON. The MCP HTTP transport may send a single message or stream — we accept both.
 */
async function readFirstSseJson(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Find the next blank-line-terminated event
    const eventEnd = buf.indexOf('\n\n');
    if (eventEnd === -1) continue;
    const eventChunk = buf.slice(0, eventEnd);
    buf = buf.slice(eventEnd + 2);
    // Concatenate `data:` lines (per SSE spec they can be multi-line)
    const dataLines = eventChunk
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) continue;
    const dataStr = dataLines.join('\n');
    try {
      const parsed = JSON.parse(dataStr);
      try { reader.cancel(); } catch {}
      return parsed;
    } catch {
      // Not JSON — keep reading
    }
  }
  throw new Error('SSE stream ended without a parseable JSON message');
}

/** Reset all cached sessions (e.g. after a disconnect). */
export function resetSessions() {
  _sessions.clear();
}

/** Convenience: list tools on the reads endpoint. */
export async function listReadsTools() {
  return rpc(getConfig().endpoints.reads, 'tools/list');
}

/** Convenience: list tools on the mutations endpoint. */
export async function listMutationsTools() {
  return rpc(getConfig().endpoints.mutations, 'tools/list');
}

/** Convenience: call a tool. `which` is 'reads' or 'mutations'. */
export async function callTool(which, name, args) {
  const endpoint = which === 'mutations'
    ? getConfig().endpoints.mutations
    : getConfig().endpoints.reads;
  return rpc(endpoint, 'tools/call', { name, arguments: args });
}
