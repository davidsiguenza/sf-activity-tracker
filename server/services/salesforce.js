// Router for the org62 data layer. Dispatches to salesforce-cli.js or
// salesforce-mcp.js based on the user's backend preference, with optional
// fallback in 'auto' mode.
//
// Public API (matches both backends):
//   query(soql)
//   queryTooling(soql)              ← only supported by CLI
//   createRecord(sobject, fields)
//   updateRecord(sobject, id, fields) ← only on MCP today
//   deleteRecord(sobject, id)       ← only on CLI today
//   getOrgInfo() → {instanceUrl, username}
//   getInstanceUrl()
//   healthCheck() → {ok, error?}
//
// All callers (matcher.js, create.js, setup.js, sf.js) import from here and
// don't know which backend is actually serving the request.

import * as cli from './salesforce-cli.js';
import * as mcp from './salesforce-mcp.js';
import { getBackendConfig, setActive } from './backend-store.js';

const BACKENDS = { cli, mcp };

/**
 * Decide which backend to use for the next call.
 * - mode='cli'  → always cli
 * - mode='mcp'  → always mcp
 * - mode='auto' → use cached `active` if set; otherwise `preferred`
 *
 * In auto mode, callers should be prepared to retry via the alternate
 * backend on connection-style failures — that's what tryWithFallback() does.
 */
function pickBackend() {
  const cfg = getBackendConfig();
  if (cfg.mode === 'cli') return cli;
  if (cfg.mode === 'mcp') return mcp;
  // auto
  const key = cfg.active || cfg.preferred || 'cli';
  return BACKENDS[key] || cli;
}

/**
 * Run an op against the chosen backend. In 'auto' mode, on connection
 * failure, try the other backend once and remember which one worked.
 *
 * A "connection failure" is anything that looks like the backend itself
 * is not reachable / authorized. We DON'T fallback for SOQL syntax errors
 * or business-logic failures (e.g. INVALID_FIELD) — those should surface.
 */
async function tryWithFallback(opName, fn) {
  const cfg = getBackendConfig();
  const primary = pickBackend();
  const primaryKey = primary === cli ? 'cli' : 'mcp';

  try {
    const result = await fn(primary);
    if (cfg.mode === 'auto' && cfg.active !== primaryKey) setActive(primaryKey);
    return result;
  } catch (err) {
    if (cfg.mode !== 'auto' || !isConnectionError(err)) throw err;

    const secondaryKey = primaryKey === 'cli' ? 'mcp' : 'cli';
    const secondary = BACKENDS[secondaryKey];
    try {
      const result = await fn(secondary);
      setActive(secondaryKey);
      return result;
    } catch (err2) {
      // Both failed — surface the original error with a hint.
      const composite = new Error(
        `${opName} failed on both backends. ${primaryKey}: ${err.message} | ${secondaryKey}: ${err2.message}`
      );
      composite.primary = err;
      composite.secondary = err2;
      throw composite;
    }
  }
}

/** Heuristic for "the backend isn't reachable / not authed". */
function isConnectionError(err) {
  const m = String(err?.message || '').toLowerCase();
  return (
    m.includes('not connected') ||
    m.includes('not configured') ||
    m.includes('mcp not connected') ||
    m.includes('no tokens') ||
    m.includes('no refresh token') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('sf output not json') ||  // CLI not installed / not authed
    m.includes('no authorization information found') ||
    m.includes('no org with username') ||
    m.includes('no defaultusername') ||
    m.includes('socket hang up') ||
    m.includes('401') ||
    m.includes('403') ||
    m.includes('unauthorized')
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function query(soql)               { return tryWithFallback('query',        (b) => b.query(soql)); }
export async function createRecord(s, f)        { return tryWithFallback('createRecord', (b) => b.createRecord(s, f)); }
export async function getOrgInfo()              { return tryWithFallback('getOrgInfo',   (b) => b.getOrgInfo()); }
export async function getInstanceUrl()          { return tryWithFallback('getInstanceUrl',(b) => b.getInstanceUrl()); }

/** queryTooling: only CLI supports it. Force CLI regardless of mode. */
export async function queryTooling(soql) {
  return cli.queryTooling(soql);
}

/** updateRecord: only MCP exposes it today. */
export async function updateRecord(sobject, id, fields) {
  if (typeof mcp.updateRecord === 'function') return mcp.updateRecord(sobject, id, fields);
  throw new Error('updateRecord requires the MCP backend (no CLI equivalent wired up).');
}

/** deleteRecord: only CLI exposes it today. */
export async function deleteRecord(sobject, id) {
  if (typeof cli.deleteRecord === 'function') return cli.deleteRecord(sobject, id);
  throw new Error('deleteRecord requires the CLI backend (no MCP equivalent wired up).');
}

/**
 * Run a health check against ONE specific backend.
 * @param {'cli'|'mcp'} which
 */
export async function healthCheckBackend(which) {
  const b = BACKENDS[which];
  if (!b) return { ok: false, error: `Unknown backend: ${which}` };
  try {
    const r = await b.healthCheck();
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Run a health check against BOTH backends. Useful for the Settings "Test"
 * button. Updates the cached `active` to the first one that succeeds (or
 * leaves it untouched if mode != 'auto').
 */
export async function healthCheckAll() {
  const [cliRes, mcpRes] = await Promise.all([
    healthCheckBackend('cli'),
    healthCheckBackend('mcp'),
  ]);
  const cfg = getBackendConfig();
  if (cfg.mode === 'auto') {
    const preferred = cfg.preferred || 'cli';
    const winner =
      preferred === 'cli'
        ? (cliRes.ok ? 'cli' : (mcpRes.ok ? 'mcp' : null))
        : (mcpRes.ok ? 'mcp' : (cliRes.ok ? 'cli' : null));
    if (winner) setActive(winner);
  }
  return { cli: cliRes, mcp: mcpRes };
}

/** Default healthCheck — uses the active backend (for legacy callers). */
export async function healthCheck() {
  return pickBackend().healthCheck();
}
