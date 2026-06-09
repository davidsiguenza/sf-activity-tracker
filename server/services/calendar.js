// Calendar fetch router — picks the fastest available backend.
//
// Backend priority:
//   1. Google Calendar API direct (calendar-google-api.js) — ~500ms, zero LLM tokens.
//      Requires user to run once:
//        gcloud auth application-default login \
//          --scopes=https://www.googleapis.com/auth/calendar.readonly,\
//                   https://www.googleapis.com/auth/userinfo.email
//   2. Claude -p + Google MCP (calendar-claude.js) — slow, but zero local setup.
//      Used as automatic fallback if backend 1 is not configured OR errors out.
//
// Caching: results are kept in-memory for 30 min keyed on [email|from|to].
// Pass forceRefresh=true to bypass.

import * as googleApi from './calendar-google-api.js';
import * as claudeFetcher from './calendar-claude.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // key → { events, fetchedAt, backend }

export function clearCalendarCache() {
  cache.clear();
  googleApi.clearTokenCache();
}

function cacheKey(fromIso, toIso, email, enabledCalendarIds) {
  const calsKey = Array.isArray(enabledCalendarIds) && enabledCalendarIds.length > 0
    ? [...enabledCalendarIds].sort().join(',')
    : '*';
  return `${email}|${fromIso}|${toIso}|${calsKey}`;
}

/**
 * Fetch calendar events for a date range, picking the best backend automatically.
 * @returns {Promise<{events: Array, fromCache: boolean, fetchedAt: number, backend: string, fellBackTo?: string, fallbackReason?: string}>}
 */
export async function fetchEvents(fromIso, toIso, userEmail, opts = {}) {
  const key = cacheKey(fromIso, toIso, userEmail, opts.enabledCalendarIds);
  const cached = cache.get(key);
  if (!opts.forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      events: cached.events,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
      backend: cached.backend,
    };
  }

  // Try Google API first if configured
  if (googleApi.isConfigured()) {
    try {
      const events = await googleApi.fetchEvents(fromIso, toIso, userEmail, {
        enabledCalendarIds: opts.enabledCalendarIds,
      });
      const fetchedAt = Date.now();
      cache.set(key, { events, fetchedAt, backend: 'google-api' });
      return { events, fromCache: false, fetchedAt, backend: 'google-api' };
    } catch (e) {
      // Fall through to claude — surface the reason so the UI can show it
      console.warn(`[calendar] Google API fetch failed, falling back to claude: ${e.message}`);
      const events = await claudeFetcher.fetchEvents(fromIso, toIso, userEmail);
      const fetchedAt = Date.now();
      cache.set(key, { events, fetchedAt, backend: 'claude-fallback' });
      return {
        events,
        fromCache: false,
        fetchedAt,
        backend: 'claude-fallback',
        fellBackTo: 'claude',
        fallbackReason: e.message,
      };
    }
  }

  // No Google API configured → use claude directly
  const events = await claudeFetcher.fetchEvents(fromIso, toIso, userEmail);
  const fetchedAt = Date.now();
  cache.set(key, { events, fetchedAt, backend: 'claude' });
  return { events, fromCache: false, fetchedAt, backend: 'claude' };
}

/**
 * Test the Google Calendar API connection. Used by the UI to surface status.
 */
export async function testGoogleApi() {
  return googleApi.testConnection();
}

export async function listGoogleCalendars() {
  return googleApi.listCalendars();
}

export function googleApiConfigured() {
  return googleApi.isConfigured();
}

export function googleApiAdcPath() {
  return googleApi.adcPath();
}
