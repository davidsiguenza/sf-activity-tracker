// Orchestrates the analyze flow: fetch calendar → fetch DCs → de-dupe check → classify.

import { fetchEvents } from './calendar.js';
import { query } from './salesforce.js';
import { runJson } from './claude.js';
import { buildMatchSystemPrompt, buildMatchUserPrompt, TAXONOMY_BY_VALUE } from '../lib/prompts.js';
import { MATCH_SCHEMA } from '../lib/schemas.js';

/**
 * Fetch the SE's active Deal Contributions with related Opportunity + Account info.
 */
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
  return records.map((r) => ({
    dcId: r.Id,
    opportunityId: r.Opportunity__c,
    opportunityName: r.Opportunity__r?.Name || '',
    opportunityIsClosed: !!r.Opportunity__r?.IsClosed,
    opportunityCloseDate: r.Opportunity__r?.CloseDate || null,
    accountId: r.Opportunity__r?.AccountId || null,
    accountName: r.Opportunity__r?.Account?.Name || '',
    accountParentName: r.Opportunity__r?.Account?.Parent?.Name || '',
    splitPercentage: r.Split_Percentage__c ?? null,
  }));
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
 */
export async function analyze({ fromIso, toIso, config, forceRefresh = false }) {
  const errors = [];
  let calendarMeta = { fromCache: false, fetchedAt: null, backend: null };

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
    };
  }

  // 8) Build the slimmed-down event payload sent to Claude (no big htmlLinks etc.)
  const slimEvents = needsClassification.map((e) => ({
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
  let classifications = [];
  try {
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

    classifications = batchResults.flat().map((c) => normalizeClassification(c));
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

  return {
    events: enrichedEvents,
    dcOpportunities,
    classifications: allClassifications,
    errors,
    calendarMeta,
  };
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
