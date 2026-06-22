# How sf-activity-tracker talks to Salesforce

Two backends behind a router. The app picks whichever one works on each machine.

1. **CLI backend** (`server/services/salesforce-cli.js`) — shells out to the **`sf` CLI v2** (`@salesforce/cli`). Reuses the user's existing local auth. No tokens stored. Default for SEs with a working `sf org login web --alias org62`.
2. **MCP backend** (`server/services/salesforce-mcp.js`) — talks to Salesforce's hosted Platform MCP (`api.salesforce.com/platform/mcp/v1/...`) over Streamable HTTP, authenticating via OAuth 2.0 + PKCE + RFC 8414 discovery. Used when the CLI is unavailable (corp DNS issues, expired tokens, fresh laptop, etc).

The router (`server/services/salesforce.js`) reads `~/.config/sf-activity-tracker/backend-config.json` and dispatches every call to one of the two peer modules. Both expose the **same public API** (`query`, `createRecord`, `getOrgInfo`, `healthCheck`, …) so callers (matcher, create, setup) don't know or care which is serving the request.

Three modes (set in Settings → Cuenta → Backend org62):
- `cli` — always CLI
- `mcp` — always MCP
- `auto` — try the preferred one first; on a **connection-class** failure (no auth, no tokens, ECONNREFUSED, 401/403, etc.) fall back to the other and cache the winner as `active`

---

## Why two backends instead of one

We tried CLI-only first; it had real-world failures we couldn't shrug off across the SE fleet:

| Failure | When |
|---|---|
| `sf` CLI not installed | Fresh laptops |
| Corp DNS doesn't resolve `login.salesforce.com` from outside SF VPN | WFH / roaming |
| `sf` auth tokens expired and refresh fails silently | Periodic |
| Newer macOS sandboxing blocks `sf`'s keychain access | Rare but devastating |

We tried MCP-only too; that has its own pitfalls:

| Failure | When |
|---|---|
| Connected App OAuth fails in restricted browsers (corp Chrome extensions) | Occasional |
| MCP endpoint requires `mcp_api` scope (not `api`); guessing wrong → "JWT Token is required" with valid tokens | Setup-time |
| MCP session handshake (`initialize` + `Mcp-Session-Id` header) easy to miss | Setup-time |

Net: **whichever route works on a given machine is the one we use**. The router + `auto` mode means the user doesn't usually have to think about which.

---

## MCP backend wiring

OAuth flow (zero-deps, all Node built-ins):
1. Discovery — `GET https://api.salesforce.com/.well-known/oauth-authorization-server` returns `authorization_endpoint`, `token_endpoint`.
2. PKCE — generate `code_verifier` + `code_challenge` (SHA256, base64url).
3. Local listener on `callbackPort` (default `8082`) at path `/callback`.
4. Open the user's browser to the authorization endpoint with `client_id`, `redirect_uri=http://localhost:8082/callback`, `scope=mcp_api refresh_token`, `code_challenge_method=S256`.
5. User completes SSO; SF redirects to our local listener with `code`.
6. POST to `token_endpoint` with the code + verifier → access + refresh tokens. Persisted to `~/.config/sf-activity-tracker/sf-mcp-tokens.json` (mode 0600).

MCP transport handshake (every endpoint, once per session):
1. POST `{"jsonrpc":"2.0","method":"initialize",...}` to the endpoint. Capture the `Mcp-Session-Id` response header.
2. POST `{"jsonrpc":"2.0","method":"notifications/initialized"}` with that header.
3. Every subsequent `tools/call` / `tools/list` must send `Mcp-Session-Id`.
4. On 400/404 (session expired) → re-initialize and retry once. On 401 → refresh access token and retry once.

The session cache is per-endpoint (`reads` and `mutations` get separate sessions).

**Critical gotcha**: SF Platform MCP requires the `mcp_api` scope, NOT the generic `api`. If you guess wrong the token exchange succeeds but every tool call returns `JWT Token is required`.

---

## Prerequisites the user does once

```bash
# Install the CLI (if not already)
npm install -g @salesforce/cli

# Auth against org62 (browser-based, opens login page)
sf org login web --alias org62 --instance-url https://gus.my.salesforce.com

# Verify
sf org display --target-org org62 --json
```

The alias `org62` is hardcoded in `server/services/salesforce.js`:

```js
const TARGET_ORG = 'org62';
```

If you're targeting a different org, change that constant or make it config-driven.

---

## The wrapper — one function does it all

Everything goes through this:

```js
// server/services/salesforce.js
import { spawn } from 'node:child_process';
const TARGET_ORG = 'org62';

function runSf(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sf', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return reject(new Error(`sf output not JSON (exit ${code}): ${stdout.slice(0, 500)} || stderr: ${stderr.slice(0, 300)}`));
      }
      if (parsed?.status !== 0) {
        return reject(new Error(`sf error: ${parsed?.message || JSON.stringify(parsed).slice(0, 500)}`));
      }
      resolve(parsed.result);
    });
  });
}
```

Key points:
- `--json` is **always** passed. The CLI's JSON output has the shape `{ status: 0, result: ... }` on success and `{ status: 1, message, ... }` on error. Easy to branch on.
- **`stderr` is captured but only used for error messages.** SF's CLI emits cert deprecation warnings, "you have an old version" notices, etc. on stderr that would corrupt JSON if you tried to parse them.
- Use `spawn` with an `args` array, **not** `exec` with a string. No shell injection, no escaping of shell metachars.

---

## Queries — SOQL via `sf data query`

```js
export async function query(soql) {
  const result = await runSf([
    'data', 'query',
    '--target-org', TARGET_ORG,
    '--query', soql,
    '--json',
  ]);
  return result?.records || [];
}
```

For tooling-API objects (`FieldDefinition`, `EntityDefinition`, picklist values…) add `--use-tooling-api`:

```js
export async function queryTooling(soql) {
  const result = await runSf([
    'data', 'query',
    '--target-org', TARGET_ORG,
    '--query', soql,
    '--use-tooling-api',
    '--json',
  ]);
  return result?.records || [];
}
```

### SOQL escape — manual, no parameterization

The CLI doesn't accept bind variables. We escape manually with a strict whitelist:

```js
// Allow only safe characters in user-provided values that go into SOQL
if (!/^[\w.+\-@]+$/.test(email)) {
  return sendJson(res, 400, { error: 'invalid email format' });
}
const records = await query(
  `SELECT Id, Name FROM User WHERE Email = '${email}' AND IsActive = TRUE LIMIT 1`
);
```

For free-text search (LIKE), strip single quotes:

```js
const safeSearch = search.replace(/'/g, "\\'");
const records = await query(`SELECT Id, Name FROM Account WHERE Name LIKE '%${safeSearch}%'`);
```

Crude but adequate for an internal tool. **If your tracker accepts queries from untrusted input, do real parameterization** — at that point you probably want the REST API, not the CLI.

---

## Creating records — `sf data create record`

```js
export async function createRecord(sobject, fields) {
  const valuesStr = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');

  const result = await runSf([
    'data', 'create', 'record',
    '--target-org', TARGET_ORG,
    '--sobject', sobject,
    '--values', valuesStr,
    '--json',
  ]);
  return result?.id;
}
```

Usage:

```js
const eventId = await createRecord('Event', {
  RecordTypeId: '01230000001GgBYAA0',     // Solutions Event
  OwnerId: cfg.seUserId,
  Subject: 'Customer call — Acme',
  StartDateTime: '2026-06-12T14:00:00Z',
  EndDateTime:   '2026-06-12T15:00:00Z',
  SE_Task_Type__c: 'Customer Meeting',
  WhatId: '0061x00000ABcDeFAAB',
});
```

### `--values` formatting — the tricky bit

`--values` takes ONE big string of `field=value` pairs separated by spaces. Values containing spaces need single-quote wrapping. Apostrophes inside values become an escape nightmare. Here's our `formatValue`:

```js
function formatValue(v) {
  let s = String(v);
  // Normalize apostrophes → right-single-quote so we never need to escape inside ''
  s = s.replace(/'/g, '’');
  // ISO datetimes, IDs, numbers, booleans, dotted names → unquoted
  if (/^[\w.+\-:]+$/.test(s)) return s;
  // Anything else → wrap in single quotes
  return `'${s}'`;
}
```

Rules in plain English:
- **IDs, ISO 8601 datetimes, numbers, booleans**: pass through bare. The regex `^[\w.+\-:]+$` covers all of these (datetimes have `:`, IDs have `.+\-`, etc.).
- **Strings with spaces or punctuation**: wrap in `'...'`.
- **Apostrophes inside strings**: rewrite to `’` (U+2019). Salesforce stores it fine and you avoid having to escape `'` inside `'...'` (which the CLI's parser doesn't handle cleanly anyway).

If your data could legitimately contain `’` in a way that matters, this is a lossy transform. For activity subjects, descriptions, etc., it's invisible.

---

## Org metadata — instance URL and authenticated user

```js
let _orgInfoCache = null;
export async function getOrgInfo() {
  if (_orgInfoCache) return _orgInfoCache;
  const result = await runSf(['org', 'display', '--target-org', TARGET_ORG, '--json']);
  if (!result?.instanceUrl) throw new Error('sf org display returned no instanceUrl');
  _orgInfoCache = { instanceUrl: result.instanceUrl, username: result.username || null };
  return _orgInfoCache;
}
```

Two consumers:
- **`instanceUrl`** — for building Lightning record URLs in the frontend (`${instanceUrl}/lightning/r/Event/${id}/view`).
- **`username`** — for auto-detecting the SE in the setup wizard, so the user doesn't have to type their email manually.

**Cache it.** `sf org display` takes ~300-500ms and never changes within a process lifetime. We memoize for the life of the Node process.

---

## Workarounds & gotchas (the section you came here for)

### 1. CLI v1 vs v2 syntax

The old `sfdx` and early `sf` releases used hyphenated subcommands:

```bash
sf data create-record ...   # ❌ WRONG (v1)
sf data create record ...   # ✅ CORRECT (v2)
```

This bit us in production. If your tracker fails with `command create-record not found`, you're on a v1 CLI. Upgrade.

### 2. Stderr noise corrupts JSON parsing

Don't merge stderr into stdout. The CLI emits warnings about cert deprecation, deprecation of certain flags, "newer version available", etc. on stderr. If you accidentally include them in the buffer you parse as JSON, parsing dies.

```js
// ❌ WRONG — stderr mixed in
spawn('sf', args, { stdio: ['ignore', 'inherit', 'inherit'] });

// ✅ CORRECT — separate pipes
spawn('sf', args, { stdio: ['ignore', 'pipe', 'pipe'] });
```

### 3. SOQL injection

The CLI is just a glorified HTTP client — it does NOT escape your SOQL. If you concatenate user input into a query, you can craft bypasses. We accept this risk for an internal tool with strict input validation, but if your tracker has untrusted input, **don't use the CLI for queries**. Use the REST API with a real escaping library.

### 4. RecordTypeId for Events

`Event` is a polymorphic object. In our org, "Solutions Event" (the SE-specific record type) is `01230000001GgBYAA0`. **This Id differs per org.** Look yours up:

```bash
sf data query --target-org org62 \
  --query "SELECT Id, Name FROM RecordType WHERE SobjectType = 'Event'" \
  --json
```

### 5. Idempotency for Deal Contributions

DCs are unique per `(Opportunity, SE_Name)`. If you `createRecord` blindly, a re-run will fail or duplicate. We re-check before creating:

```js
const existing = await query(
  `SELECT Id, Split_Percentage__c FROM Deal_Contribution__c
   WHERE Opportunity__c = '${oppId}'
     AND SE_Name__c = '${seUserId}'
     AND IsDeleted = FALSE
   LIMIT 1`
);
if (existing[0] && (existing[0].Split_Percentage__c || 0) > 0) {
  // skip — already exists with split > 0
}
```

Events don't have a natural unique constraint, so we de-dupe on the client side (subject + start time match) before we even POST.

### 6. Order of operations: DCs before Events

If you create the Event first and the DC fails, you have an Event linked to an Opp without your DC, which complicates retries. Reverse order means a DC failure leaves nothing to clean up.

### 7. Process overhead

Each `sf` call is `~150-300ms` (process spawn + Node CLI startup + HTTP roundtrip). For a batch of 30 events:

- **Sequential**: ~6-9s. Fine.
- **Parallel** (`Promise.all`): unstable. We saw the CLI crash with file-handle exhaustion above ~10 concurrent calls. Stick to sequential or chunked-parallel (≤5 at a time) if you need throughput.

### 8. No streaming output

The CLI buffers JSON until completion. If you create 100 events, you get 100 separate spawns and you have to stream UI progress yourself. We use Server-Sent Events from the Node server to the browser to push per-record success/failure as each `sf` call returns.

### 9. `Date` and `Datetime` formatting

Use ISO 8601 with `Z` suffix for `Datetime`:

```js
StartDateTime: '2026-06-12T14:00:00Z'
```

For `Date` (just `Date`, not `Datetime`):

```js
SomeDate__c: '2026-06-12'
```

The CLI parser is permissive but Salesforce-side conversion is not. Stick to ISO and `Z`.

### 10. Null vs missing fields

`null` fields blow up `--values` (you'd write `Field=null` and Salesforce stores the literal string). We filter them out before building the values string:

```js
.filter(([, v]) => v !== null && v !== undefined)
```

To explicitly NULL a field on update, use the REST API instead — the CLI's `data create record` doesn't support sentinel-value blanking cleanly.

---

## What you'd need to change to support a different org

1. **`TARGET_ORG`** in `services/salesforce.js` — change `org62` to your alias.
2. **`SE_RECORD_TYPE_ID`** in `routes/create.js` — query your org for the right Id.
3. **Custom field API names** — `SE_Name__c`, `SE_Task_Type__c`, `Opportunity_Role__c`, `Split_Percentage__c`, `Engagement_Status__c`, etc. all carry `__c` and are org-specific. Adapt to whatever your activity model uses.
4. **`Deal_Contribution__c`** — our split-credit object. If your org uses standard `OpportunityContactRole` or something else, replace the queries.

---

## Files to study

- [server/services/salesforce.js](server/services/salesforce.js) — the entire CLI wrapper, ~170 lines.
- [server/routes/create.js](server/routes/create.js) — how Events + DCs get written end-to-end with SSE progress.
- [server/routes/setup.js](server/routes/setup.js) — `whoami`, `resolveUser`, manual record lookup.

---

## TL;DR for someone copying this

```js
// 1. Wrap `sf` once with --json. Keep stderr separate.
// 2. SOQL: validate inputs with a regex whitelist.
// 3. Create: build "field=value field=value ..." string.
//    Bare values for IDs/dates/numbers, single-quote everything else,
//    swap apostrophes for ’ to avoid escaping.
// 4. DC before Event. Re-check existence before creating DCs.
// 5. Cache `sf org display` for the process lifetime.
// 6. Stream progress to the UI yourself — the CLI is request/response, not streaming.
```

That's the whole game. Auth is free because the user already ran `sf org login`. Everything else is just careful string formatting around `child_process.spawn`.
