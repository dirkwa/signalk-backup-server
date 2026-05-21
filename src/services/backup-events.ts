/**
 * In-process EventEmitter for scheduled-backup run outcomes.
 *
 * The backup-scheduler emits `backup-completed` once per scheduled tick
 * (hourly/daily/weekly/startup). The SSE route at GET /api/backups/events/stream
 * subscribes here and pushes each event to connected clients.
 *
 * Single-producer (the scheduler), N consumers (any SSE subscriber + tests).
 * No buffering — late subscribers only see future events. If you need
 * historical run outcomes, list the actual backups instead.
 */

import { EventEmitter } from 'events';
import type { BackupCompletedEventType } from '../schemas/events.js';

export type BackupEventMap = {
  'backup-completed': [BackupCompletedEventType];
};

export const backupEvents = new EventEmitter<BackupEventMap>();

// Per-process default of 10 listeners is fine for a handful of SSE connections,
// but the test suite occasionally spins up several subscribers in parallel —
// raise it to avoid the MaxListenersExceededWarning noise.
backupEvents.setMaxListeners(50);
