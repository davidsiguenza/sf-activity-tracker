// Calendar fetch via `claude -p` + Google MCP — slow but zero local setup.
// Used when the Google Calendar API direct path is not configured.

import { runJson } from './claude.js';

const FETCH_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'summary', 'start', 'end'],
    properties: {
      id: { type: 'string' },
      summary: { type: 'string' },
      start: { type: 'string', description: 'ISO 8601 start datetime' },
      end: { type: 'string', description: 'ISO 8601 end datetime' },
      durationHours: { type: 'number' },
      description: { type: 'string' },
      location: { type: 'string' },
      organizer: { type: 'string', description: 'organizer email' },
      isOrganizer: { type: 'boolean' },
      rsvpStatus: {
        type: 'string',
        enum: ['accepted', 'declined', 'tentative', 'needsAction', 'unknown', 'organizer'],
      },
      colorId: { type: 'string' },
      attendees: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            displayName: { type: 'string' },
            responseStatus: { type: 'string' },
            self: { type: 'boolean' },
          },
        },
      },
      htmlLink: { type: 'string' },
    },
  },
};

/**
 * Fetch calendar events for a date range using claude -p + Google MCP.
 */
export async function fetchEvents(fromIso, toIso, userEmail) {
  const prompt = [
    `Fetch all Google Calendar events for the user (${userEmail}) from ${fromIso} to ${toIso} inclusive.`,
    `Use the Google Calendar MCP tool (e.g. mcp__plugin_google_google__calendar_events with calendars="all" or your default calendar tool).`,
    `Include ALL events the user has access to in their primary calendar — accepted, tentative, declined, needsAction, and organized-by-user.`,
    `For each event, return:`,
    `- id (the calendar event id, NOT the iCalUID)`,
    `- summary (title)`,
    `- start, end as ISO 8601 strings in the user's local timezone (Europe/Madrid). If only date is set (all-day), use "YYYY-MM-DDT00:00:00" format.`,
    `- durationHours (decimal hours, 2 decimals)`,
    `- description (string, may be empty)`,
    `- location (string, may be empty)`,
    `- organizer (email of organizer)`,
    `- isOrganizer (true if the user is the organizer)`,
    `- rsvpStatus: the user's own response status. Use "organizer" if isOrganizer=true, else the responseStatus from the user's attendee record, else "unknown"`,
    `- colorId: the event's colorId field if present, else empty string`,
    `- attendees: array of {email, displayName, responseStatus, self}`,
    `- htmlLink: the htmlLink from the event`,
    ``,
    `Return ONLY the JSON array. Do not summarize, do not narrate.`,
    `If there are no events, return [].`,
  ].join('\n');

  const events = await runJson({
    prompt,
    schema: FETCH_SCHEMA,
    allowedTools: [
      'mcp__plugin_google_google__calendar_events',
      'mcp__plugin_google_google__calendar_list',
    ],
    timeoutMs: 300_000,
  });

  return Array.isArray(events) ? events : [];
}
