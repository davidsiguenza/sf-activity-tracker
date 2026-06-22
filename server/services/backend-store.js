// Persistence for the org62 backend mode preference.
// Stored at ~/.config/sf-activity-tracker/backend-config.json (mode 0600).
//
// Mode:
//   'cli'  → always use the `sf` CLI
//   'mcp'  → always use the Platform MCP
//   'auto' → try the preferred backend; on connection failure, fall back to the other
//
// In 'auto' mode, `preferred` decides which one is tried first. Once a backend
// is confirmed working (health check), it's cached in `active` until the next
// explicit re-test.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';

const CONFIG_DIR = join(homedir(), '.config', 'sf-activity-tracker');
const CONFIG_PATH = join(CONFIG_DIR, 'backend-config.json');

const DEFAULT_CONFIG = {
  mode: 'auto',         // 'cli' | 'mcp' | 'auto'
  preferred: 'cli',     // which one to try first in auto mode
  active: null,         // last-known-working backend ('cli' | 'mcp' | null)
  lastChecked: null,    // ISO timestamp of last health check
};

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function getBackendConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setBackendConfig(partial) {
  ensureDir();
  const merged = { ...getBackendConfig(), ...partial };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  try { chmodSync(CONFIG_PATH, 0o600); } catch {}
  return merged;
}

export function setActive(backend) {
  return setBackendConfig({ active: backend, lastChecked: new Date().toISOString() });
}
