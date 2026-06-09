import { healthCheck as sfHealth } from '../services/salesforce.js';
import { exists as configExists } from '../lib/config-store.js';

export async function get({ sendJson, res }) {
  const sf = await sfHealth();
  sendJson(res, 200, {
    ok: sf.ok,
    salesforce: sf,
    configured: configExists(),
  });
}
