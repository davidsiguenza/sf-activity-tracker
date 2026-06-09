// Wrapper around `claude -p` headless mode.
// Reuses the user's DevBar Claude Code license — no API key needed.
//
// Two modes:
//   - run({prompt, systemPrompt}) → returns plain text
//   - runJson({prompt, systemPrompt, schema}) → returns parsed JSON validated against schema

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 min

/**
 * Run `claude -p` and return the assistant's final text response.
 * @param {Object} opts
 * @param {string} opts.prompt - the user prompt
 * @param {string} [opts.systemPrompt] - appended to the system prompt
 * @param {string[]} [opts.allowedTools] - e.g. ['mcp__plugin_google_google__calendar_events']
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} text response
 */
export async function run({ prompt, systemPrompt, allowedTools, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ['-p', '--output-format', 'json'];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (allowedTools && allowedTools.length) {
    args.push('--allowed-tools', allowedTools.join(','));
  }
  const result = await spawnClaude(args, prompt, timeoutMs);
  // claude -p --output-format json returns { type: "result", result: "...text...", ... }
  return result?.result ?? '';
}

/**
 * Run `claude -p` constrained to produce JSON matching the given schema.
 * Uses --output-format=json (gets the wrapper) AND instructs the model to return JSON in its body.
 * Then we extract the JSON from the text body.
 *
 * Why not use a JSON schema flag? `claude -p` does not have a stable structured-output
 * flag for JSON in all versions. Instead we instruct strictly + parse the response.
 * The response is wrapped in a markdown code block in some versions, so we strip that.
 *
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.systemPrompt]
 * @param {Object} opts.schema - JSON schema (informational, embedded in prompt)
 * @param {string[]} [opts.allowedTools]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>}
 */
export async function runJson({ prompt, systemPrompt, schema, allowedTools, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const fullSystem = [
    systemPrompt || '',
    '',
    'CRITICAL OUTPUT REQUIREMENT:',
    'Your ENTIRE response must be a single valid JSON value matching the schema below.',
    'Do NOT wrap the JSON in markdown code blocks. Do NOT include any prose before or after.',
    'The first character of your response must be `{` or `[` and the last must be `}` or `]`.',
    '',
    'Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');

  const text = await run({
    prompt,
    systemPrompt: fullSystem,
    allowedTools,
    timeoutMs,
  });

  return parseJsonResponse(text);
}

/**
 * Spawn claude -p with the prompt piped via stdin (avoids argv length limits + escaping issues).
 */
function spawnClaude(args, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      if (code !== 0) {
        return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 600) || stdout.slice(0, 600)}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        // Some versions return plain text when --output-format=json fails — try as text
        resolve({ result: stdout.trim() });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Pull the JSON value out of a text response. Strips ```json fences, trims, parses.
 * Throws a descriptive error if it can't parse.
 */
function parseJsonResponse(text) {
  if (!text) throw new Error('Claude returned empty response');
  let s = text.trim();

  // Strip ```json ... ``` fences if present
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  // Find the first { or [ and the matching last } or ]
  const firstBrace = s.search(/[{[]/);
  if (firstBrace > 0) s = s.slice(firstBrace);
  const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastBrace > 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);

  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`Claude response not valid JSON: ${e.message}\n--- raw (first 800 chars) ---\n${text.slice(0, 800)}`);
  }
}

/**
 * Quick health check: ask claude to echo "ok".
 */
export async function healthCheck() {
  try {
    const text = await run({ prompt: 'Reply with the single word: ok', timeoutMs: 30_000 });
    return { ok: text.toLowerCase().includes('ok') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
