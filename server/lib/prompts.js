// SE Task Type taxonomy — values MUST match org62 picklist verbatim.
// Source: SELECT picklistValues FROM SE_Task_Type__c on Event sobject (queried 2026-06-08).

/**
 * @typedef {{value: string, isCF: boolean, isCR: boolean, hint: string}} TaxonomyEntry
 */

/** @type {TaxonomyEntry[]} */
export const SE_TASK_TYPES = [
  { value: 'Customer Discovery', isCF: true, isCR: true, hint: 'Discovery call/meeting with customer; understand needs, requirements, pain points.' },
  { value: 'Customer Presentation', isCF: true, isCR: true, hint: 'Demo or presentation TO a customer (live demo, deck walkthrough).' },
  { value: 'Workshop', isCF: true, isCR: true, hint: 'Multi-hour interactive session WITH the customer (design, vision, working session).' },
  { value: 'POC', isCF: true, isCR: true, hint: 'Proof of Concept work — building or running a customer-specific POC.' },
  { value: 'Dry Run', isCF: false, isCR: true, hint: 'Internal rehearsal of a customer demo/presentation (no customer present).' },
  { value: 'Solution Creation', isCF: false, isCR: true, hint: 'Designing or building a solution architecture/proposal for a specific opp (internal).' },
  { value: 'Asset Creation', isCF: false, isCR: true, hint: 'Creating reusable assets (demos, decks, code) tied to an opp or product.' },
  { value: 'Account Planning', isCF: false, isCR: true, hint: 'Internal account-level planning, opportunity strategy, account team meetings.' },
  { value: 'Business Value Assessment', isCF: true, isCR: true, hint: 'BVS sessions WITH the customer (working through value with them).' },
  { value: 'BVS - Business Case', isCF: false, isCR: true, hint: 'Building the business case document (internal work).' },
  { value: 'BVS - Proposal', isCF: false, isCR: true, hint: 'Building the BVS proposal (internal work).' },
  { value: 'BVS - Value Hypothesis', isCF: false, isCR: true, hint: 'Building the value hypothesis (internal work).' },
  { value: 'Consumption Estimation', isCF: false, isCR: true, hint: 'Sizing exercises, consumption calculators (internal).' },
  { value: 'Consumption Event', isCF: true, isCR: true, hint: 'Customer consumption events (workshops, hackathons WITH customer).' },
  { value: 'Post Sale Adoption Support', isCF: true, isCR: true, hint: 'Post-sale adoption help WITH the customer (live calls).' },
  { value: 'Post Sale Consumption Activation', isCF: true, isCR: true, hint: 'Post-sale activation work WITH customer.' },
  { value: 'Post Sale Technical Product Support', isCF: true, isCR: true, hint: 'Post-sale tech support WITH customer.' },
  { value: 'Red Account Support', isCF: true, isCR: true, hint: 'Critical/red account escalation WITH customer.' },
  { value: 'RFx', isCF: false, isCR: true, hint: 'RFP/RFI/RFQ response work (internal). Use even if RFx review is with customer.' },
  { value: 'Marketing Support', isCF: false, isCR: false, hint: 'Marketing events, public speaking, content for marketing.' },
  { value: 'Partner Support', isCF: false, isCR: true, hint: 'Sessions with partners (SI, ISV) — not direct customer.' },
  { value: 'Localization', isCF: false, isCR: true, hint: 'Translating/localizing assets for a specific opp.' },
  { value: 'Mentorship', isCF: false, isCR: false, hint: 'Mentoring/coaching other SEs.' },
  { value: 'Sales Enablement', isCF: false, isCR: false, hint: 'Internal team trainings, certifications, ramping (giving or receiving).' },
  { value: 'Personal Development', isCF: false, isCR: false, hint: 'Self-directed learning, certifications, conferences.' },
  { value: 'V2MOM Initiatives', isCF: false, isCR: false, hint: 'V2MOM/strategic initiative work (not opp-specific).' },
  { value: 'Travel', isCF: false, isCR: false, hint: 'Travel time (flights, transit between meetings).' },
  { value: 'Wellness', isCF: false, isCR: false, hint: 'Wellness blocks, breaks.' },
  { value: 'Admin', isCF: false, isCR: false, hint: 'Admin overhead (timesheet logging, internal forms, expenses, generic 1:1s).' },
  { value: 'Not Available', isCF: false, isCR: false, hint: 'PTO, sick leave, OOO. Usually skipped, not logged.' },
];

/** Quick lookup: pickilst value → entry */
export const TAXONOMY_BY_VALUE = Object.fromEntries(SE_TASK_TYPES.map((t) => [t.value, t]));

/**
 * Builds the system prompt for the matching+classification call.
 * @param {Object} ctx
 * @param {Array} ctx.dcOpportunities
 * @param {Array} ctx.aliasTable
 * @param {Array} ctx.taxonomyCorrections
 * @param {string[]} ctx.excludedTitles
 * @param {string[]} ctx.internalEmailDomains
 * @param {Object|null} ctx.catchAll
 * @param {string} ctx.seName
 * @param {string} ctx.seEmail
 */
export function buildMatchSystemPrompt(ctx) {
  const taxonomyTable = SE_TASK_TYPES.map(
    (t) => `- "${t.value}" (CF:${t.isCF} CR:${t.isCR}) — ${t.hint}`
  ).join('\n');

  return `You are an automated activity classifier for a Salesforce Solution Engineer (${ctx.seName} / ${ctx.seEmail}).

Your job: for each Google Calendar event, decide:
1. The status: "identified" (matched to a record, will be logged), "flagged" (cannot match confidently — needs human review), "excluded" (matches an excluded title), or "skip" (e.g. "Not Available", PTO, declined). NEVER use "already-logged" — that decision is made deterministically before this call.
2. The Related To record (Opportunity, Account, or null for skip/flagged).
3. The SE Task Type — MUST be one of the picklist values listed below, EXACTLY as written.
4. CF (Customer Facing) and CR (Customer Related) booleans — derived from the SE Task Type unless overridden by external attendee rule.
5. A short reasoning string (under 140 chars) explaining the choice.
6. A confidence: "high" | "medium" | "low".

# Internal email domains (anyone NOT in this list is EXTERNAL)
${ctx.internalEmailDomains.map((d) => `- @${d}`).join('\n')}

# Excluded titles (case-insensitive substring match) — set status="excluded"
${ctx.excludedTitles.map((t) => `- "${t}"`).join('\n') || '(none)'}

# SE Task Type taxonomy (the value field MUST come from this list)
${taxonomyTable}

# Matching priority for Related To
1. **Alias table** — if any keyword from the event title/description matches an alias here, use the mapped record:
${formatAliasTable(ctx.aliasTable)}

2. **Active Deal Contributions** — the SE has these DCs already; prefer matching against these opps and their accounts (and parent accounts):
${formatDcOpportunities(ctx.dcOpportunities)}

3. **Salesforce URL or Id in title/description** — extract Opportunity/Account Ids (15 or 18 char IDs starting with 006/001) and use directly.

4. **External attendee email domain** — try to map the domain to an account name (no DB lookup; just a hint to flag for review unless you can match to a DC opportunity).

5. **Catch-all record** — if no match found and a catch-all is configured, use it for non-Customer-Facing activities only:
${ctx.catchAll ? `   - ${ctx.catchAll.type}: ${ctx.catchAll.name} (id: ${ctx.catchAll.id})` : '   (no catch-all configured)'}

6. **Otherwise**: status="flagged", relatedTo=null. Always flag external-attendee meetings that don't match anything — they likely need a new opp/DC.

# CF/CR rules
- CF = Customer Facing. CR = Customer Related.
- Default: derive CF/CR from the SE Task Type (table above).
- **External attendee override**: if at least one attendee email domain is EXTERNAL (not in the internal domain list above), force CF=true. If the picked SE Task Type has CF=false, switch it to a CF-compatible alternative (e.g. "Customer Discovery", "Customer Presentation", "Workshop", "Business Value Assessment") that best fits the title.
- **Internal-only**: if all attendees are internal AND title is ambiguous ("sync", "1:1", "team meeting"), default to "Admin" or "Sales Enablement" (CF=false, CR=false).
- **Demo/presentation/presentación in title** → "Customer Presentation".
- **Workshop in title** → "Workshop".
- **Discovery in title** → "Customer Discovery".
- **Dry run / rehearsal in title (internal only)** → "Dry Run".
- **POC keyword** → "POC".

# Taxonomy corrections (user-saved keyword → SE Task Type overrides) — apply FIRST
${formatTaxonomyCorrections(ctx.taxonomyCorrections)}

# Skip rules
- RSVP status "declined" → status="skip", reasoning="user declined"
- Title matches "Not Available" / "OOO" / "PTO" / "Vacation" → status="skip"
- All-day blocks that aren't customer-facing → status="skip" unless it's a clear customer event

# Confidence
- "high": alias hit, explicit Salesforce ID, or DC opportunity name match in title
- "medium": account name fuzzy match against DC list, or external domain match
- "low": only generic keywords, catch-all fallback, or ambiguous internal events`;
}

function formatAliasTable(aliasTable) {
  if (!aliasTable || !aliasTable.length) return '(no aliases yet)';
  return aliasTable
    .map((a) => {
      const matches = a.matches.map((m) => `${m.type}: ${m.name} (id: ${m.id})`).join(' | ');
      return `   - "${a.alias}" → ${matches}`;
    })
    .join('\n');
}

function formatDcOpportunities(dcs) {
  if (!dcs || !dcs.length) return '   (no active DCs)';
  return dcs
    .slice(0, 80) // cap to avoid blowing the context
    .map((d) => {
      const closed = d.opportunityIsClosed ? ' [CLOSED]' : '';
      const parent = d.accountParentName ? ` (parent: ${d.accountParentName})` : '';
      return `   - Opportunity: "${d.opportunityName}"${closed} | Account: ${d.accountName}${parent} | Opp Id: ${d.opportunityId}`;
    })
    .join('\n');
}

function formatTaxonomyCorrections(corrections) {
  if (!corrections || !corrections.length) return '(none)';
  return corrections.map((c) => `- if title contains "${c.keyword}" → "${c.seTaskType}"`).join('\n');
}

/**
 * The user prompt for the matching call. Carries the events array.
 */
export function buildMatchUserPrompt(events) {
  return `Classify each of these ${events.length} Google Calendar events. Return ONLY a JSON array — one entry per event, in the same order.

EVENTS:
${JSON.stringify(events, null, 2)}`;
}
