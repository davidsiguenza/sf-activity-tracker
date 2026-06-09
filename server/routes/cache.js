// Cache management endpoints (classification cache).

import * as classCache from '../services/classification-cache.js';

export async function stats({ sendJson, res }) {
  return sendJson(res, 200, classCache.stats());
}

export async function clear({ sendJson, res }) {
  classCache.clearAll();
  return sendJson(res, 200, { ok: true, cleared: true });
}

export async function prune({ sendJson, res }) {
  const pruned = classCache.prune();
  return sendJson(res, 200, { ok: true, pruned });
}
