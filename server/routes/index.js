// Route registry — minimal pattern-matching for our small endpoint set.

import * as configRoute from './config.js';
import * as setupRoute from './setup.js';
import * as analyzeRoute from './analyze.js';
import * as createRoute from './create.js';
import * as healthRoute from './health.js';
import * as calendarRoute from './calendar.js';
import * as oauthRoute from './oauth.js';
import * as cacheRoute from './cache.js';

const ROUTES = [
  { method: 'GET', path: '/api/health', handler: healthRoute.get },
  { method: 'GET', path: '/api/config', handler: configRoute.get },
  { method: 'PUT', path: '/api/config', handler: configRoute.put },
  { method: 'POST', path: '/api/config/alias', handler: configRoute.addAliasHandler },
  { method: 'POST', path: '/api/config/correction', handler: configRoute.addCorrectionHandler },
  { method: 'POST', path: '/api/setup/resolve-user', handler: setupRoute.resolveUser },
  { method: 'POST', path: '/api/setup/save', handler: setupRoute.saveSetup },
  { method: 'POST', path: '/api/setup/lookup', handler: setupRoute.lookupRecord },
  { method: 'POST', path: '/api/analyze', handler: analyzeRoute.post },
  { method: 'POST', path: '/api/create', handler: createRoute.post },
  { method: 'GET',  path: '/api/calendar/status', handler: calendarRoute.status },
  { method: 'POST', path: '/api/calendar/test', handler: calendarRoute.test },
  { method: 'POST', path: '/api/calendar/clear-cache', handler: calendarRoute.clearCache },
  { method: 'GET',  path: '/api/calendar/list', handler: calendarRoute.list },
  // OAuth in-app flow
  { method: 'GET',  path: '/api/oauth/status',     handler: oauthRoute.status },
  { method: 'POST', path: '/api/oauth/set-client', handler: oauthRoute.setClientHandler },
  { method: 'POST', path: '/api/oauth/start',      handler: oauthRoute.startHandler },
  { method: 'GET',  path: '/api/oauth/callback',   handler: oauthRoute.callbackHandler },
  { method: 'POST', path: '/api/oauth/disconnect', handler: oauthRoute.disconnectHandler },
  // Classification cache
  { method: 'GET',  path: '/api/cache/stats', handler: cacheRoute.stats },
  { method: 'POST', path: '/api/cache/clear', handler: cacheRoute.clear },
  { method: 'POST', path: '/api/cache/prune', handler: cacheRoute.prune },
];

export function match(method, path) {
  return ROUTES.find((r) => r.method === method && r.path === path) || null;
}
