// Calendar fetch via the Google Calendar API directly.
// Uses Application Default Credentials (ADC) — same file the gcloud SDK creates:
//   ~/.config/gcloud/application_default_credentials.json
//
// To enable, the user runs ONCE:
//   gcloud auth application-default login \
//     --scopes=https://www.googleapis.com/auth/calendar.readonly,\
//              https://www.googleapis.com/auth/userinfo.email
//
// This is ~500x faster than going through claude -p and consumes zero LLM tokens.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { hasTokens, getTokens } from './oauth-store.js';
import { getActiveAccessToken } from './oauth-flow.js';

const ADC_PATH = join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');

const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// gcloud's default OAuth client_id requires `cloud-platform` to be requested
// alongside any narrower scope (since 2024+); otherwise login errors with
// "cloud-platform scope is required but not requested".
// For a permanent setup users should create their own OAuth client (see README).
const REAUTH_HINT =
  'gcloud auth application-default login ' +
  '--scopes=https://www.googleapis.com/auth/cloud-platform,' +
  'https://www.googleapis.com/auth/calendar.readonly,' +
  'https://www.googleapis.com/auth/userinfo.email';

let _tokenCache = null; // { accessToken, expiresAt }

function loadCreds() {
  if (!existsSync(ADC_PATH)) return null;
  try {
    const raw = readFileSync(ADC_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (json.type !== 'authorized_user') return null;
    if (!json.refresh_token || !json.client_id || !json.client_secret) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Quota project — required ONLY when using gcloud's DEFAULT OAuth client_id,
 * because that client is generic so Google can't infer a billing project.
 * When using a custom OAuth client (Camino limpio), the client_id itself
 * is bound to a specific GCP project and Google bills against it automatically,
 * so the `x-goog-user-project` header (and quota_project_id) is not needed.
 *
 * Read from ADC file's `quota_project_id` field, populated by:
 *   gcloud auth application-default set-quota-project <PROJECT_ID>
 *
 * Returns null if not set.
 */
function loadQuotaProject() {
  const creds = loadCreds();
  return creds?.quota_project_id || null;
}

// gcloud's well-known default OAuth client_id. Used by `gcloud auth application-default
// login` when no `--client-id-file` is passed. Anything else = a custom client.
const GCLOUD_DEFAULT_CLIENT_ID = '32555940559.apps.googleusercontent.com';

function isUsingDefaultGcloudClient() {
  const creds = loadCreds();
  return creds?.client_id === GCLOUD_DEFAULT_CLIENT_ID;
}

const SET_QUOTA_HINT =
  'gcloud auth application-default set-quota-project <YOUR_GCP_PROJECT_ID>\n' +
  '(list available projects with: gcloud projects list)';

/** Returns true if we have ANY auth source (in-app OAuth tokens OR gcloud ADC). */
export function isConfigured() {
  return hasTokens() || loadCreds() !== null;
}

/** Which auth source is active? "oauth" (in-app) > "adc" (gcloud) > null. */
export function activeAuthSource() {
  if (hasTokens()) return 'oauth';
  if (loadCreds() !== null) return 'adc';
  return null;
}

export function adcPath() {
  return ADC_PATH;
}

async function getAccessToken({ forceRefresh = false } = {}) {
  // PRIORITY 1 — in-app OAuth tokens (Connect with Google flow)
  if (hasTokens()) {
    const t = await getActiveAccessToken();
    _tokenCache = { accessToken: t, expiresAt: getTokens()?.expires_at || 0, scope: getTokens()?.scope || '' };
    return t;
  }

  // PRIORITY 2 — gcloud ADC fallback (legacy)
  if (!forceRefresh && _tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.accessToken;
  }
  const creds = loadCreds();
  if (!creds) {
    throw new Error('No Google credentials. Connect via the app (Settings → Connect with Google) or run: ' + REAUTH_HINT);
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const j = await r.json();
  _tokenCache = {
    accessToken: j.access_token,
    expiresAt: Date.now() + (j.expires_in * 1000),
    scope: j.scope || '',
  };
  return j.access_token;
}

/**
 * Drop the in-memory access-token cache. Call this whenever the user re-runs
 * `gcloud auth application-default login` so the next request re-derives a token
 * from the fresh refresh_token in the file.
 */
export function clearTokenCache() {
  _tokenCache = null;
}

/**
 * Return the granted scopes for the current access token (per Google's tokeninfo).
 * Useful for debugging "I ran the command but Calendar scope still missing".
 */
async function inspectGrantedScopes(accessToken) {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.scope || '';
  } catch {
    return null;
  }
}

/**
 * Build auth headers. The `x-goog-user-project` header is added only when:
 *   - using gcloud's default client_id (where Google can't infer a project), AND
 *   - we have a quota_project_id in the ADC file.
 * With a custom OAuth client, Google bills against the client's project
 * automatically and the header is unnecessary (and would be redundant).
 */
function authHeaders(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const qp = loadQuotaProject();
  if (qp) {
    headers['x-goog-user-project'] = qp;
  }
  return { headers, quotaProject: qp, usingDefaultGcloudClient: isUsingDefaultGcloudClient() };
}

/**
 * Verify connectivity AND that calendar scope is granted by making a tiny call.
 * Always forces a fresh access-token (in case the credentials file was just re-issued).
 * Returns { ok: true, calendarCount, grantedScopes, quotaProject } or { ok: false, error, hint, grantedScopes? }.
 */
export async function testConnection() {
  if (!isConfigured()) {
    return {
      ok: false,
      error: 'ADC credentials not found',
      hint: `Run: ${REAUTH_HINT}`,
    };
  }
  try {
    const token = await getAccessToken({ forceRefresh: true });
    const grantedScopes = await inspectGrantedScopes(token);
    const hasCalendarScope = (grantedScopes || '').includes(REQUIRED_SCOPE);
    const { headers, quotaProject } = authHeaders(token);

    const r = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      { headers }
    );

    if (!r.ok) {
      const text = await r.text();
      const detail = text.slice(0, 400);
      if (r.status === 401 || r.status === 403) {
        let error;
        let hint;
        if (!hasCalendarScope) {
          error = `403: token does NOT include calendar.readonly scope`;
          hint = `Re-run the gcloud command — the previous login did not grant calendar scope. Granted scopes: ${grantedScopes || '(unknown)'}`;
        } else if (detail.includes('quota project') || detail.includes('quota_project') || detail.includes('quota-project')) {
          error = `403: quota project not configured`;
          hint = `Google needs to know which GCP project to charge API quota against (Calendar API is free, this is just bookkeeping).\n\nFix by running:\n  ${SET_QUOTA_HINT}\n\nThen come back and click Test connection again.`;
        } else if (detail.includes('domain') || detail.toLowerCase().includes('admin') || detail.toLowerCase().includes('policy')) {
          error = `${r.status}: blocked by Google Workspace admin policy`;
          hint = `Your Salesforce Workspace admin has restricted third-party app access to Calendar. Either ask IT to allow this OAuth client, or use the "Camino limpio" (your own OAuth client). Google said: ${detail}`;
        } else {
          error = `${r.status}: Google API rejected the request`;
          hint = `Google said: ${detail}\nGranted scopes were: ${grantedScopes || '(unknown)'}\nQuota project in use: ${quotaProject || '(none)'}\nTry: ${REAUTH_HINT}`;
        }
        return { ok: false, error, hint, grantedScopes, quotaProject };
      }
      return { ok: false, error: `${r.status}: ${detail}`, grantedScopes, quotaProject };
    }
    const data = await r.json();
    const items = data.items || [];
    const visibleItems = items.filter((c) => c.selected !== false);
    return {
      ok: true,
      calendarCount: visibleItems.length,
      calendarTotal: items.length,
      calendarNames: visibleItems.slice(0, 10).map((c) => c.summary),
      grantedScopes,
      quotaProject,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch all events from all visible (non-hidden, selected) calendars in the user's
 * Google account, normalized to the same shape that calendar-claude.js produces.
 */
/**
 * Return the user's full calendarList for picking in the UI.
 * Each entry: { id, summary, primary, accessRole, backgroundColor, selected }
 */
export async function listCalendars() {
  const token = await getAccessToken();
  const { headers } = authHeaders(token);
  const r = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=false',
    { headers }
  );
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`calendarList failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  return (data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    description: c.description || '',
    primary: !!c.primary,
    accessRole: c.accessRole,
    backgroundColor: c.backgroundColor,
    selected: c.selected !== false, // visible in user's UI
  }));
}

export async function fetchEvents(fromIso, toIso, userEmail, opts = {}) {
  const token = await getAccessToken();
  const { headers, quotaProject, usingDefaultGcloudClient } = authHeaders(token);

  // Only the gcloud default client requires an explicit quota project. Custom
  // clients carry their project via client_id; Google figures it out.
  if (usingDefaultGcloudClient && !quotaProject) {
    throw new Error(
      `Quota project not configured (required when using gcloud's default OAuth client). Run:\n  ${SET_QUOTA_HINT}\n\nAlternatively, use a custom OAuth client (Camino limpio).`
    );
  }

  // 1. List calendars
  const calRes = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?showHidden=false&maxResults=250',
    { headers }
  );
  if (!calRes.ok) {
    const text = await calRes.text();
    throw new Error(`calendarList failed (${calRes.status}): ${text.slice(0, 300)}`);
  }
  const calsResp = await calRes.json();
  let visibleCals = (calsResp.items || []).filter((c) => c.selected !== false);

  // Apply user-configured allowlist if provided. Empty = all.
  if (Array.isArray(opts.enabledCalendarIds) && opts.enabledCalendarIds.length > 0) {
    const allow = new Set(opts.enabledCalendarIds);
    visibleCals = visibleCals.filter((c) => allow.has(c.id));
  }

  // 2. Convert range to RFC3339 with timezone (Google requires)
  const timeMin = new Date(fromIso).toISOString();
  const timeMax = new Date(toIso).toISOString();

  // 3. Fetch events from each calendar in parallel
  const fetchOne = async (cal) => {
    const out = [];
    let pageToken;
    let page = 0;
    do {
      page++;
      if (page > 10) break;

      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`
      );
      url.searchParams.set('timeMin', timeMin);
      url.searchParams.set('timeMax', timeMax);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('maxResults', '250');
      url.searchParams.set('showDeleted', 'false');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const r = await fetch(url, { headers });
      if (!r.ok) {
        return out;
      }
      const data = await r.json();
      for (const ev of data.items || []) {
        // Skip cancelled instances
        if (ev.status === 'cancelled') continue;
        out.push(normalizeEvent(ev, userEmail, cal));
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  };

  const perCal = await Promise.all(visibleCals.map((c) => fetchOne(c).catch(() => [])));
  let all = perCal.flat();

  // De-dupe across calendars (same event can appear in multiple calendars when shared)
  const seen = new Map();
  for (const ev of all) {
    if (!seen.has(ev.id)) seen.set(ev.id, ev);
  }
  all = [...seen.values()];

  // Sort by start
  all.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return all;
}

/**
 * Normalize a Google Calendar API event object to the shape we use elsewhere.
 */
function normalizeEvent(ev, userEmail, cal) {
  const start = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00` : '');
  const end = ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T00:00:00` : '');
  // Google distinguishes all-day events by giving `start.date` instead of `start.dateTime`.
  // We propagate this so the matcher can skip them from classification + dedup.
  const isAllDay = !ev.start?.dateTime && !!ev.start?.date;
  let durationHours = 0;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    durationHours = Math.round((ms / 3600000) * 100) / 100;
  }

  const attendees = (ev.attendees || []).map((a) => ({
    email: a.email || '',
    displayName: a.displayName || '',
    responseStatus: a.responseStatus || '',
    self: !!a.self,
  }));

  // Self-attendance: prefer attendee.self, fall back to email match
  const lowerEmail = (userEmail || '').toLowerCase();
  const selfAttendee = attendees.find((a) => a.self || a.email.toLowerCase() === lowerEmail);
  const isOrganizer = !!ev.organizer?.self || (ev.organizer?.email || '').toLowerCase() === lowerEmail;

  let rsvpStatus = 'unknown';
  if (isOrganizer) rsvpStatus = 'organizer';
  else if (selfAttendee) rsvpStatus = selfAttendee.responseStatus || 'unknown';

  return {
    id: ev.id,
    summary: ev.summary || '(no title)',
    start,
    end,
    durationHours,
    isAllDay,
    description: ev.description || '',
    location: ev.location || '',
    organizer: ev.organizer?.email || '',
    isOrganizer,
    rsvpStatus,
    colorId: ev.colorId || '',
    attendees,
    htmlLink: ev.htmlLink || '',
    _calendarId: cal.id,
    _calendarName: cal.summary,
  };
}
