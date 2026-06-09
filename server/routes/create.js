import { load } from '../lib/config-store.js';
import { createRecord, query } from '../services/salesforce.js';
import * as overrides from '../services/overrides-store.js';

const SE_RECORD_TYPE_ID = '01230000001GgBYAA0'; // Solutions Event

/**
 * POST /api/create
 * Body: { approved: [{ eventId, subject, startUtc, endUtc, whatId, seTaskType, isCF, isCR, createDc?, dcOpportunityId?, splitPercentage? }] }
 *
 * Streams progress as Server-Sent Events.
 */
export async function post({ body, req, res }) {
  const cfg = load();
  if (!cfg || !cfg.seUserId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Setup not complete' }));
  }
  const approved = body?.approved;
  if (!Array.isArray(approved) || approved.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'approved array required' }));
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Phase 1 — DCs first (idempotent)
  send('phase', { name: 'dcs', total: approved.filter((a) => a.createDc).length });

  const dcsCreated = [];
  const dcsSkipped = [];
  const dcsByOppId = new Map(); // oppId → already-checked DC info

  for (const item of approved) {
    if (!item.createDc || !item.dcOpportunityId) continue;
    try {
      // Re-check existence: idempotency guard
      let cached = dcsByOppId.get(item.dcOpportunityId);
      if (!cached) {
        const existing = await query(
          `SELECT Id, Split_Percentage__c FROM Deal_Contribution__c
           WHERE Opportunity__c = '${item.dcOpportunityId}'
             AND SE_Name__c = '${cfg.seUserId}'
             AND IsDeleted = FALSE
           LIMIT 1`
        );
        cached = existing[0] || null;
        dcsByOppId.set(item.dcOpportunityId, cached);
      }
      if (cached && (cached.Split_Percentage__c || 0) > 0) {
        dcsSkipped.push({ oppId: item.dcOpportunityId, reason: 'already exists with split > 0' });
        send('dc-skipped', { oppId: item.dcOpportunityId, eventId: item.eventId });
        continue;
      }
      const dcId = await createRecord('Deal_Contribution__c', {
        Opportunity__c: item.dcOpportunityId,
        SE_Name__c: cfg.seUserId,
        Opportunity_Role__c: cfg.seOpportunityRole || 'Core SE',
        Split_Percentage__c: item.splitPercentage || 100,
      });
      dcsCreated.push({ id: dcId, oppId: item.dcOpportunityId });
      send('dc-created', { dcId, oppId: item.dcOpportunityId, eventId: item.eventId });
      dcsByOppId.set(item.dcOpportunityId, { Id: dcId, Split_Percentage__c: item.splitPercentage || 100 });
    } catch (e) {
      send('dc-error', { eventId: item.eventId, error: e.message });
    }
  }

  // Phase 2 — Events
  send('phase', { name: 'events', total: approved.length });

  const eventsCreated = [];
  const eventsFailed = [];

  for (const item of approved) {
    try {
      const fields = {
        RecordTypeId: SE_RECORD_TYPE_ID,
        OwnerId: cfg.seUserId,
        Subject: item.subject,
        StartDateTime: item.startUtc,
        EndDateTime: item.endUtc,
        SE_Task_Type__c: item.seTaskType,
      };
      if (item.whatId) fields.WhatId = item.whatId;

      const eventId = await createRecord('Event', fields);
      eventsCreated.push({ id: eventId, eventId: item.eventId, subject: item.subject });
      // Successful create → drop the user override for this event (no longer needed,
      // and on next analyze the event will show as already-logged anyway).
      try { overrides.clearOverride(item.eventId); } catch {}
      send('event-created', { sfEventId: eventId, eventId: item.eventId, subject: item.subject });
    } catch (e) {
      eventsFailed.push({ eventId: item.eventId, error: e.message, subject: item.subject });
      send('event-error', { eventId: item.eventId, error: e.message, subject: item.subject });
    }
  }

  send('done', {
    dcsCreated: dcsCreated.length,
    dcsSkipped: dcsSkipped.length,
    eventsCreated: eventsCreated.length,
    eventsFailed: eventsFailed.length,
    failures: eventsFailed,
  });

  res.end();
}
