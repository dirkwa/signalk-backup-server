/**
 * Settings API routes
 *
 * keeper exposed an `autostart` toggle that controlled SignalK container
 * startup. signalk-backup-server doesn't manage the SignalK process and
 * has no autostart concept — the routes that set autostart were removed.
 */

import { type Request, type Response } from 'express';
import { settingsService, type BackupServerSettings } from '../services/settings-service.js';
import type { ApiResponse } from '../types/index.js';
import { createApiRouter } from './openapi-registry.js';

const api = createApiRouter('Settings');

/** Keys that PUT /api/settings is allowed to update. */
const ALLOWED_UPDATE_KEYS: readonly (keyof BackupServerSettings)[] = [
  'backupsEnabled',
  'backupExclusions',
  'includeHistoryInBackups',
];

/**
 * GET /api/settings
 * Get all settings
 */
api.get(
  '/',
  {
    summary: 'Get all settings',
    description: 'Retrieve all backup-server settings',
    responses: {
      200: { description: 'Settings retrieved successfully' },
      500: { description: 'Internal server error' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const settings = await settingsService.get();

      const response: ApiResponse<BackupServerSettings> = {
        success: true,
        data: settings,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'SETTINGS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * PUT /api/settings
 * Update settings
 */
api.put(
  '/',
  {
    summary: 'Update settings',
    description: 'Update one or more backup-server settings. Only known setting keys are accepted.',
    responses: {
      200: { description: 'Settings updated successfully' },
      400: { description: 'Invalid or unknown settings keys' },
      500: { description: 'Internal server error' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const updates = req.body as Partial<BackupServerSettings>;

      const invalidKeys = Object.keys(updates).filter(
        (key) => !ALLOWED_UPDATE_KEYS.includes(key as keyof BackupServerSettings)
      );

      if (invalidKeys.length > 0) {
        const response: ApiResponse<null> = {
          success: false,
          error: {
            code: 'INVALID_SETTINGS',
            message: `Unknown or read-only settings: ${invalidKeys.join(', ')}`,
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      const settings = await settingsService.update(updates);

      const response: ApiResponse<BackupServerSettings> = {
        success: true,
        data: settings,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      const response: ApiResponse<null> = {
        success: false,
        error: {
          code: 'SETTINGS_ERROR',
          message: (error as Error).message,
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

export const settingsRouter = api.router;
