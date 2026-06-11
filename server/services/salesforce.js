// Wrapper around the `sf` CLI for org62.
// All calls return parsed JSON. Stderr noise (cert warnings) is silenced.

import { spawn } from 'node:child_process';

const TARGET_ORG = 'org62';

/**
 * Run a `sf` command and return parsed JSON.
 * @param {string[]} args - args after `sf`
 * @returns {Promise<any>} parsed `result` from `sf --json` output
 */
function runSf(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sf', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        return reject(new Error(`sf output not JSON (exit ${code}): ${stdout.slice(0, 500)} || stderr: ${stderr.slice(0, 300)}`));
      }
      if (parsed?.status !== 0) {
        return reject(new Error(`sf error: ${parsed?.message || JSON.stringify(parsed).slice(0, 500)}`));
      }
      resolve(parsed.result);
    });
  });
}

/**
 * Run a SOQL query against org62.
 * @param {string} soql
 * @returns {Promise<Array<Object>>} array of records
 */
export async function query(soql) {
  const result = await runSf([
    'data',
    'query',
    '--target-org',
    TARGET_ORG,
    '--query',
    soql,
    '--json',
  ]);
  return result?.records || [];
}

/**
 * Run a SOQL query against the tooling API (used for FieldDefinition, EntityDefinition, etc.).
 */
export async function queryTooling(soql) {
  const result = await runSf([
    'data',
    'query',
    '--target-org',
    TARGET_ORG,
    '--query',
    soql,
    '--use-tooling-api',
    '--json',
  ]);
  return result?.records || [];
}

/**
 * Create a single record via `sf data create record`. Returns the new record Id.
 * Modern sf CLI v2 uses space-separated subcommands, NOT hyphenated.
 * --values format: single string of `field=value` pairs separated by spaces.
 *                  Values with spaces must be wrapped in single quotes.
 *                  Internal apostrophes are normalized to right-single-quote (’) to avoid escaping pain.
 * @param {string} sobject
 * @param {Object} fields - field name/value pairs
 * @returns {Promise<string>} record Id
 */
export async function createRecord(sobject, fields) {
  const valuesStr = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');

  const result = await runSf([
    'data',
    'create',
    'record',
    '--target-org',
    TARGET_ORG,
    '--sobject',
    sobject,
    '--values',
    valuesStr,
    '--json',
  ]);
  return result?.id;
}

/**
 * Delete a single record via `sf data delete record`.
 */
export async function deleteRecord(sobject, recordId) {
  const result = await runSf([
    'data',
    'delete',
    'record',
    '--target-org',
    TARGET_ORG,
    '--sobject',
    sobject,
    '--record-id',
    recordId,
    '--json',
  ]);
  return result?.id;
}

/**
 * Format a value for the `--values "field=value"` syntax accepted by `sf data create record`.
 * - Empty values become empty (skipped by caller).
 * - Strings containing spaces or special chars are wrapped in single quotes.
 * - Internal single quotes are normalized to right-single-quote (’) — Salesforce stores them fine.
 * - Booleans / numbers / ISO datetimes pass through unquoted.
 */
function formatValue(v) {
  let s = String(v);
  // normalize apostrophes so we don't have to deal with escaping inside single-quoted values
  s = s.replace(/'/g, '’');
  // ISO datetime, IDs, numbers, booleans → unquoted
  if (/^[\w.+\-:]+$/.test(s)) return s;
  // anything else → single-quote wrap
  return `'${s}'`;
}

/**
 * Resolve and cache the org's instance URL via `sf org display`.
 * Used by the frontend to build "Open in Salesforce" record links.
 * @returns {Promise<string>} e.g. https://gus.lightning.force.com
 */
let _instanceUrlCache = null;
export async function getInstanceUrl() {
  if (_instanceUrlCache) return _instanceUrlCache;
  const result = await runSf(['org', 'display', '--target-org', TARGET_ORG, '--json']);
  const url = result?.instanceUrl;
  if (!url) throw new Error('sf org display returned no instanceUrl');
  _instanceUrlCache = url;
  return url;
}

/**
 * Quick health check: run a trivial query.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function healthCheck() {
  try {
    await query('SELECT Id FROM Organization LIMIT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
