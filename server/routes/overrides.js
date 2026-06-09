// Routes for user overrides (manual edits in the draft plan that persist).

import * as overrides from '../services/overrides-store.js';

/**
 * POST /api/override
 * Body: { eventId, hash, fields }
 *  fields: any subset of { relatedTo, seTaskType, isCF, isCR }
 */
export async function set({ body, sendJson, res }) {
  const { eventId, hash, fields } = body || {};
  if (!eventId || !hash || !fields || typeof fields !== 'object') {
    return sendJson(res, 400, { error: 'Body requires { eventId, hash, fields }' });
  }
  overrides.setOverride(eventId, hash, fields);
  return sendJson(res, 200, { ok: true });
}

/**
 * POST /api/override/clear
 * Body: { eventId }
 * Or { all: true } to wipe everything.
 */
export async function clear({ body, sendJson, res }) {
  if (body?.all) {
    overrides.clearAll();
    return sendJson(res, 200, { ok: true, cleared: 'all' });
  }
  const { eventId } = body || {};
  if (!eventId) return sendJson(res, 400, { error: 'eventId required (or { all: true })' });
  overrides.clearOverride(eventId);
  return sendJson(res, 200, { ok: true });
}

export async function stats({ sendJson, res }) {
  return sendJson(res, 200, overrides.stats());
}
