import { query } from '../services/salesforce.js';
import { save } from '../lib/config-store.js';

/**
 * POST /api/setup/resolve-user
 * Body: { email }
 * Returns the user record from org62 by email.
 */
export async function resolveUser({ body, sendJson, res }) {
  const email = (body?.email || '').trim();
  if (!email) return sendJson(res, 400, { error: 'email required' });

  // SOQL escape: only allow letters/digits/dots/underscores/dashes/at/+
  if (!/^[\w.+\-@]+$/.test(email)) {
    return sendJson(res, 400, { error: 'invalid email format' });
  }

  const records = await query(
    `SELECT Id, Name, Email, ManagerId, Manager.Name, TimeZoneSidKey
     FROM User WHERE Email = '${email}' AND IsActive = TRUE LIMIT 1`
  );
  if (records.length === 0) {
    return sendJson(res, 404, { error: `No active user found with email ${email}` });
  }
  const u = records[0];
  return sendJson(res, 200, {
    seUserId: u.Id,
    seName: u.Name,
    seEmail: u.Email,
    managerId: u.ManagerId,
    managerName: u.Manager?.Name || null,
    timeZone: u.TimeZoneSidKey,
  });
}

/**
 * POST /api/setup/save
 * Saves the initial config from the wizard.
 */
export async function saveSetup({ body, sendJson, res }) {
  if (!body || !body.seUserId || !body.seEmail) {
    return sendJson(res, 400, { error: 'seUserId and seEmail required' });
  }
  const merged = save(body);
  return sendJson(res, 200, { ok: true, config: merged });
}

/**
 * POST /api/setup/lookup
 * Body: { search }
 * Searches Opportunity, Account, Strategic Initiative, Deal Support Request by name.
 */
export async function lookupRecord({ body, sendJson, res }) {
  const search = (body?.search || '').trim();
  if (!search || search.length < 3) {
    return sendJson(res, 400, { error: 'search must be at least 3 chars' });
  }
  // SOQL LIKE escape — strip single quotes (basic)
  const safeSearch = search.replace(/'/g, "\\'");
  const like = `%${safeSearch}%`;

  const [opps, accts, sis] = await Promise.all([
    query(`SELECT Id, Name, IsClosed, StageName, Account.Name FROM Opportunity WHERE Name LIKE '${like}' AND IsClosed = FALSE LIMIT 5`).catch(() => []),
    query(`SELECT Id, Name, Type FROM Account WHERE Name LIKE '${like}' LIMIT 5`).catch(() => []),
    query(`SELECT Id, Name FROM Strategic_Initiative__c WHERE Name LIKE '${like}' LIMIT 5`).catch(() => []),
  ]);

  return sendJson(res, 200, {
    opportunities: opps.map((o) => ({
      id: o.Id,
      name: o.Name,
      type: 'Opportunity',
      detail: `${o.Account?.Name || '?'} · ${o.StageName}`,
    })),
    accounts: accts.map((a) => ({
      id: a.Id,
      name: a.Name,
      type: 'Account',
      detail: a.Type || '',
    })),
    strategicInitiatives: sis.map((s) => ({
      id: s.Id,
      name: s.Name,
      type: 'Strategic_Initiative__c',
      detail: '',
    })),
  });
}
