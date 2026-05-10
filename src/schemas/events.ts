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
