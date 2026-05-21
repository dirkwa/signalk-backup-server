/**
 * SSE Event Schemas
 *
 * TypeBox schemas for Server-Sent Events payloads.
 * Used for both runtime validation and AsyncAPI documentation.
 *
 * keeper had many SSE event types (pull/switch/upgrade/update/doctor/prepare).
 * In signalk-backup-server only the restore stream remains.
 */

import { Type, type Static } from '@sinclair/typebox';

/**
 * Restore progress event
 */
const RestoreStep = Type.Union([
  Type.Literal('starting'),
  Type.Literal('stopping'),
  Type.Literal('extracting'),
  Type.Literal('restoring'),
  Type.Literal('starting_server'),
  Type.Literal('complete'),
  Type.Literal('error'),
]);

/**
 * Schema for backup restore progress SSE events
 * Endpoint: GET /api/backups/restore/stream
 */
export const RestoreProgressEvent = Type.Object(
  {
    step: RestoreStep,
    message: Type.String({ description: 'Progress message' }),
    percent: Type.Optional(Type.Number({ description: 'Progress percentage' })),
    backupId: Type.Optional(Type.String({ description: 'Backup being restored' })),
  },
  {
    $id: 'RestoreProgressEvent',
    description: 'SSE event for backup restore progress',
  }
);
export type RestoreProgressEventType = Static<typeof RestoreProgressEvent>;

// One event per scheduled tick; carries everything the plugin needs for issue #33 deltas.
const BackupTier = Type.Union([
  Type.Literal('hourly'),
  Type.Literal('daily'),
  Type.Literal('weekly'),
  Type.Literal('startup'),
]);

const RunOutcome = Type.Union([Type.Literal('success'), Type.Literal('failure')]);

const CloudOutcome = Type.Union([
  Type.Literal('success'),
  Type.Literal('failure'),
  Type.Literal('skipped'),
]);

const CloudTarget = Type.Union([
  Type.Literal('gdrive'),
  Type.Literal('smb'),
  Type.Literal('local'),
]);

export const BackupCompletedEvent = Type.Object(
  {
    type: Type.Literal('backup-completed'),
    tier: BackupTier,
    timestamp: Type.String({
      format: 'date-time',
      description: 'ISO timestamp of when the run started',
    }),
    localResult: RunOutcome,
    localError: Type.Optional(Type.String()),
    localBytes: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Snapshot size in bytes (success only)' })
    ),
    backupId: Type.Optional(Type.String({ description: 'Kopia snapshot id (success only)' })),
    cloudResult: Type.Optional(CloudOutcome),
    cloudError: Type.Optional(Type.String()),
    cloudTarget: Type.Optional(CloudTarget),
    freeBytes: Type.Integer({
      minimum: 0,
      description: 'Free bytes on the Kopia repo filesystem',
    }),
    totalBytes: Type.Integer({
      minimum: 0,
      description: 'Total bytes on the Kopia repo filesystem',
    }),
    nextScheduled: Type.Object(
      {
        hourly: Type.String({ format: 'date-time' }),
        daily: Type.String({ format: 'date-time' }),
        weekly: Type.String({ format: 'date-time' }),
      },
      { description: 'Next-scheduled ISO timestamp per tier' }
    ),
  },
  {
    $id: 'BackupCompletedEvent',
    description: 'SSE event fired once per scheduled-backup run completion',
  }
);
export type BackupCompletedEventType = Static<typeof BackupCompletedEvent>;
