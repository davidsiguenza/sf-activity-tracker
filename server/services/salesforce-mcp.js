// MCP backend for org62 — uses the hosted Platform MCP servers
// (platform/sobject-reads + platform/sobject-mutations).
//
// Peer of salesforce-cli.js. The active backend is chosen by salesforce.js
// based on the user's preference in Settings → Backend Salesforce.

import { callTool } from './sf-mcp-client.js';
import { getTokens, isConfigured, hasTokens } from './sf-mcp-store.js';

/**
 * Unwrap an MCP tools/call result. The Platform MCP returns:
 *   { content: [{ type: 'text', text: '<json>' }], isError?: bool }
 * We parse the text payload as JSON and surface tool-level errors clearly.
 * @param {any} result - the JSON-RPC `result` from callTool
 * @returns {any} the parsed payload
 */
function unwrap(result) {
  const block = result?.content?.find((c) => c?.type === 'text') || result?.content?.[0];
  const text = block?.text;
  let parsed;
  if (typeof text === 'string') {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  } else {
    parsed = result;
  }
  if (result?.isError) {
    // SF errors come back as an array of {message, errorCode}
    const msg = Array.isArray(parsed)
      ? parsed.map((e) => `${e.errorCode || 'ERROR'}: ${e.message || JSON.stringify(e)}`).join('; ')
      : (parsed?.message || JSON.stringify(parsed).slice(0, 500));
    throw new Error(`MCP tool error: ${msg}`);
  }
  return parsed;
}

/** Guard: make sure the MCP connection is set up before any data call. */
function assertReady() {
  if (!isConfigured() || !hasTokens()) {
    throw new Error('Salesforce MCP not connected. Open Settings → Backend Salesforce and click Connect.');
  }
}

/**
 * Run a SOQL query against org62 via the reads MCP server.
 * @param {string} soql
 * @returns {Promise<Array<Object>>} array of records
 */
export async function query(soql) {
  assertReady();
  const res = await callTool('reads', 'soqlQuery', { q: soql });
  const payload = unwrap(res);
  return payload?.records || [];
}

/**
 * Tooling-API query. The Platform MCP `soqlQuery` runs against the standard
 * Data API, not the Tooling API, so this is not supported via MCP. Kept for
 * interface compatibility; throws a clear error if ever called (no current callers).
 */
export async function queryTooling(_soql) {
  throw new Error('queryTooling is not available over the Platform MCP (no Tooling API tool).');
}

/**
 * Create a single record via the mutations MCP server. Returns the new record Id.
 * @param {string} sobject - e.g. 'Event', 'Deal_Contribution__c'
 * @param {Object} fields - field name/value pairs (null/undefined are dropped)
 * @returns {Promise<string>} record Id
 */
export async function createRecord(sobject, fields) {
  assertReady();
  const body = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) body[k] = v;
  }
  const res = await callTool('mutations', 'createSobjectRecord', {
    'sobject-name': sobject,
    body,
  });
  const payload = unwrap(res);
  // REST create returns { id, success, errors }
  if (payload?.success === false) {
    throw new Error(`Create ${sobject} failed: ${JSON.stringify(payload.errors || payload)}`);
  }
  return payload?.id || payload?.Id;
}

/**
 * Update a single record via the mutations MCP server.
 * @param {string} sobject
 * @param {string} recordId
 * @param {Object} fields - fields to update
 * @returns {Promise<void>}
 */
export async function updateRecord(sobject, recordId, fields) {
  assertReady();
  const body = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) body[k] = v;
  }
  const res = await callTool('mutations', 'updateSobjectRecord', {
    'sobject-name': sobject,
    id: recordId,
    body,
  });
  // update returns 204 / empty on success; unwrap will throw on isError
  unwrap(res);
}

/**
 * Delete is not exposed by the reads/mutations MCP servers (would need
 * platform/sobject-deletes). Kept for interface compatibility.
 */
export async function deleteRecord(_sobject, _recordId) {
  throw new Error('deleteRecord requires the platform/sobject-deletes MCP server (not connected).');
}

/**
 * Resolve org metadata via MCP. instanceUrl comes from the stored token blob;
 * username comes from the getUserInfo tool. Cached after first call.
 * @returns {Promise<{instanceUrl: string, username: string}>}
 */
let _orgInfoCache = null;
export async function getOrgInfo() {
  if (_orgInfoCache) return _orgInfoCache;
  assertReady();
  const instanceUrl = getTokens()?.instance_url || 'https://org62.my.salesforce.com';
  let username = null;
  try {
    const info = unwrap(await callTool('reads', 'getUserInfo', {}));
    username = info?.identity?.username || info?.username || null;
  } catch {
    // non-fatal — username is only used for setup auto-detect
  }
  _orgInfoCache = { instanceUrl, username };
  return _orgInfoCache;
}

/** Convenience wrapper for the older callers. */
export async function getInstanceUrl() {
  return (await getOrgInfo()).instanceUrl;
}

/**
 * Quick health check: run a trivial query over MCP.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function healthCheck() {
  try {
    await query('SELECT Id FROM Organization LIMIT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
