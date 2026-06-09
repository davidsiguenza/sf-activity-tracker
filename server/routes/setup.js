import { query } from '../services/salesforce.js';
import { save, addManualRelatedRecord } from '../lib/config-store.js';

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
 * POST /api/setup/resolve-id
 * Body: { idOrUrl }
 * Accepts a Salesforce URL or a bare 15/18-char Id and returns { id, name, type }.
 * Tries Opportunity → Account → Strategic_Initiative__c → Deal_Support_Request__c.
 */
export async function resolveId({ body, sendJson, res }) {
  const input = (body?.idOrUrl || '').trim();
  if (!input) return sendJson(res, 400, { error: 'idOrUrl required' });

  // Extract a 15- or 18-char Salesforce ID from the input. Works for plain IDs,
  // Lightning URLs, classic URLs, and most other Salesforce link shapes.
  const match = input.match(/\b([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})\b/);
  if (!match) {
    return sendJson(res, 400, { error: 'Could not find a Salesforce ID in input. Paste a record URL or a 15/18-char ID.' });
  }
  const id = match[1];

  // Validate it looks like a real SF id (mostly alphanumeric, no obvious garbage)
  if (!/^[a-zA-Z0-9]+$/.test(id)) {
    return sendJson(res, 400, { error: 'Invalid ID format' });
  }

  // Try the most common types in order. Each query returns 0 or 1 records.
  // We use Id-based queries which are O(1) on Salesforce.
  const candidates = [
    { type: 'Opportunity',                soql: `SELECT Id, Name, IsClosed FROM Opportunity WHERE Id = '${id}' LIMIT 1` },
    { type: 'Account',                    soql: `SELECT Id, Name FROM Account WHERE Id = '${id}' LIMIT 1` },
    { type: 'Strategic_Initiative__c',    soql: `SELECT Id, Name FROM Strategic_Initiative__c WHERE Id = '${id}' LIMIT 1` },
    { type: 'Deal_Support_Request__c',    soql: `SELECT Id, Name FROM Deal_Support_Request__c WHERE Id = '${id}' LIMIT 1` },
  ];

  for (const c of candidates) {
    try {
      const records = await query(c.soql);
      if (records.length > 0) {
        const r = records[0];
        // Persist so this record appears in EVERY draft-plan dropdown going forward
        try { addManualRelatedRecord({ id: r.Id, name: r.Name, type: c.type }); } catch {}
        return sendJson(res, 200, {
          id: r.Id,
          name: r.Name,
          type: c.type,
          isClosed: r.IsClosed ?? null,
        });
      }
    } catch {
      // SObject might not be queryable for this user — skip silently
    }
  }

  return sendJson(res, 404, { error: `No record found in org62 with ID ${id}. Make sure it's an Opportunity, Account, Strategic Initiative, or DSR.` });
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
