// JSON schemas for claude --json-schema output validation (informational, embedded in prompt).

import { SE_TASK_TYPES } from './prompts.js';

const SE_TASK_TYPE_VALUES = SE_TASK_TYPES.map((t) => t.value);

export const MATCH_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['eventId', 'status', 'seTaskType', 'isCF', 'isCR', 'confidence', 'reasoning'],
    properties: {
      eventId: { type: 'string', description: 'matches input event id' },
      status: {
        type: 'string',
        enum: ['identified', 'flagged', 'excluded', 'skip'],
      },
      relatedTo: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['id', 'name', 'type'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: ['Opportunity', 'Account', 'Strategic_Initiative__c', 'Deal_Support_Request__c'],
              },
            },
          },
        ],
      },
      seTaskType: {
        type: 'string',
        enum: SE_TASK_TYPE_VALUES,
        description: 'MUST be one of the org62 picklist values',
      },
      isCF: { type: 'boolean' },
      isCR: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reasoning: { type: 'string' },
      externalAttendeeOverride: {
        type: 'boolean',
        description: 'true if CF was forced by external attendee rule',
      },
    },
  },
};
