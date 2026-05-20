// XState machine for selective (file/directory) restore. Modelled on the
// full-restore machine but without install/restart phases: a single file
// copy doesn't justify restarting SignalK, and forcing those states would
// either pollute the full machine or trip the restart UX banner for what
// is meant to be a low-impact operation.

import { createMachine, assign } from 'xstate';
import type { PartialRestoreContext, PartialRestoreEvent } from '../types/backup.js';
import { initialPartialRestoreContext } from '../types/backup.js';

export const restorePartialMachine = createMachine({
  id: 'restore-partial',
  initial: 'idle',
  types: {} as {
    context: PartialRestoreContext;
    events: PartialRestoreEvent;
  },
  context: initialPartialRestoreContext,

  states: {
    idle: {
      on: {
        START_RESTORE: {
          target: 'preparing',
          actions: assign({
            backupId: ({ event }) => event.backupId,
            sourcePath: ({ event }) => event.sourcePath,
            targetPath: ({ event }) => event.targetPath,
            safetyBackupId: null,
            progress: 0,
            statusMessage: 'Preparing partial restore...',
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
        PREPARE_COMPLETE: {
          target: 'safety_snapshotting',
          actions: assign({
            progress: 10,
            statusMessage: 'Creating safety snapshot...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to prepare partial restore',
            completedAt: () => new Date().toISOString(),
          }),
        },
      },
    },

    safety_snapshotting: {
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.progress,
            statusMessage: ({ event }) => event.statusMessage,
          }),
        },
        SAFETY_SNAPSHOT_CREATED: {
          target: 'extracting',
          actions: assign({
            safetyBackupId: ({ event }) => event.safetyBackupId,
            progress: 40,
            statusMessage: 'Restoring sub-path from snapshot...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to create safety snapshot',
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
          target: 'verifying',
          actions: assign({
            progress: 80,
            statusMessage: 'Verifying restored entry...',
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) => event.error,
            statusMessage: 'Failed to restore sub-path',
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
            statusMessage: 'Partial restore complete',
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
          actions: assign(initialPartialRestoreContext),
        },
      },
    },

    failed: {
      on: {
        ROLLBACK: {
          target: 'rolling_back',
          actions: assign({
            statusMessage: 'Rolling back partial restore...',
          }),
        },
        RESET: {
          target: 'idle',
          actions: assign(initialPartialRestoreContext),
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
            statusMessage: 'Rolled back to safety snapshot',
            completedAt: () => new Date().toISOString(),
          }),
        },
        ERROR: {
          target: 'failed',
          actions: assign({
            error: ({ event }) =>
              `Rollback failed: ${event.error}. Manual intervention may be required.`,
            statusMessage: 'Rollback failed — manual intervention may be required',
          }),
        },
      },
    },

    rolled_back: {
      on: {
        RESET: {
          target: 'idle',
          actions: assign(initialPartialRestoreContext),
        },
      },
    },
  },
});

export type RestorePartialMachine = typeof restorePartialMachine;
