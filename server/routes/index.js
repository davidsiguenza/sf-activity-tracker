// Route registry — minimal pattern-matching for our small endpoint set.

import * as configRoute from './config.js';
import * as setupRoute from './setup.js';
import * as analyzeRoute from './analyze.js';
import * as createRoute from './create.js';
import * as healthRoute from './health.js';
import * as calendarRoute from './calendar.js';
import * as oauthRoute from './oauth.js';
import * as cacheRoute from './cache.js';
import * as overridesRoute from './overrides.js';
import * as sfRoute from './sf.js';
import * as sfMcpRoute from './sf-mcp.js';

const ROUTES = [
  { method: 'GET', path: '/api/health', handler: healthRoute.get },
  { method: 'GET', path: '/api/config', handler: configRoute.get },
  { method: 'PUT', path: '/api/config', handler: configRoute.put },
  { method: 'POST', path: '/api/config/alias', handler: configRoute.addAliasHandler },
  { method: 'POST', path: '/api/config/correction', handler: configRoute.addCorrectionHandler },
  { method: 'GET',  path: '/api/setup/whoami', handler: setupRoute.whoami },
  { method: 'POST', path: '/api/setup/resolve-user', handler: setupRoute.resolveUser },
  { method: 'POST', path: '/api/setup/save', handler: setupRoute.saveSetup },
  { method: 'POST', path: '/api/setup/lookup', handler: setupRoute.lookupRecord },
  { method: 'POST', path: '/api/setup/resolve-id', handler: setupRoute.resolveId },
  { method: 'GET',  path: '/api/dc-filters/options', handler: setupRoute.dcFilterOptions },
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
  // User overrides on draft plan rows
  { method: 'POST', path: '/api/override',       handler: overridesRoute.set },
  { method: 'POST', path: '/api/override/clear', handler: overridesRoute.clear },
  { method: 'GET',  path: '/api/override/stats', handler: overridesRoute.stats },
  // Salesforce instance metadata (for "Open in Salesforce" record links)
  { method: 'GET',  path: '/api/sf/instance-url', handler: sfRoute.instanceUrl },
  // Salesforce MCP backend — Fase 1 (config + OAuth + tools/list test)
  { method: 'GET',  path: '/api/sf-mcp/config',           handler: sfMcpRoute.getConfigHandler },
  { method: 'PUT',  path: '/api/sf-mcp/config',           handler: sfMcpRoute.putConfigHandler },
  { method: 'GET',  path: '/api/sf-mcp/status',           handler: sfMcpRoute.statusHandler },
  { method: 'POST', path: '/api/sf-mcp/oauth/start',      handler: sfMcpRoute.oauthStartHandler },
  { method: 'POST', path: '/api/sf-mcp/oauth/disconnect', handler: sfMcpRoute.oauthDisconnectHandler },
  { method: 'POST', path: '/api/sf-mcp/test',             handler: sfMcpRoute.testHandler },
];

export function match(method, path) {
  return ROUTES.find((r) => r.method === method && r.path === path) || null;
}
