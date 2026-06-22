import { healthCheck as sfHealth, healthCheckAll } from '../services/salesforce.js';
import { getBackendConfig } from '../services/backend-store.js';
import { exists as configExists } from '../lib/config-store.js';

export async function get({ sendJson, res, url }) {
  const wantBoth = url?.searchParams?.get('verbose') === '1';
  const cfg = getBackendConfig();

  if (wantBoth) {
    const both = await healthCheckAll();
    sendJson(res, 200, {
      ok: both.cli?.ok || both.mcp?.ok,
      backends: both,
      backendConfig: cfg,
      configured: configExists(),
    });
    return;
  }

  // Default: use the active/preferred backend (legacy callers).
  const sf = await sfHealth();
  sendJson(res, 200, {
    ok: sf.ok,
    salesforce: sf,
    backendMode: cfg.mode,
    backendActive: cfg.active,
    configured: configExists(),
  });
}
