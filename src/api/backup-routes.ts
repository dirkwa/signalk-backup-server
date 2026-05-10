/**
 * Backup and Restore API routes
 *
 * Provides endpoints for:
 * - Listing, creating, and deleting backups
 * - Downloading backups as ZIP files
 * - Uploading and restoring from ZIP files
 * - Scheduler control
 * - Storage statistics
 *
 * IMPORTANT: Route order matters! Specific routes (like /scheduler, /storage)
 * must be defined BEFORE parameterized routes (like /:id) to avoid conflicts.
 */

import { type Request, type Response } from 'express';
import { createReadStream, unlinkSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import multer from 'multer';

import { config } from '../config/index.js';
import { backupService } from '../services/backup-service.js';
import { backupScheduler } from '../services/backup-scheduler.js';
import { cloudSyncService } from '../services/cloud-sync-service.js';
import { settingsService } from '../services/settings-service.js';
import { restoreService, type RestoreProgress } from '../services/restore-service.js';
import { logger } from '../services/logger.js';
import { createApiRouter } from './openapi-registry.js';
import {
  createBackupSchema,
  backupIdParamSchema,
  estimateQuerySchema,
  changePasswordSchema,
} from '../schemas/index.js';
import type { ApiResponse } from '../types/api.js';
import type {
  BackupMetadata,
  BackupRequest,
  BackupResult,
  SchedulerStatus,
  StorageStats,
  CleanupResult,
  BackupSizeEstimate,
  UploadResult,
  RepositoryStats,
} from '../types/backup.js';

const api = createApiRouter('Backups');

// Configure multer for file uploads
const upload = multer({
  dest: join(config.dataDir, '.tmp', 'uploads'),
  limits: {
    fileSize: config.maxUploadSize,
  },
  fileFilter: (_req, file, cb) => {
    // Only accept ZIP files
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

// =============================================================================
// SPECIFIC ROUTES (must come before parameterized routes like /:id)
// =============================================================================

/**
 * GET /api/backups
 * List all backups
 */
api.get(
  '/',
  {
    summary: 'List all backups',
    description: 'Returns all backups grouped by type (hourly, daily, weekly, startup, manual).',
    responses: {
      200: { description: 'List of backups grouped by type' },
      500: { description: 'Failed to list backups' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const backups = await backupService.listBackups();

      // Group by type for easier UI display
      const grouped = {
        hourly: backups.filter((b) => b.type === 'hourly'),
        daily: backups.filter((b) => b.type === 'daily'),
        weekly: backups.filter((b) => b.type === 'weekly'),
        startup: backups.filter((b) => b.type === 'startup'),
        manual: backups.filter((b) => b.type === 'manual'),
        other: backups.filter(
          (b) => !['hourly', 'daily', 'weekly', 'startup', 'manual'].includes(b.type)
        ),
      };

      const response: ApiResponse<{ backups: BackupMetadata[]; grouped: typeof grouped }> = {
        success: true,
        data: { backups, grouped },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to list backups');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'LIST_BACKUPS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups
 * Create a new backup
 */
api.post(
  '/',
  {
    summary: 'Create a new backup',
    description:
      'Creates a new backup with the specified options. Defaults to a manual backup type.',
    body: createBackupSchema,
    responses: {
      201: { description: 'Backup created successfully' },
      500: { description: 'Failed to create backup' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const request: BackupRequest = {
        description: req.body.description,
        type: req.body.type ?? 'manual',
        includePlugins: req.body.includePlugins ?? false,
        includePluginData: req.body.includePluginData ?? false,
        includeHistory: req.body.includeHistory,
      };

      const result = await backupService.createBackup(request);

      if (!result.success) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'CREATE_BACKUP_FAILED',
            message: result.error ?? 'Unknown error',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(500).json(response);
        return;
      }

      const response: ApiResponse<BackupResult> = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };

      res.status(201).json(response);

      // Trigger cloud sync in background if configured for after_backup
      cloudSyncService.onBackupComplete().catch(() => {});
    } catch (error) {
      logger.error({ error }, 'Failed to create backup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'CREATE_BACKUP_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/upload
 * Upload a backup ZIP file
 */
api.post(
  '/upload',
  {
    summary: 'Upload a backup ZIP file',
    description:
      'Upload a ZIP file to import as a backup. Optionally trigger an immediate restore.',
    responses: {
      201: { description: 'Backup uploaded and imported successfully' },
      400: { description: 'No file uploaded or import failed' },
      500: { description: 'Upload error' },
    },
  },
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'NO_FILE',
            message: 'No file uploaded',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      const description = req.body.description;
      const restoreImmediately = req.body.restoreImmediately === 'true';

      // Import the backup
      const result = await backupService.importFromZip(req.file.path, description);

      // Clean up uploaded file
      try {
        unlinkSync(req.file.path);
      } catch {
        // Ignore cleanup errors
      }

      if (!result.success) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'IMPORT_FAILED',
            message: result.error ?? 'Unknown error',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      const uploadResult: UploadResult = {
        success: true,
        backup: result.backup,
        restoreStatus: restoreImmediately ? 'preparing' : undefined,
      };

      const response: ApiResponse<UploadResult> = {
        success: true,
        data: uploadResult,
        timestamp: new Date().toISOString(),
      };

      res.status(201).json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to upload backup');

      // Clean up uploaded file on error
      if (req.file) {
        try {
          unlinkSync(req.file.path);
        } catch {
          // Ignore cleanup errors
        }
      }

      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'UPLOAD_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/scheduler
 * Get scheduler status
 */
api.get(
  '/scheduler',
  {
    summary: 'Get scheduler status',
    description: 'Returns the current status of the backup scheduler.',
    responses: {
      200: { description: 'Scheduler status' },
      500: { description: 'Failed to get scheduler status' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const status = await backupScheduler.getStatus();

      const response: ApiResponse<SchedulerStatus> = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get scheduler status');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'SCHEDULER_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/scheduler/start
 * Start the backup scheduler
 */
api.post(
  '/scheduler/start',
  {
    summary: 'Start the backup scheduler',
    description: 'Starts the backup scheduler and persists the enabled setting.',
    responses: {
      200: { description: 'Scheduler started' },
      500: { description: 'Failed to start scheduler' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      await backupScheduler.start();

      // Persist the setting
      await settingsService.setSetting('backupsEnabled', true);

      const response: ApiResponse<{ enabled: boolean }> = {
        success: true,
        data: { enabled: true },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to start scheduler');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'SCHEDULER_START_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/scheduler/stop
 * Stop the backup scheduler
 */
api.post(
  '/scheduler/stop',
  {
    summary: 'Stop the backup scheduler',
    description: 'Stops the backup scheduler and persists the disabled setting.',
    responses: {
      200: { description: 'Scheduler stopped' },
      500: { description: 'Failed to stop scheduler' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      backupScheduler.stop();

      // Persist the setting
      await settingsService.setSetting('backupsEnabled', false);

      const response: ApiResponse<{ enabled: boolean }> = {
        success: true,
        data: { enabled: false },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to stop scheduler');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'SCHEDULER_STOP_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/storage
 * Get storage statistics
 */
api.get(
  '/storage',
  {
    summary: 'Get storage statistics',
    description: 'Returns storage usage statistics for backups.',
    responses: {
      200: { description: 'Storage statistics' },
      500: { description: 'Failed to get storage stats' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const stats = await backupService.getStorageStats();

      const response: ApiResponse<StorageStats> = {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get storage stats');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'STORAGE_STATS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/cleanup
 * Trigger manual cleanup (enforce retention policy)
 */
api.post(
  '/cleanup',
  {
    summary: 'Trigger manual cleanup',
    description: 'Enforces the backup retention policy, removing expired backups.',
    responses: {
      200: { description: 'Cleanup result with details of removed backups' },
      500: { description: 'Failed to run cleanup' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const result = await backupService.enforceRetention();

      const response: ApiResponse<CleanupResult> = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to run cleanup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'CLEANUP_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/estimate
 * Get backup size estimate
 */
api.get(
  '/estimate',
  {
    summary: 'Get backup size estimate',
    description:
      'Estimates the backup size based on the selected options (plugins, plugin data, history).',
    query: estimateQuerySchema,
    responses: {
      200: { description: 'Backup size estimate' },
      500: { description: 'Failed to estimate backup size' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const includePlugins = req.query.includePlugins === 'true';
      const includePluginData = req.query.includePluginData === 'true';
      const includeHistory = req.query.includeHistory === 'true';

      const estimate = await backupService.calculateBackupSize({
        includePlugins,
        includePluginData,
        includeHistory,
      });

      const response: ApiResponse<BackupSizeEstimate> = {
        success: true,
        data: estimate,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to estimate backup size');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'ESTIMATE_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/restore/status
 * Get current restore operation status
 */
api.get(
  '/restore/status',
  {
    summary: 'Get current restore operation status',
    description:
      'Returns the current state and progress of any in-progress or recently completed restore operation.',
    responses: {
      200: { description: 'Restore progress status' },
    },
  },
  async (_req: Request, res: Response) => {
    const progress = restoreService.getProgress();

    if (!progress) {
      const response: ApiResponse<RestoreProgress> = {
        success: true,
        data: {
          state: 'idle',
          progress: 0,
          statusMessage: 'No restore in progress',
        },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
      return;
    }

    const response: ApiResponse<RestoreProgress> = {
      success: true,
      data: progress,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

/**
 * GET /api/backups/restore/stream
 * SSE endpoint for real-time restore progress updates
 */
api.get(
  '/restore/stream',
  {
    summary: 'Stream restore progress via SSE',
    description:
      'Server-Sent Events endpoint for real-time restore progress updates. Polls every 500ms and closes automatically when the restore completes, fails, or is rolled back.',
    responses: {
      200: {
        description: 'SSE stream of restore progress events',
        content: {
          'text/event-stream': {},
        },
      },
    },
  },
  async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial status
    const initial = restoreService.getProgress();
    res.write(
      `data: ${JSON.stringify(initial || { state: 'idle', progress: 0, statusMessage: 'No restore in progress' })}\n\n`
    );

    // Poll for updates every 500ms
    const intervalId = setInterval(() => {
      const progress = restoreService.getProgress();
      if (progress) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);

        // If restore is complete (success or failure), send final update and close
        if (
          progress.state === 'completed' ||
          progress.state === 'failed' ||
          progress.state === 'rolled_back'
        ) {
          clearInterval(intervalId);
          res.write(`data: ${JSON.stringify({ ...progress, done: true })}\n\n`);
          res.end();
        }
      }
    }, 500);

    // Clean up on client disconnect
    res.on('close', () => {
      clearInterval(intervalId);
    });
  }
);

/**
 * POST /api/backups/restore/reset
 * Reset the restore state machine (useful after failed/completed restore)
 */
api.post(
  '/restore/reset',
  {
    summary: 'Reset restore state',
    description:
      'Resets the restore state machine. Useful after a failed or completed restore operation to allow starting a new one.',
    responses: {
      200: { description: 'Restore state reset successfully' },
    },
  },
  async (_req: Request, res: Response) => {
    restoreService.reset();

    const response: ApiResponse<{ message: string }> = {
      success: true,
      data: { message: 'Restore state reset' },
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

/**
 * GET /api/backups/restore/pending
 * Returns the post-restore pending-action notification, if any.
 *
 * After a restore completes, the engine writes a marker file at
 * `${DATA_DIR}/restore-pending` with a JSONL log of actions the user must
 * take manually (npm install, restart SignalK). The signalk-backup plugin
 * — running outside the container — does this work; the plugin's UI polls
 * this route to surface a banner. Returns `null` when no marker exists.
 */
api.get(
  '/restore/pending',
  {
    summary: 'Get pending post-restore action notification',
    description:
      'Returns the contents of the restore-pending marker file (a JSONL log of actions the user/plugin should take after the restore), or null if no marker is present. The plugin UI polls this and shows a banner when set.',
    responses: {
      200: { description: 'Pending notification (or null)' },
    },
  },
  async (_req: Request, res: Response) => {
    const content = await restoreService.getPendingRestoreNotification();
    const response: ApiResponse<{ notification: string | null }> = {
      success: true,
      data: { notification: content },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * GET /api/backups/repository
 * Get Kopia repository statistics (dedup savings, compression, etc.)
 */
api.get(
  '/repository',
  {
    summary: 'Get repository statistics',
    description:
      'Returns Kopia repository statistics including deduplication savings, compression ratios, and storage efficiency.',
    responses: {
      200: { description: 'Repository statistics' },
      500: { description: 'Failed to get repository stats' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const stats = await backupService.getRepositoryStats();

      const response: ApiResponse<RepositoryStats> = {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get repository stats');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'REPOSITORY_STATS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/data-dirs
 * List top-level directories in the SignalK data directory with sizes and exclusion status.
 */
api.get(
  '/data-dirs',
  {
    summary: 'List data directories',
    description:
      'Returns top-level directories in the SignalK data directory with their sizes and whether they are excluded from backups.',
    responses: {
      200: { description: 'Directory listing with sizes and exclusion status' },
      500: { description: 'Failed to list directories' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const dirs = await backupService.getDataDirectories();

      const response: ApiResponse<typeof dirs> = {
        success: true,
        data: dirs,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to list data directories');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'DATA_DIRS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/plugin-data-dirs
 * List the per-plugin subdirectories under plugin-config-data with sizes
 * and whether they are auto-excluded (live DB state, or our own state).
 * Used by the UI to render the "Plugin state" section of the exclusions
 * panel separately from the top-level dirs.
 */
api.get(
  '/plugin-data-dirs',
  {
    summary: 'List plugin-config-data subdirectories',
    description:
      'Returns each plugin subdirectory under plugin-config-data, including auto-excluded state for live database plugins (signalk-questdb, signalk-grafana, signalk-influxdb*, signalk-history*) and our own state (signalk-backup).',
    responses: {
      200: { description: 'Plugin data directories with sizes and lock state' },
      500: { description: 'Failed to list plugin data directories' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const dirs = await backupService.getPluginDataDirectories();
      const response: ApiResponse<typeof dirs> = {
        success: true,
        data: dirs,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to list plugin data directories');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'PLUGIN_DATA_DIRS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/exclusions
 * Get the current backup exclusion patterns.
 */
api.get(
  '/exclusions',
  {
    summary: 'Get backup exclusions',
    description: 'Returns the list of directory patterns excluded from backups.',
    responses: {
      200: { description: 'Current exclusion patterns' },
    },
  },
  async (_req: Request, res: Response) => {
    const exclusions = await backupService.getExclusions();

    const response: ApiResponse<{ exclusions: string[] }> = {
      success: true,
      data: { exclusions },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * PUT /api/backups/exclusions
 * Update the backup exclusion patterns.
 */
api.put(
  '/exclusions',
  {
    summary: 'Update backup exclusions',
    description:
      'Sets the list of directory patterns to exclude from backups. Patterns are relative to the SignalK data directory.',
    responses: {
      200: { description: 'Exclusions updated' },
      400: { description: 'Invalid request body' },
    },
  },
  async (req: Request, res: Response) => {
    const { exclusions } = req.body as { exclusions?: string[] };

    if (!Array.isArray(exclusions)) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'exclusions must be an array of strings',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(400).json(response);
      return;
    }

    await backupService.setExclusions(exclusions);

    const response: ApiResponse<{ exclusions: string[] }> = {
      success: true,
      data: { exclusions: await backupService.getExclusions() },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * GET /api/backups/password
 * Get backup password status and the actual recovery password.
 * The password is always returned so users can note it for disaster recovery.
 */
api.get(
  '/password',
  {
    summary: 'Get backup password',
    description:
      'Returns the current backup password and whether it is custom or default. The password is always visible for disaster recovery purposes (e.g., restoring from cloud backup on a new device).',
    responses: {
      200: { description: 'Password info' },
      500: { description: 'Failed to get password' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const hasCustomPassword = await settingsService.hasCustomPassword();
      const password = await settingsService.getKopiaPassword();

      const response: ApiResponse<{ hasCustomPassword: boolean; password: string }> = {
        success: true,
        data: { hasCustomPassword, password },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get password');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'PASSWORD_STATUS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * PUT /api/backups/password
 * Change the backup password.
 * WARNING: Requires re-creating the Kopia repository (existing backups are lost).
 */
api.put(
  '/password',
  {
    summary: 'Change backup password',
    description:
      'Set a custom backup password. WARNING: Requires re-creating the Kopia repository, which means existing backups are lost.',
    body: changePasswordSchema,
    responses: {
      200: { description: 'Password changed successfully' },
      400: { description: 'Password mismatch' },
      500: { description: 'Failed to change password' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const { password, confirmPassword } = req.body;

      if (password !== confirmPassword) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'PASSWORD_MISMATCH',
            message: 'Password and confirmation do not match',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      await settingsService.setBackupPassword(password);

      const response: ApiResponse<{ hasCustomPassword: boolean; message: string }> = {
        success: true,
        data: {
          hasCustomPassword: true,
          message:
            'Password changed. Repository will be re-created on next backup service restart.',
        },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to change password');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'CHANGE_PASSWORD_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * DELETE /api/backups/password
 * Reset to default backup password.
 * WARNING: Requires re-creating the Kopia repository (existing backups are lost).
 */
api.delete(
  '/password',
  {
    summary: 'Reset backup password to default',
    description:
      'Resets the backup password to the default value. WARNING: Requires re-creating the Kopia repository, which means existing backups are lost.',
    responses: {
      200: { description: 'Password reset to default' },
      500: { description: 'Failed to reset password' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      await settingsService.resetBackupPassword();

      const response: ApiResponse<{ hasCustomPassword: boolean; message: string }> = {
        success: true,
        data: {
          hasCustomPassword: false,
          message:
            'Password reset to default. Repository will be re-created on next backup service restart.',
        },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to reset password');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'RESET_PASSWORD_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// =============================================================================
// PARAMETERIZED ROUTES (must come after specific routes)
// =============================================================================

/**
 * GET /api/backups/:id
 * Get backup details
 */
api.get(
  '/:id',
  {
    summary: 'Get backup details',
    description: 'Returns detailed metadata for a specific backup by its ID.',
    params: backupIdParamSchema,
    responses: {
      200: { description: 'Backup metadata' },
      404: { description: 'Backup not found' },
      500: { description: 'Failed to get backup' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const backupId = req.params.id as string; // Validated by Zod
      const backup = await backupService.getBackup(backupId);

      if (!backup) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'BACKUP_NOT_FOUND',
            message: `Backup with ID '${backupId}' not found`,
          },
          timestamp: new Date().toISOString(),
        };
        res.status(404).json(response);
        return;
      }

      const response: ApiResponse<BackupMetadata> = {
        success: true,
        data: backup,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error, backupId: req.params.id as string }, 'Failed to get backup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'GET_BACKUP_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/backups/:id/download
 * Download backup as ZIP file
 */
api.get(
  '/:id/download',
  {
    summary: 'Download backup as ZIP',
    description: 'Creates and downloads a ZIP file containing the specified backup.',
    params: backupIdParamSchema,
    responses: {
      200: {
        description: 'Backup ZIP file',
        content: {
          'application/zip': {},
        },
      },
      404: { description: 'Backup not found' },
      500: { description: 'Failed to download backup' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const backupId = req.params.id as string; // Validated by Zod
      const backup = await backupService.getBackup(backupId);

      if (!backup) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'BACKUP_NOT_FOUND',
            message: `Backup with ID '${backupId}' not found`,
          },
          timestamp: new Date().toISOString(),
        };
        res.status(404).json(response);
        return;
      }

      // Create ZIP file
      const zipDir = join(config.dataDir, '.tmp', 'downloads');
      await mkdir(zipDir, { recursive: true });
      const zipPath = join(zipDir, `${backup.id}.zip`);

      const success = await backupService.createZipFromBackup(backupId, zipPath);

      if (!success) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'ZIP_CREATION_FAILED',
            message: 'Failed to create ZIP file',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(500).json(response);
        return;
      }

      // Format filename for download
      const date = new Date(backup.createdAt).toISOString().split('T')[0];
      const filename = `signalk-backup-${date}-${backup.type}.zip`;

      // Send file
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const stream = createReadStream(zipPath);
      stream.pipe(res);

      // Clean up ZIP after download
      stream.on('end', () => {
        try {
          unlinkSync(zipPath);
        } catch {
          // Ignore cleanup errors
        }
      });
    } catch (error) {
      logger.error({ error, backupId: req.params.id as string }, 'Failed to download backup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'DOWNLOAD_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * DELETE /api/backups/:id
 * Delete a backup
 */
api.delete(
  '/:id',
  {
    summary: 'Delete a backup',
    description: 'Permanently deletes the specified backup by its ID.',
    params: backupIdParamSchema,
    responses: {
      200: { description: 'Backup deleted successfully' },
      404: { description: 'Backup not found' },
      500: { description: 'Failed to delete backup' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const backupId = req.params.id as string; // Validated by Zod
      const success = await backupService.deleteBackup(backupId);

      if (!success) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'BACKUP_NOT_FOUND',
            message: `Backup with ID '${backupId}' not found`,
          },
          timestamp: new Date().toISOString(),
        };
        res.status(404).json(response);
        return;
      }

      const response: ApiResponse<{ deleted: boolean }> = {
        success: true,
        data: { deleted: true },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error, backupId: req.params.id as string }, 'Failed to delete backup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'DELETE_BACKUP_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/:id/restore
 * Start restore operation
 */
api.post(
  '/:id/restore',
  {
    summary: 'Start restore operation',
    description:
      'Initiates a restore from the specified backup. The restore runs asynchronously; use GET /api/backups/restore/status or the SSE stream to monitor progress.',
    params: backupIdParamSchema,
    responses: {
      202: { description: 'Restore operation started' },
      400: { description: 'Backup verification failed' },
      404: { description: 'Backup not found' },
      409: { description: 'A restore operation is already in progress' },
      500: { description: 'Failed to start restore' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const backupId = req.params.id as string; // Validated by Zod
      const backup = await backupService.getBackup(backupId);

      if (!backup) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'BACKUP_NOT_FOUND',
            message: `Backup with ID '${backupId}' not found`,
          },
          timestamp: new Date().toISOString(),
        };
        res.status(404).json(response);
        return;
      }

      // Verify backup integrity
      const verification = await backupService.verifyBackup(backupId);
      if (!verification.valid) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'BACKUP_INVALID',
            message: verification.error ?? 'Backup verification failed',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      // Check if a restore is already in progress
      if (restoreService.isRestoring()) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'RESTORE_IN_PROGRESS',
            message: 'A restore operation is already in progress',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(409).json(response);
        return;
      }

      // Start restore operation asynchronously
      // The restore runs in the background; client can poll /restore/progress for updates
      restoreService.restore(backupId).then((result) => {
        if (!result.success) {
          logger.error({ backupId, error: result.error }, 'Restore operation failed');
        } else {
          logger.info({ backupId, duration: result.duration }, 'Restore operation completed');
        }
      });

      const response: ApiResponse<{ backupId: string; status: string; message: string }> = {
        success: true,
        data: {
          backupId,
          status: 'preparing',
          message: 'Restore operation started. Use GET /api/backups/restore/progress to monitor.',
        },
        timestamp: new Date().toISOString(),
      };

      res.status(202).json(response);
    } catch (error) {
      logger.error({ error, backupId: req.params.id as string }, 'Failed to start restore');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'RESTORE_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/backups/:id/verify
 * Verify backup integrity
 */
api.post(
  '/:id/verify',
  {
    summary: 'Verify backup integrity',
    description: 'Verifies the integrity of a specific backup and reports whether it is valid.',
    params: backupIdParamSchema,
    responses: {
      200: { description: 'Verification result' },
      500: { description: 'Failed to verify backup' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const backupId = req.params.id as string; // Validated by Zod
      const result = await backupService.verifyBackup(backupId);

      const response: ApiResponse<{ valid: boolean; error?: string }> = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error, backupId: req.params.id as string }, 'Failed to verify backup');
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'VERIFY_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

export const backupRouter = api.router;
