// MCP HTTP/Streamable transport client for the Salesforce Platform MCP servers.
//
// Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
// We POST JSON-RPC 2.0 envelopes and accept either:
//   - application/json (single response)
//   - text/event-stream (SSE; we read the first message:json event then close)
//
// All zero-deps. Auto-refreshes the access token on 401 once per call.

import { getActiveAccessToken, refreshAccessToken } from './sf-mcp-oauth.js';
import { getConfig } from './sf-mcp-store.js';

let _rpcId = 0;
function nextId() { return ++_rpcId; }

/**
 * @param {string} endpointUrl - reads or mutations endpoint
 * @param {string} method - JSON-RPC method, e.g. "tools/list", "tools/call"
 * @param {object} [params]
 * @returns {Promise<any>} the JSON-RPC `result`
 */
export async function rpc(endpointUrl, method, params = undefined) {
  let token = await getActiveAccessToken();

  const send = async (bearer) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: nextId(),
      method,
      ...(params !== undefined ? { params } : {}),
    });
    const r = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body,
    });
    return r;
  };

  let res = await send(token);
  if (res.status === 401) {
    // Token might have expired between our cache check and the call. Refresh once.
    token = await refreshAccessToken();
    res = await send(token);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
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
