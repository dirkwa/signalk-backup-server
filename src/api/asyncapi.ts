/**
 * AsyncAPI Document Generator
 *
 * Generates AsyncAPI 3.0 specification for SSE streaming endpoints.
 * TypeBox schemas are JSON Schema compatible, so they work directly with AsyncAPI.
 *
 * keeper documented many SSE streams (pull/switch/upgrade/update/doctor) that
 * are tied to features dropped in signalk-backup-server. We only keep the
 * restore-progress stream here.
 */

import { createRequire } from 'module';
import * as events from '../schemas/events.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

/**
 * AsyncAPI 3.0 Document for signalk-backup-server SSE API.
 */
export const asyncApiDocument = {
  asyncapi: '3.0.0',
  info: {
    title: 'SignalK Backup Server SSE API',
    version: packageJson.version || '0.0.1',
    description: `
Server-Sent Events (SSE) streaming API for real-time progress updates.

## Overview
This API provides real-time progress updates for long-running operations using Server-Sent Events.
SSE provides a simple, efficient way to receive push notifications from the server over HTTP.

## Connection
Connect to SSE endpoints using the EventSource API:
\`\`\`javascript
const es = new EventSource('/api/backups/restore/stream');
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
};
\`\`\`

## Event Format
All events are JSON objects sent as the \`data\` field of SSE messages.

## REST API
For the REST API documentation, see OpenAPI at \`/api/docs\`.
    `.trim(),
    contact: {
      name: 'SignalK',
      url: 'https://signalk.org',
    },
    license: {
      name: 'Apache 2.0',
      url: 'https://www.apache.org/licenses/LICENSE-2.0.html',
    },
  },
  servers: {
    production: {
      host: 'localhost:3001',
      protocol: 'http',
      description: 'signalk-backup-server (SSE over HTTP)',
    },
  },
  channels: {
    'backups/restore/stream': {
      address: '/api/backups/restore/stream',
      description: 'Stream backup restore progress via SSE.',
      messages: {
        restoreProgress: {
          name: 'RestoreProgressEvent',
          title: 'Restore Progress Event',
          summary: 'Progress update for backup restore operation',
          contentType: 'application/json',
          payload: events.RestoreProgressEvent,
        },
      },
    },
    'backups/events/stream': {
      address: '/api/backups/events/stream',
      description:
        'Stream scheduled-backup completion events via SSE. One event per scheduler tick (hourly/daily/weekly/startup) once the local snapshot and any chained cloud-sync attempt resolve.',
      messages: {
        backupCompleted: {
          name: 'BackupCompletedEvent',
          title: 'Backup Completed Event',
          summary: 'A scheduled backup run finished (success or failure)',
          contentType: 'application/json',
          payload: events.BackupCompletedEvent,
        },
      },
    },
  },
  operations: {
    receiveRestoreProgress: {
      action: 'receive',
      channel: { $ref: '#/channels/backups~1restore~1stream' },
      summary: 'Receive backup restore progress updates',
      description: 'Connect via GET request to receive backup restore progress.',
    },
    receiveBackupCompleted: {
      action: 'receive',
      channel: { $ref: '#/channels/backups~1events~1stream' },
      summary: 'Receive scheduled-backup completion events',
      description:
        'Connect via GET request to receive one event per scheduled backup run, including local + cloud outcome and filesystem free-space.',
    },
  },
  components: {
    schemas: {
      RestoreProgressEvent: events.RestoreProgressEvent,
      BackupCompletedEvent: events.BackupCompletedEvent,
    },
  },
};
