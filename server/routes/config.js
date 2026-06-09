import {
  load,
  save,
  defaults,
  exists,
  addAlias,
  addTaxonomyCorrection,
  configPath,
} from '../lib/config-store.js';
import * as classCache from '../services/classification-cache.js';

export async function get({ sendJson, res }) {
  const cfg = load();
  if (!cfg) {
    return sendJson(res, 200, { configured: false, defaults: defaults(), path: configPath() });
  }
  return sendJson(res, 200, { configured: true, config: cfg, path: configPath() });
}

export async function put({ body, sendJson, res }) {
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Body must be a JSON object' });
  }
  const merged = save(body);
  return sendJson(res, 200, { ok: true, config: merged });
}

export async function addAliasHandler({ body, sendJson, res }) {
  const { alias, matches } = body || {};
  if (!alias || !Array.isArray(matches) || matches.length === 0) {
    return sendJson(res, 400, { error: 'Body requires { alias: string, matches: [{id,name,type}] }' });
  }
  const cfg = addAlias(alias, matches);
  // New alias means past classifications might now match differently — invalidate cache
  classCache.clearAll();
  return sendJson(res, 200, { ok: true, aliasTable: cfg.aliasTable, classCacheCleared: true });
}

export async function addCorrectionHandler({ body, sendJson, res }) {
  const { keyword, seTaskType } = body || {};
  if (!keyword || !seTaskType) {
    return sendJson(res, 400, { error: 'Body requires { keyword: string, seTaskType: string }' });
  }
  const cfg = addTaxonomyCorrection(keyword, seTaskType);
  classCache.clearAll();
  return sendJson(res, 200, { ok: true, taxonomyCorrections: cfg.taxonomyCorrections, classCacheCleared: true });
}
