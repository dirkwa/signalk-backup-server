import { EventEmitter } from 'events';
import type { BackupCompletedEventType } from '../schemas/events.js';

export type BackupEventMap = {
  'backup-completed': [BackupCompletedEventType];
};

// Single-producer (scheduler), N consumers (SSE subscribers + tests); no buffering of past events.
export const backupEvents = new EventEmitter<BackupEventMap>();

// WHY 50: parallel test suites occasionally spin up several subscribers — silences the warning.
backupEvents.setMaxListeners(50);
