// HTTP routes for backend mode selection (CLI vs MCP vs auto):
//   GET  /api/sf-backend/mode    → current mode + preferred + active + lastChecked
//   PUT  /api/sf-backend/mode    → update mode and/or preferred
//   POST /api/sf-backend/test    → run health checks against BOTH backends,
//                                  return per-backend results. Updates `active`
//                                  if mode is 'auto'.

import { getBackendConfig, setBackendConfig } from '../services/backend-store.js';
import { healthCheckAll } from '../services/salesforce.js';

export async function getModeHandler({ sendJson, res }) {
  sendJson(res, 200, getBackendConfig());
}

export async function putModeHandler({ body, sendJson, res }) {
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'JSON body required' });
  }
  const allowed = {};
  if (typeof body.mode === 'string' && ['cli', 'mcp', 'auto'].includes(body.mode)) {
    allowed.mode = body.mode;
  }
  if (typeof body.preferred === 'string' && ['cli', 'mcp'].includes(body.preferred)) {
    allowed.preferred = body.preferred;
  }
  if (!Object.keys(allowed).length) {
    return sendJson(res, 400, { error: 'no valid fields (expected mode and/or preferred)' });
  }
  const merged = setBackendConfig(allowed);
  sendJson(res, 200, { ok: true, config: merged });
}

export async function testHandler({ sendJson, res }) {
  const results = await healthCheckAll();
  sendJson(res, 200, { ...results, config: getBackendConfig() });
}
