// Orchestrates the analyze flow: fetch calendar → fetch DCs → de-dupe check → classify.

import { fetchEvents } from './calendar.js';
import { query } from './salesforce.js';
import { runJson } from './claude.js';
import { buildMatchSystemPrompt, buildMatchUserPrompt, TAXONOMY_BY_VALUE } from '../lib/prompts.js';
import { MATCH_SCHEMA } from '../lib/schemas.js';
import * as classCache from './classification-cache.js';
import * as overrides from './overrides-store.js';

/**
 * Fetch the SE's Deal Contributions with related Opportunity + Account info.
 * Filters out DCs whose Opportunity has been closed for more than CLOSED_DC_TTL_DAYS.
 * Old long-closed opps clutter the dropdown and confuse the classifier; if the user
 * really needs to log against one, they can paste its URL via the manual flow.
 */
const CLOSED_DC_TTL_DAYS = 30;

export async function fetchDcOpportunities(seUserId) {
  const records = await query(
    `SELECT Id, Opportunity__c, Opportunity__r.Name, Opportunity__r.IsClosed,
            Opportunity__r.CloseDate, Opportunity__r.AccountId,
            Opportunity__r.Account.Name, Opportunity__r.Account.ParentId,
            Opportunity__r.Account.Parent.Name,
            Split_Percentage__c, CreatedDate
     FROM Deal_Contribution__c
     WHERE SE_Name__c = '${seUserId}' AND IsDeleted = FALSE
     ORDER BY CreatedDate DESC`
  );

  const cutoff = Date.now() - CLOSED_DC_TTL_DAYS * 24 * 60 * 60 * 1000;
  return records
    .map((r) => ({
      dcId: r.Id,
      opportunityId: r.Opportunity__c,
      opportunityName: r.Opportunity__r?.Name || '',
      opportunityIsClosed: !!r.Opportunity__r?.IsClosed,
      opportunityCloseDate: r.Opportunity__r?.CloseDate || null,
      accountId: r.Opportunity__r?.AccountId || null,
      accountName: r.Opportunity__r?.Account?.Name || '',
      accountParentName: r.Opportunity__r?.Account?.Parent?.Name || '',
      splitPercentage: r.Split_Percentage__c ?? null,
    }))
    .filter((d) => {
      // Keep all open opps. Drop opps closed before the cutoff.
      if (!d.opportunityIsClosed) return true;
      if (!d.opportunityCloseDate) return true; // unknown close date — keep, edge case
      return new Date(d.opportunityCloseDate).getTime() >= cutoff;
    });
}

/**
 * For a list of calendar events, find which already exist as Events in org62 owned by the SE.
 * Returns a Map<eventKey, salesforceEventId>.
 */
export async function fetchAlreadyLogged(seUserId, fromIso, toIso) {
  // Subject + StartDateTime is the de-dupe key
  // Pad the window slightly to catch tz edge cases
  const fromDate = new Date(fromIso);
  const toDate = new Date(toIso);
  fromDate.setDate(fromDate.getDate() - 1);
  toDate.setDate(toDate.getDate() + 1);

  const records = await query(
    `SELECT Id, Subject, StartDateTime, EndDateTime, WhatId, SE_Task_Type__c
     FROM Event
     WHERE OwnerId = '${seUserId}'
       AND IsDeleted = FALSE
       AND StartDateTime >= ${fromDate.toISOString()}
       AND StartDateTime <= ${toDate.toISOString()}`
  );
  return records;
}

/**
 * Build a key for de-dupe matching between Calendar event and SF Event record.
 * Uses subject + start datetime rounded to the minute.
 */
function dedupeKey(subject, startIso) {
  const subj = (subject || '').trim().toLowerCase();
  const dt = new Date(startIso);
  // Round to minute, ignore seconds
  dt.setSeconds(0, 0);
  return `${subj}|${dt.toISOString()}`;
}

/**
 * Main analyze entry-point.
 * @param {Object} opts
 * @param {string} opts.fromIso
 * @param {string} opts.toIso
 * @param {Object} opts.config - the user config
 * @param {boolean} [opts.forceRefresh] - bypass calendar cache
 * @param {boolean} [opts.forceReclassify] - bypass classification cache, re-classify everything
 */
export async function analyze({ fromIso, toIso, config, forceRefresh = false, forceReclassify = false }) {
  const errors = [];
  let calendarMeta = { fromCache: false, fetchedAt: null, backend: null };
  let classifyMeta = { cacheHits: 0, freshClassifications: 0 };

  // 1) Fetch calendar — Google API direct if configured, else claude -p fallback. Cached 30 min.
  let events = [];
  try {
    const fetched = await fetchEvents(fromIso, toIso, config.seEmail, {
      forceRefresh,
      enabledCalendarIds: config.enabledCalendarIds || [],
    });
    events = fetched.events;
    calendarMeta = {
      fromCache: fetched.fromCache,
      fetchedAt: fetched.fetchedAt,
      backend: fetched.backend,
      fellBackTo: fetched.fellBackTo,
      fallbackReason: fetched.fallbackReason,
    };
  } catch (e) {
    errors.push({ stage: 'calendar', message: e.message });
    return { events: [], dcOpportunities: [], errors, classifications: [], calendarMeta };
  }

  // 2) Pre-filter: drop declined RSVPs (but still de-dupe against them)
  const filtered = events.filter((e) => {
    if (e.rsvpStatus === 'declined') return false;
    return true;
  });

  // 3) Fetch SE's active DCs (parallel with already-logged check)
  let dcOpportunities = [];
  let alreadyLogged = [];
  try {
    [dcOpportunities, alreadyLogged] = await Promise.all([
      fetchDcOpportunities(config.seUserId),
      fetchAlreadyLogged(config.seUserId, fromIso, toIso),
    ]);
  } catch (e) {
    errors.push({ stage: 'salesforce', message: e.message });
  }

  // 4) Build a de-dupe lookup: key → SF Event Id
  const loggedMap = new Map();
  for (const r of alreadyLogged) {
    loggedMap.set(dedupeKey(r.Subject, r.StartDateTime), r.Id);
  }

  // 5) For each calendar event, attach already-logged status
  const enrichedEvents = filtered.map((e) => {
    const key = dedupeKey(e.summary, e.start);
    const sfEventId = loggedMap.get(key);
    return {
      ...e,
      alreadyLoggedSfId: sfEventId || null,
    };
  });

  // 6) Split into "needs classification" vs "already logged"
  const needsClassification = enrichedEvents.filter((e) => !e.alreadyLoggedSfId);

  // 7) If nothing needs classification, short-circuit
  if (needsClassification.length === 0) {
    return {
      events: enrichedEvents,
      dcOpportunities,
      classifications: enrichedEvents.map((e) => ({
        eventId: e.id,
        status: 'already-logged',
        salesforceEventId: e.alreadyLoggedSfId,
      })),
      errors,
      calendarMeta,
      classifyMeta,
    };
  }

  // 7b) Classification cache lookup — skip events we've already classified.
  // Hash captures (subject|start|end|attendeeCount). If unchanged, reuse.
  const eventHashes = new Map(); // eventId → hash
  const cachedClassifications = []; // already-classified, keep as-is
  const toClassify = []; // need claude run

  for (const ev of needsClassification) {
    const hash = classCache.eventHash(ev);
    eventHashes.set(ev.id, hash);
    if (!forceReclassify) {
      const cached = classCache.get(ev.id, hash);
      if (cached) {
        // Tag so the frontend can filter by "freshly classified this run"
        cachedClassifications.push({ ...cached, _fromCache: true });
        continue;
      }
    }
    toClassify.push(ev);
  }
  classifyMeta.cacheHits = cachedClassifications.length;
  classifyMeta.freshClassifications = toClassify.length;

  // 8) Build the slimmed-down event payload sent to Claude — ONLY events not in cache.
  const slimEvents = toClassify.map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start,
    end: e.end,
    durationHours: e.durationHours,
    description: (e.description || '').slice(0, 500),
    location: (e.location || '').slice(0, 200),
    organizer: e.organizer,
    isOrganizer: e.isOrganizer,
    rsvpStatus: e.rsvpStatus,
    attendees: (e.attendees || []).slice(0, 30).map((a) => ({
      email: a.email,
      displayName: a.displayName,
      self: a.self,
      responseStatus: a.responseStatus,
    })),
  }));

  // 9) Classify via claude -p — split into parallel batches so a single
  //    long-running call doesn't exceed the timeout.
  //    SKIP this entirely if every event was a cache hit.
  let classifications = [...cachedClassifications];

  if (slimEvents.length === 0) {
    // Everything came from cache — short-circuit to step 10
  } else try {
    const systemPrompt = buildMatchSystemPrompt({
      dcOpportunities,
      aliasTable: config.aliasTable || [],
      taxonomyCorrections: config.taxonomyCorrections || [],
      excludedTitles: config.excludedTitles || [],
      internalEmailDomains: config.internalEmailDomains || ['salesforce.com'],
      catchAll: config.catchAll || null,
      seName: config.seName,
      seEmail: config.seEmail,
    });

    const BATCH_SIZE = 10;
    const batches = chunkArray(slimEvents, BATCH_SIZE);

    // Run batches in parallel. Each batch is small so claude responds fast.
    // If a batch fails, capture it as an error but don't kill the whole analyze.
    const batchResults = await Promise.all(
      batches.map(async (batch, idx) => {
        try {
          const result = await runJson({
            prompt: buildMatchUserPrompt(batch),
            systemPrompt,
            schema: MATCH_SCHEMA,
            timeoutMs: 180_000, // 3 min per batch — should be plenty for 10 events
          });
          if (!Array.isArray(result)) {
            throw new Error(`batch ${idx + 1} returned non-array`);
          }
          return result;
        } catch (e) {
          errors.push({ stage: 'classify', message: `Batch ${idx + 1}/${batches.length}: ${e.message}` });
          return [];
        }
      })
    );

    const fresh = batchResults.flat().map((c) => normalizeClassification(c));

    // Persist fresh classifications to cache for next analyze (BEFORE tagging
    // — the cache should hold the "clean" version without _fromCache flag).
    const cacheItems = fresh
      .filter((c) => c.eventId && eventHashes.has(c.eventId))
      .map((c) => ({
        eventId: c.eventId,
        hash: eventHashes.get(c.eventId),
        classification: c,
      }));
    if (cacheItems.length) classCache.setMany(cacheItems);

    // Tag fresh ones so frontend can filter on "this run"
    const freshTagged = fresh.map((c) => ({ ...c, _fromCache: false }));
    classifications = [...cachedClassifications, ...freshTagged];
  } catch (e) {
    errors.push({ stage: 'classify', message: e.message });
  }

  // 10) Merge with already-logged events
  const allClassifications = enrichedEvents.map((e) => {
    if (e.alreadyLoggedSfId) {
      return {
        eventId: e.id,
        status: 'already-logged',
        salesforceEventId: e.alreadyLoggedSfId,
        relatedTo: null,
        seTaskType: null,
        isCF: false,
        isCR: false,
        confidence: 'high',
        reasoning: 'Already exists as an Event in org62',
      };
    }
    const found = classifications.find((c) => c.eventId === e.id);
    if (found) return found;
    return {
      eventId: e.id,
      status: 'flagged',
      relatedTo: null,
      seTaskType: 'Admin',
      isCF: false,
      isCR: false,
      confidence: 'low',
      reasoning: 'Classifier did not return a result for this event',
    };
  });

  // 11pre) Overlay user overrides BEFORE the closed-opp check, so the check
  //         runs against the user's chosen relatedTo, not Claude's original.
  //         (kept inline below for backwards compat — original block was named 11)
  // 11) Overlay user overrides on top of classifications (relatedTo, seTaskType, CF/CR).
  //     The override's hash must match the current event hash — otherwise the event was
  //     edited in Google and the override is stale, so we ignore it.
  //     Also stamp _hash on every classification so the frontend can post overrides back.
  const overrideMap = overrides.getMany(eventHashes);
  let overridesApplied = 0;
  for (const c of allClassifications) {
    const hash = eventHashes.get(c.eventId);
    if (hash) c._hash = hash;
    const ovr = overrideMap.get(c.eventId);
    if (!ovr) continue;
    if (c.status === 'already-logged') continue; // shouldn't have an override anyway
    if (ovr.relatedTo !== undefined) c.relatedTo = ovr.relatedTo;
    if (ovr.seTaskType !== undefined) c.seTaskType = ovr.seTaskType;
    if (ovr.isCF !== undefined) c.isCF = ovr.isCF;
    if (ovr.isCR !== undefined) c.isCR = ovr.isCR;
    c._userEdited = true;
    // If the user manually picked a relatedTo for a flagged event, promote it to identified
    if (c.status === 'flagged' && c.relatedTo) c.status = 'identified';
    overridesApplied++;
  }
  classifyMeta.overridesApplied = overridesApplied;

  // 12) Two-tier closed-opp check.
  //     For each event matched to an Opportunity that is currently closed,
  //     verify the opp was actually open at the event time.
  //
  //     Tier 1 (free): event.start <= Opp.CloseDate → was open. Else inconclusive.
  //     Tier 2 (one batched query): inspect OpportunityFieldHistory for the
  //         StageName transition into a closed-stage. If event.start < that
  //         transition → was open. If event.start >= that transition → closed.
  //         If history not available (>18 months retention) → unknown, allow with warning.
  await applyClosedOppCheck(allClassifications, enrichedEvents, dcOpportunities);

  return {
    events: enrichedEvents,
    dcOpportunities,
    classifications: allClassifications,
    errors,
    calendarMeta,
    classifyMeta,
  };
}

/**
 * Two-tier verification that an event matched to a closed Opportunity actually
 * happened while the opp was still open. Mutates classifications in place.
 *
 *   Tier 1 (free): event.start <= opp.CloseDate → was open. Done.
 *                  Otherwise mark as inconclusive and proceed to Tier 2.
 *   Tier 2 (1 batched SOQL on OpportunityFieldHistory): walk the StageName
 *                  history to find when the opp first transitioned to a closed
 *                  stage. Compare against event date.
 *
 * Result is stamped on classification._closedOppCheck:
 *   { tier: 1|2, status: 'open-at-event'|'closed-at-event'|'unknown', ... }
 *
 * If status is 'closed-at-event' the row is downgraded to 'flagged' so the
 * user explicitly reviews before logging. 'unknown' keeps the original status
 * but adds a warning the UI can render.
 */
async function applyClosedOppCheck(classifications, events, dcs) {
  // Step A: gather candidates and run Tier 1
  const inconclusive = []; // [{ classification, event, dc }]

  for (const c of classifications) {
    if (c.status !== 'identified') continue;
    if (c.relatedTo?.type !== 'Opportunity') continue;

    const dc = dcs.find((d) => d.opportunityId === c.relatedTo.id);
    if (!dc) continue; // pasted-URL opps without DC info — skip the check
    if (!dc.opportunityIsClosed) continue; // opp is open today → no check needed

    const event = events.find((e) => e.id === c.eventId);
    if (!event?.start) continue;
    const eventDate = new Date(event.start);

    // Tier 1 — compare with CloseDate (date, not datetime)
    if (dc.opportunityCloseDate) {
      const closeDate = new Date(dc.opportunityCloseDate);
      if (eventDate <= closeDate) {
        c._closedOppCheck = { tier: 1, status: 'open-at-event' };
        continue;
      }
    }

    // Tier 1 inconclusive — queue for Tier 2
    inconclusive.push({ classification: c, eventDate, dc });
  }

  if (inconclusive.length === 0) return;

  // Step B: Tier 2 — single SOQL for all inconclusive opps
  const oppIds = [...new Set(inconclusive.map((x) => x.dc.opportunityId))];
  const idList = oppIds.map((id) => `'${id}'`).join(',');

  let history = [];
  try {
    history = await query(
      `SELECT OpportunityId, OldValue, NewValue, CreatedDate
       FROM OpportunityFieldHistory
       WHERE OpportunityId IN (${idList})
         AND Field = 'StageName'
       ORDER BY CreatedDate ASC`
    );
  } catch (e) {
    // Field history can be locked-down per OU — surface as 'unknown' for all
    for (const it of inconclusive) {
      it.classification._closedOppCheck = {
        tier: 2,
        status: 'unknown',
        warning: `Could not query stage history (${e.message?.slice(0, 80)}). Verify manually.`,
      };
    }
    return;
  }

  // Step C: index history by Opp Id and apply per item
  const byOpp = new Map();
  for (const h of history) {
    if (!byOpp.has(h.OpportunityId)) byOpp.set(h.OpportunityId, []);
    byOpp.get(h.OpportunityId).push(h);
  }

  for (const it of inconclusive) {
    const oppHistory = byOpp.get(it.dc.opportunityId) || [];
    const verdict = wasOpenAt(oppHistory, it.eventDate);
    if (verdict === 'open') {
      it.classification._closedOppCheck = { tier: 2, status: 'open-at-event' };
    } else if (verdict === 'closed') {
      it.classification._closedOppCheck = {
        tier: 2,
        status: 'closed-at-event',
        warning: 'Opportunity was already closed on the event date per stage history.',
      };
      // Downgrade so the user must explicitly review (skipping or repointing)
      it.classification.status = 'flagged';
    } else {
      it.classification._closedOppCheck = {
        tier: 2,
        status: 'unknown',
        warning: 'Stage history unavailable (likely >18 months). Verify manually.',
      };
    }
  }
}

/**
 * Determine if an Opportunity was in a "closed" stage at the given event date,
 * based on its StageName field history.
 *
 * Strategy: scan history (sorted ASC) and find the FIRST transition where
 * NewValue contains a "closed" keyword. That's when the opp closed.
 *   - event before that transition → 'open'
 *   - event at or after            → 'closed'
 *   - no closed transition in history but opp IS closed today → 'unknown'
 *     (likely the close happened before retention window)
 */
function wasOpenAt(history, eventDate) {
  if (!history || history.length === 0) return 'unknown';
  const closedKeywords = ['closed', 'won', 'lost', 'cancelled', 'canceled'];
  for (const h of history) {
    const newStage = String(h.NewValue || '').toLowerCase();
    const isCloseTransition = closedKeywords.some((k) => newStage.includes(k));
    if (isCloseTransition) {
      const closedAt = new Date(h.CreatedDate);
      return eventDate < closedAt ? 'open' : 'closed';
    }
  }
  return 'unknown';
}

/**
 * Split an array into chunks of at most `size`.
 */
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Defensively normalize a classification: ensure SE Task Type is valid, CF/CR consistent.
 */
function normalizeClassification(c) {
  const entry = TAXONOMY_BY_VALUE[c.seTaskType];
  if (!entry) {
    // Fall back to Admin if model returned an unknown picklist value
    return {
      ...c,
      seTaskType: 'Admin',
      isCF: false,
      isCR: false,
      reasoning: `${c.reasoning || ''} [normalized: unknown task type "${c.seTaskType}"]`.trim(),
    };
  }
  // If externalAttendeeOverride is true, keep the model's CF=true even if taxonomy says false.
  // Otherwise enforce CF/CR from taxonomy.
  const isCF = c.externalAttendeeOverride ? true : entry.isCF;
  const isCR = entry.isCR || c.isCR;
  return {
    ...c,
    isCF,
    isCR,
  };
}
