/**
 * Restore State Machine
 *
 * XState machine for managing SignalK restore operations with:
 * - Predictable state transitions
 * - Safety backup before restore
 * - Automatic rollback on failure
 * - Progress tracking
 */

import { createMachine, assign } from 'xstate';
import type { RestoreContext, RestoreEvent } from '../types/backup.js';
import { initialRestoreContext } from '../types/backup.js';

/**
 * The restore state machine definition
 *
 * States:
 * - idle: No restore in progress
 * - preparing: Validating backup, creating safety backup
 * - extracting: Extracting backup archive
 * - installing: Running npm install
 * - restarting: Restarting SignalK container
 * - verifying: Health checking the restored SignalK
 * - completed: Restore successful
 * - failed: Restore failed (can rollback from here)
 * - rolling_back: Reverting to safety backup
 * - rolled_back: Successfully reverted
 */
export const restoreMachine = createMachine({
  id: 'restore',
  initial: 'idle',
  types: {} as {
    context: RestoreContext;
    events: RestoreEvent;
  },
  context: initialRestoreContext,

  states: {
    idle: {
      on: {
        START_RESTORE: {
          target: 'preparing',
          actions: assign({
            backupId: ({ event }) => event.backupId,
            safetyBackupId: null,
            progress: 0,
            statusMessage: 'Preparing restore...',
            error: null,
            startedAt: () => new Date().toISOString(),
            completedAt: null,
          }),
        },
      },
    },

    preparing: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        SAFETY_BACKUP_CREATED: {
          actions: assign({
            safetyBackupId: ({ event }) => event.safetyBackupId,
            statusMessage: 'Safety backup created',
          }),
        },
        PREPARE_COMPLETE: {
          target: 'extracting',
          actions: assign({
            progress: 20,
            statusMessage: 'Extracting backup...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to prepare restore',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    extracting: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        EXTRACT_COMPLETE: {
          target: 'installing',
          actions: assign({
            progress: 40,
            statusMessage: 'Running npm install...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to extract backup',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    installing: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        INSTALL_COMPLETE: {
          target: 'restarting',
          actions: assign({
            progress: 60,
            statusMessage: 'Restarting SignalK...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to install dependencies',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    restarting: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        RESTART_COMPLETE: {
          target: 'verifying',
          actions: assign({
            progress: 80,
            statusMessage: 'Verifying SignalK health...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to restart SignalK',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    verifying: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        VERIFY_SUCCESS: {
          target: 'completed',
          actions: assign({
            progress: 100,
            statusMessage: 'Restore complete!',
            completedAt: () => new Date().toISOString(),
          }),
        },
        VERIFY_FAILED: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.reason,
            statusMessage: 'Health check failed after restore',
            completedAt: () => new Date().toISOString(),
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Verification failed',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    completed: {
      on: {
        RESET: {
          target: 'idle',
          actions: assign(initialRestoreContext),
        },
      },
    },

    failed: {
      on: {
        ROLLBACK: {
          target: 'rolling_back',
          actions: assign({
            statusMessage: 'Rolling back to safety backup...',
          }),
        },
        RESET: {
          target: 'idle',
          actions: assign(initialRestoreContext),
        },
      },
    },

    rolling_back: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        ROLLBACK_COMPLETE: {
          target: 'rolled_back',
          actions: assign({
            statusMessage: 'Rolled back to previous state',
            completedAt: () => new Date().toISOString(),
          }),
        },
        ERROR: {
          // Rollback failed - critical error
          target: 'failed',
          actions: assign({
            error: ({ event }) =>
              `Rollback failed: ${event.error}. Manual intervention may be required.`,
            statusMessage: 'Rollback failed - manual intervention may be required',
          }),
        },
      },
    },

    rolled_back: {
      on: {
        RESET: {
          target: 'idle',
          actions: assign(initialRestoreContext),
        },
        // Allow retrying the restore
        START_RESTORE: {
          target: 'preparing',
          actions: assign({
            backupId: ({ event }) => event.backupId,
            safetyBackupId: null,
            progress: 0,
            statusMessage: 'Preparing restore...',
            error: null,
            startedAt: () => new Date().toISOString(),
            completedAt: null,
          }),
        },
      },
    },
  },
});

export type RestoreMachine = typeof restoreMachine;
