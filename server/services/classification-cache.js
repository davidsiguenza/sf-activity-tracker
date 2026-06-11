// Persistent cache of classifier output, keyed by event ID + content hash.
//
// Lives at ~/.config/sf-activity-tracker/classifications-cache.json
// Schema:
//   {
//     version: 1,
//     entries: {
//       "<eventId>": {
//         hash: "<sha1 of summary|start|end>",
//         classification: { eventId, status, relatedTo, seTaskType, isCF, isCR, ... },
//         classifiedAt: 1736000000000
//       }
//     }
//   }
//
// Cache hit logic:
//   - Same event ID + same hash → reuse classification (fast).
//   - Same event ID + different hash → invalidate that entry, re-classify.
//   - New event ID → re-classify.
//
// Invalidation:
//   - clearAll() called when user adds an alias / correction (config.js routes).
//   - resetEntry(eventId) called when user manually edits classification (future).
//   - prune() removes entries older than 90 days to bound file size.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CACHE_DIR = join(homedir(), '.config', 'sf-activity-tracker');
const CACHE_PATH = join(CACHE_DIR, 'classifications-cache.json');
const CURRENT_VERSION = 1;
const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function emptyStore() {
  return { version: CURRENT_VERSION, entries: {}, recurring: {} };
}

function load() {
  if (!existsSync(CACHE_PATH)) return emptyStore();
  try {
    const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (data.version !== CURRENT_VERSION) return emptyStore(); // schema bump → discard
    if (!data.entries || typeof data.entries !== 'object') return emptyStore();
    // recurring map was added later — backfill so old caches keep working
    if (!data.recurring || typeof data.recurring !== 'object') data.recurring = {};
    return data;
  } catch {
    return emptyStore();
  }
}

function persist(store) {
  ensureDir();
  writeFileSync(CACHE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Stable hash that captures the fields that would change a classification.
 * Subject change / time change → re-classify. Description-only edits → cache hit.
 */
export function eventHash(event) {
  const parts = [
    (event.summary || '').trim().toLowerCase(),
    event.start || '',
    event.end || '',
    String((event.attendees || []).length),
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Look up cached classification.
 * @param {string} eventId
 * @param {string} hash
 * @returns {Object|null} cached classification or null
 */
export function get(eventId, hash) {
  const store = load();
  const entry = store.entries[eventId];
  if (!entry) return null;
  if (entry.hash !== hash) return null;
  return entry.classification;
}

/**
 * Save a classification. Caller is responsible for batching: prefer setMany.
 */
export function set(eventId, hash, classification) {
  const store = load();
  store.entries[eventId] = {
    hash,
    classification,
    classifiedAt: Date.now(),
  };
  persist(store);
}

/**
 * Save multiple classifications atomically (single file write).
 * @param {Array<{eventId, hash, classification, recurringEventId?}>} items
 */
export function setMany(items) {
  if (!items || !items.length) return;
  const store = load();
  const now = Date.now();
  for (const it of items) {
    if (!it.eventId || !it.hash || !it.classification) continue;
    store.entries[it.eventId] = {
      hash: it.hash,
      classification: it.classification,
      classifiedAt: now,
    };
    // Recurring fallback: store one entry per recurring series so future
    // instances of "weekly Iberia sync" etc don't go to claude again
    if (it.recurringEventId) {
      store.recurring[it.recurringEventId] = {
        classification: it.classification,
        classifiedAt: now,
      };
    }
  }
  persist(store);
}

/**
 * Lookup a classification by recurringEventId — used as a fallback when the
 * exact (eventId + hash) cache misses. Any prior instance of this recurring
 * series is re-used.
 */
export function getRecurring(recurringEventId) {
  if (!recurringEventId) return null;
  const store = load();
  const entry = store.recurring[recurringEventId];
  return entry?.classification || null;
}

/**
 * Drop entries older than 90 days. Called occasionally.
 * @returns {number} count of pruned entries
 */
export function prune() {
  const store = load();
  const cutoff = Date.now() - PRUNE_AGE_MS;
  let pruned = 0;
  for (const [id, entry] of Object.entries(store.entries)) {
    if ((entry.classifiedAt || 0) < cutoff) {
      delete store.entries[id];
      pruned++;
    }
  }
  for (const [id, entry] of Object.entries(store.recurring || {})) {
    if ((entry.classifiedAt || 0) < cutoff) {
      delete store.recurring[id];
      pruned++;
    }
  }
  if (pruned > 0) persist(store);
  return pruned;
}

export function clearAll() {
  if (existsSync(CACHE_PATH)) unlinkSync(CACHE_PATH);
}

export function stats() {
  const store = load();
  const entries = Object.values(store.entries);
  return {
    count: entries.length,
    oldestAt: entries.length ? Math.min(...entries.map((e) => e.classifiedAt || 0)) : null,
    newestAt: entries.length ? Math.max(...entries.map((e) => e.classifiedAt || 0)) : null,
    path: CACHE_PATH,
  };
}
