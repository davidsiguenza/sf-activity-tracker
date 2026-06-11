// Persistent config in ~/.config/sf-activity-tracker/config.json

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG_DIR = join(homedir(), '.config', 'sf-activity-tracker');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  seUserId: null,
  seName: null,
  seEmail: null,
  managerId: null,
  timeZone: 'Europe/Madrid',
  seOpportunityRole: 'Core SE',
  excludedTitles: ['Home', 'Lunch', 'OOO', 'Out of Office', 'Gym', 'Wellness'],
  internalEmailDomains: ['salesforce.com', 'tableau.com', 'slack.com', 'mulesoft.com'],
  catchAll: null, // { id, name, type }
  aliasTable: [],
  taxonomyCorrections: [],
  enabledCalendarIds: [], // empty = all visible. Otherwise, only fetch from these calendar IDs.
  manualRelatedRecords: [], // {id, name, type, addedAt} — records the user pasted manually; persisted across sessions and shown in every dropdown.
  dcFilters: {
    // Days back from today to include closed Opportunities (ones closed before
    // this cutoff are dropped from the picker AND from the classifier prompt).
    closedLookbackDays: 30,
    // Inclusive split-percentage band on the SE's Deal_Contribution__c record.
    // Default 0..100 = no filter. Set min=50 for "only primary contributor".
    minSplitPercentage: 0,
    maxSplitPercentage: 100,
    // Blacklist of Opportunity StageName. Empty array = no constraint.
    excludeOppStages: [],
    // Whitelist of Opportunity_Role__c on the DC (Core SE, Pursuit, Specialist…).
    // Empty array = all roles.
    includeRoles: [],
    // Whitelist of Engagement_Status__c on the DC (Planning, In Process, Completed…).
    // Empty array = all statuses.
    includeEngagementStatuses: [],
  },
  createdAt: null,
  updatedAt: null,
};

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function configPath() {
  return CONFIG_PATH;
}

export function exists() {
  return existsSync(CONFIG_PATH);
}

export function load() {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    throw new Error(`Failed to read config at ${CONFIG_PATH}: ${e.message}`);
  }
}

export function save(partial) {
  ensureDir();
  const current = load() || { ...DEFAULT_CONFIG, createdAt: new Date().toISOString() };
  const merged = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * Add an alias if it doesn't already exist.
 * @param {string} alias
 * @param {Array<{id: string, name: string, type: string}>} matches
 */
export function addAlias(alias, matches) {
  const cfg = load() || DEFAULT_CONFIG;
  const aliasTable = cfg.aliasTable || [];
  const existingIdx = aliasTable.findIndex((a) => a.alias.toLowerCase() === alias.toLowerCase());
  if (existingIdx >= 0) {
    aliasTable[existingIdx] = { alias, matches };
  } else {
    aliasTable.push({ alias, matches });
  }
  return save({ aliasTable });
}

/**
 * Add a manually-resolved record (Opportunity / Account / SI / DSR) so it
 * appears in all Related-To dropdowns from now on. Idempotent on `id`.
 * @param {{id, name, type}} record
 */
export function addManualRelatedRecord(record) {
  const cfg = load() || DEFAULT_CONFIG;
  const list = cfg.manualRelatedRecords || [];
  if (list.some((r) => r.id === record.id)) return cfg; // already there
  list.push({ id: record.id, name: record.name, type: record.type, addedAt: new Date().toISOString() });
  return save({ manualRelatedRecords: list });
}

export function removeManualRelatedRecord(id) {
  const cfg = load() || DEFAULT_CONFIG;
  const list = (cfg.manualRelatedRecords || []).filter((r) => r.id !== id);
  return save({ manualRelatedRecords: list });
}

/**
 * Add a taxonomy correction (keyword → SE Task Type).
 */
export function addTaxonomyCorrection(keyword, seTaskType) {
  const cfg = load() || DEFAULT_CONFIG;
  const taxonomyCorrections = cfg.taxonomyCorrections || [];
  const existingIdx = taxonomyCorrections.findIndex(
    (c) => c.keyword.toLowerCase() === keyword.toLowerCase()
  );
  if (existingIdx >= 0) {
    taxonomyCorrections[existingIdx] = { keyword, seTaskType };
  } else {
    taxonomyCorrections.push({ keyword, seTaskType });
  }
  return save({ taxonomyCorrections });
}

export function defaults() {
  return { ...DEFAULT_CONFIG };
}
