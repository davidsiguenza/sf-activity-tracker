// Persistent store for user edits to the draft plan.
//
// Lives at ~/.config/sf-activity-tracker/event-overrides.json
// Schema:
//   {
//     version: 1,
//     overrides: {
//       "<eventId>": {
//         hash: "<event hash at time of edit>",
//         fields: { relatedTo?, seTaskType?, isCF?, isCR? },
//         savedAt: 1736000000000
//       }
//     }
//   }
//
// Lifecycle:
//   - Saved whenever the user edits a cell in the draft plan
//   - Applied on every analyze AFTER the classifications are assembled
//   - Cleared per-eventId when the event is successfully created in org62
//   - Cleared per-eventId when the event hash changes (subject/start/end edited
//     in Google Calendar) so we don't apply stale overrides

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const STORE_DIR = join(homedir(), '.config', 'sf-activity-tracker');
const STORE_PATH = join(STORE_DIR, 'event-overrides.json');
const CURRENT_VERSION = 1;

function ensureDir() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

function emptyStore() {
  return { version: CURRENT_VERSION, overrides: {} };
}

function load() {
  if (!existsSync(STORE_PATH)) return emptyStore();
  try {
    const data = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (data.version !== CURRENT_VERSION) return emptyStore();
    if (!data.overrides || typeof data.overrides !== 'object') return emptyStore();
    return data;
  } catch {
    return emptyStore();
  }
}

function persist(store) {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Get override for an event. Returns the saved fields ONLY if the hash matches —
 * if the event has been edited in Google since the override was saved, it's stale.
 * @param {string} eventId
 * @param {string} hash - current hash from classification-cache.eventHash(event)
 * @returns {Object|null}
 */
export function get(eventId, hash) {
  const store = load();
  const entry = store.overrides[eventId];
  if (!entry) return null;
  if (entry.hash !== hash) return null;
  return entry.fields || null;
}

/**
 * Save (or merge into) an override for an event. Partial: caller passes only
 * the fields they're updating; we merge with what was there.
 * @param {string} eventId
 * @param {string} hash
 * @param {Object} fields - any subset of {relatedTo, seTaskType, isCF, isCR}
 */
export function setOverride(eventId, hash, fields) {
  const store = load();
  const existing = store.overrides[eventId];
  // If the hash changed (event was edited in Google), drop the old override entirely
  const baseFields = existing && existing.hash === hash ? existing.fields : {};
  store.overrides[eventId] = {
    hash,
    fields: { ...baseFields, ...fields },
    savedAt: Date.now(),
  };
  persist(store);
}

/**
 * Drop the override for one event (e.g. after it was logged to org62).
 */
export function clearOverride(eventId) {
  const store = load();
  if (!store.overrides[eventId]) return;
  delete store.overrides[eventId];
  persist(store);
}

export function clearAll() {
  if (existsSync(STORE_PATH)) unlinkSync(STORE_PATH);
}

export function stats() {
  const store = load();
  const entries = Object.values(store.overrides);
  return {
    count: entries.length,
    path: STORE_PATH,
  };
}

/**
 * Bulk-apply: given a map of eventId → currentHash, return overrides keyed
 * by eventId for matching entries only. Useful for the matcher to overlay
 * after classification assembly.
 * @param {Map<string, string>} eventIdToHash
 * @returns {Map<string, Object>} eventId → fields
 */
export function getMany(eventIdToHash) {
  const store = load();
  const result = new Map();
  for (const [eventId, hash] of eventIdToHash) {
    const entry = store.overrides[eventId];
    if (entry && entry.hash === hash) {
      result.set(eventId, entry.fields);
    }
  }
  return result;
}
