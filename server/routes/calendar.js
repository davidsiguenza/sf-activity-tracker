// Routes related to the calendar backend (Google API vs Claude fallback).

import {
  testGoogleApi,
  googleApiConfigured,
  googleApiAdcPath,
  clearCalendarCache,
  listGoogleCalendars,
} from '../services/calendar.js';

/**
 * GET /api/calendar/status
 * Returns whether Google API is configured + ADC path. Cheap check, no network call.
 *
 * IMPORTANT: gcloud's default client_id requires the `cloud-platform` scope to also
 * be requested (since 2024+) — otherwise it errors with "cloud-platform scope is
 * required but not requested". Calendar.readonly is also being phased out from the
 * default client; for a permanent setup, create your own OAuth client (see README).
 */
export async function status({ sendJson, res }) {
  return sendJson(res, 200, {
    googleApiConfigured: googleApiConfigured(),
    adcPath: googleApiAdcPath(),
    requiredScope: 'https://www.googleapis.com/auth/calendar.readonly',
    setupCommandQuick:
      'gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/userinfo.email',
    setupCommandPermanent:
      'gcloud auth application-default login --client-id-file=~/Downloads/client_secret_*.json --scopes=https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/userinfo.email',
  });
}

/**
 * POST /api/calendar/test
 * Performs a real Google API call to verify scope + connectivity.
 */
export async function test({ sendJson, res }) {
  const result = await testGoogleApi();
  return sendJson(res, 200, result);
}

/**
 * POST /api/calendar/clear-cache
 * Drop the in-memory calendar fetch cache (e.g. after re-auth or scope changes).
 */
export async function clearCache({ sendJson, res }) {
  clearCalendarCache();
  return sendJson(res, 200, { ok: true });
}

/**
 * GET /api/calendar/list
 * Return the user's Google calendars (Google API path only — for the picker UI).
 */
export async function list({ sendJson, res }) {
  if (!googleApiConfigured()) {
    return sendJson(res, 400, { error: 'Google API not configured. Connect it first.' });
  }
  try {
    const calendars = await listGoogleCalendars();
    return sendJson(res, 200, { calendars });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}
