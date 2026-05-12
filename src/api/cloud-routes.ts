/**
 * Cloud Backup API Routes
 *
 * Provides endpoints for:
 * - Google Drive authorization via rclone authorize
 * - Cloud sync status and manual trigger
 * - Cloud sync configuration (sync mode, frequency)
 * - Listing cloud installations (for restore)
 */

import { type Request, type Response } from 'express';

import { gdriveAuthService } from '../services/gdrive-auth-service.js';
import { cloudSyncService } from '../services/cloud-sync-service.js';
import { installIdentityService } from '../services/install-identity-service.js';
import { localFsService } from '../services/local-fs-service.js';
import { smbAuthService } from '../services/smb-auth-service.js';
import { restoreService, type RestoreProgress } from '../services/restore-service.js';
import { settingsService } from '../services/settings-service.js';
import { logger } from '../services/logger.js';
import { createApiRouter } from './openapi-registry.js';
import { smbConnectSchema, type SmbConnectBody } from '../schemas/cloud.js';
import type { ApiResponse } from '../types/api.js';

const api = createApiRouter('Cloud');

// =============================================================================
// Google Drive Authorization
// =============================================================================

/**
 * POST /api/cloud/gdrive/connect
 * Start the Google Drive authorization flow using rclone authorize.
 * Returns the auth URL that the UI should open in a new browser tab.
 */
api.post(
  '/gdrive/connect',
  {
    summary: 'Start Google Drive connection',
    description:
      'Starts rclone authorize and returns the Google OAuth URL. The UI opens this in a new browser tab. Poll /gdrive/auth-state to track authorization progress.',
    responses: {
      200: { description: 'OAuth URL for Google sign-in' },
      500: { description: 'Failed to start authorization' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const { authUrl } = await gdriveAuthService.startAuthorize();

      const response: ApiResponse<{ authUrl: string }> = {
        success: true,
        data: { authUrl },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to start Google Drive authorization');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'AUTH_START_FAILED',
          message: error instanceof Error ? error.message : 'Failed to start authorization',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/gdrive/auth-state
 * Poll for authorization progress. Returns idle/waiting/completed/failed.
 */
api.get(
  '/gdrive/auth-state',
  {
    summary: 'Get authorization progress',
    description:
      'Lightweight polling endpoint for authorization progress. Returns the current state (idle, waiting, completed, failed).',
    responses: {
      200: { description: 'Authorization state' },
    },
  },
  async (_req: Request, res: Response) => {
    const authState = gdriveAuthService.getAuthState();
    const response: ApiResponse<typeof authState> = {
      success: true,
      data: authState,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * POST /api/cloud/gdrive/cancel
 * Cancel an in-progress authorization
 */
api.post(
  '/gdrive/cancel',
  {
    summary: 'Cancel authorization',
    description: 'Cancels an in-progress Google Drive authorization and kills the rclone process.',
    responses: {
      200: { description: 'Authorization cancelled' },
    },
  },
  async (_req: Request, res: Response) => {
    gdriveAuthService.cancelAuthorize();

    const response: ApiResponse<{ message: string }> = {
      success: true,
      data: { message: 'Authorization cancelled' },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * POST /api/cloud/gdrive/auth-callback
 * Forward a Google OAuth callback URL to rclone.
 * Used when the user is accessing SignalK remotely — Google's redirect to
 * http://127.0.0.1:53682 fails because the browser is on a different machine.
 * The user pastes the failed URL and we forward it server-side to rclone.
 */
api.post(
  '/gdrive/auth-callback',
  {
    summary: 'Forward OAuth callback to rclone',
    description:
      'For remote access: forwards the Google OAuth callback URL to rclone running on the server. Used when the redirect to 127.0.0.1:53682 fails because the browser is on a different machine.',
    responses: {
      200: { description: 'Callback forwarded successfully' },
      400: { description: 'Invalid URL or no authorization in progress' },
      500: { description: 'Failed to forward callback' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const { url } = req.body as { url?: string };
      if (!url) {
        const response: ApiResponse<never> = {
          success: false,
          error: { code: 'MISSING_URL', message: 'URL is required' },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      await gdriveAuthService.forwardCallback(url);

      const response: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: 'Callback forwarded to rclone' },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to forward OAuth callback');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'CALLBACK_FAILED',
          message: error instanceof Error ? error.message : 'Failed to forward callback',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/gdrive/status
 * Get Google Drive connection status
 */
api.get(
  '/gdrive/status',
  {
    summary: 'Get Google Drive status',
    description: 'Returns whether Google Drive is connected and the associated email address.',
    responses: {
      200: { description: 'Google Drive status' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const status = await gdriveAuthService.getStatus();
      const response: ApiResponse<typeof status> = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get Google Drive status');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get status',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/cloud/gdrive/disconnect
 * Disconnect Google Drive
 */
api.post(
  '/gdrive/disconnect',
  {
    summary: 'Disconnect Google Drive',
    description: 'Removes the Google Drive connection and rclone configuration.',
    responses: {
      200: { description: 'Disconnected' },
      500: { description: 'Disconnect failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      await gdriveAuthService.disconnect();

      const response: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: 'Google Drive disconnected' },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to disconnect Google Drive');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'DISCONNECT_FAILED',
          message: error instanceof Error ? error.message : 'Disconnect failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// =============================================================================
// Local (USB / mounted folder) destination
// =============================================================================

/**
 * GET /api/cloud/local/status
 * Whether the configured local destination is reachable + writable.
 */
api.get(
  '/local/status',
  {
    summary: 'Get local destination status',
    description:
      'Returns the configured container-side path and whether it is reachable + writable.',
    responses: {
      200: { description: 'Local destination status' },
      500: { description: 'Status check failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const status = await localFsService.getStatus();
      const response: ApiResponse<typeof status> = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get local destination status');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Status check failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/local/discover
 * Walk baseline mounts (/host-media, /host-mnt) and return candidate
 * destination paths annotated with size info. UI surfaces these in a
 * dropdown so users don't have to type a path.
 */
api.get(
  '/local/discover',
  {
    summary: 'Discover local destinations',
    description:
      'Lists subdirectories of /host-media and /host-mnt (the plugin baseline mounts) as candidate backup destinations.',
    responses: {
      200: { description: 'Discovered candidates' },
      500: { description: 'Discovery failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const candidates = await localFsService.discover();
      const response: ApiResponse<{ candidates: typeof candidates }> = {
        success: true,
        data: { candidates },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to discover local destinations');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'DISCOVER_FAILED',
          message: error instanceof Error ? error.message : 'Discovery failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/cloud/local/configure
 * Set the local destination. Body: `{ containerPath, hostPath? }`.
 * The container-side path must live under one of the baseline mounts;
 * the host-side path is stored for display only.
 *
 * After persisting settings the plugin's next ensureRunning call picks
 * up the new provider, but **no container recreate is required** — the
 * baseline mounts are already there. Sync is immediately usable.
 */
api.post(
  '/local/configure',
  {
    summary: 'Configure local destination',
    description:
      'Sets the local destination path. The container-side path must be under /host-media or /host-mnt.',
    responses: {
      200: { description: 'Configured' },
      400: { description: 'Invalid path' },
      500: { description: 'Configuration failed' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { containerPath?: unknown; hostPath?: unknown };
      const containerPath = typeof body.containerPath === 'string' ? body.containerPath : '';
      const hostPath = typeof body.hostPath === 'string' ? body.hostPath : containerPath;

      const validationError = await localFsService.validate(containerPath);
      if (validationError) {
        const response: ApiResponse<never> = {
          success: false,
          error: { code: 'INVALID_PATH', message: validationError },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      const current = (await settingsService.get()).cloudSync;
      const updated = await cloudSyncService.updateConfig({
        provider: 'local',
        containerPath,
        hostPath,
        // Preserve mode/frequency from any prior config so switching
        // destinations doesn't reset the schedule.
        syncMode: current?.syncMode ?? 'manual',
        syncFrequency: current?.syncFrequency ?? 'daily',
      });

      const response: ApiResponse<typeof updated> = {
        success: true,
        data: updated,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to configure local destination');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'CONFIGURE_FAILED',
          message: error instanceof Error ? error.message : 'Configure failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/cloud/local/disconnect
 * Clear the local destination — settings.cloudSync.provider reverts
 * to gdrive (the default) but auth state for gdrive is untouched.
 */
api.post(
  '/local/disconnect',
  {
    summary: 'Clear local destination',
    description: 'Removes the local destination from settings; provider falls back to gdrive.',
    responses: {
      200: { description: 'Disconnected' },
      500: { description: 'Disconnect failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      // Revert to a vanilla gdrive cloudSync so the UI has a stable state.
      const current = (await settingsService.get()).cloudSync;
      await settingsService.update({
        cloudSync: {
          provider: 'gdrive',
          syncMode: current?.syncMode ?? 'manual',
          syncFrequency: current?.syncFrequency ?? 'daily',
          lastSync: null,
          lastSyncError: null,
        },
      });
      const response: ApiResponse<{ disconnected: boolean }> = {
        success: true,
        data: { disconnected: true },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to disconnect local destination');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'DISCONNECT_FAILED',
          message: error instanceof Error ? error.message : 'Disconnect failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// =============================================================================
// SMB share destination
// =============================================================================

/**
 * GET /api/cloud/smb/status
 * Whether the configured SMB share is connected (i.e. rclone has
 * credentials for it).
 */
api.get(
  '/smb/status',
  {
    summary: 'Get SMB share status',
    description: 'Returns the configured SMB host/share/user and whether rclone has credentials.',
    responses: {
      200: { description: 'SMB status' },
      500: { description: 'Status check failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const status = await smbAuthService.getStatus();
      const response: ApiResponse<typeof status> = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get SMB status');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Status check failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/cloud/smb/connect
 * Body: { host, share, user, password, domain? }
 * Validates the connection by listing the share with the provided creds,
 * then persists settings + writes credentials to rclone.conf. Rolls back
 * the partial config on failure so the next attempt starts clean.
 */
api.post(
  '/smb/connect',
  {
    summary: 'Connect to an SMB share',
    description:
      'Validates host/share/credentials by listing the share, then persists. SMB password is obfuscated via `rclone obscure` before being written to rclone.conf. Leave user+password empty for guest/anonymous shares.',
    body: smbConnectSchema,
    responses: {
      200: { description: 'Connected' },
      400: { description: 'Invalid input or connection test failed' },
      500: { description: 'Internal error while writing rclone config' },
    },
  },
  async (req: Request, res: Response) => {
    // The TypeBox middleware has already validated the body shape and
    // rejected missing/empty fields with a 400 — handler can rely on
    // the typed values directly.
    const body = req.body as SmbConnectBody;
    try {
      await smbAuthService.connect(body);
      const response: ApiResponse<{ connected: boolean }> = {
        success: true,
        data: { connected: true },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (err) {
      // Distinguish "user-correctable" failures (wrong creds, host
      // unreachable, INI-injection guards triggered, share missing)
      // from genuinely-internal failures (rclone.conf write failed,
      // unexpected exception). The former go back as 400 so the UI
      // can show them inline; the latter propagate as 500 with the
      // generic logger trail so we can find them later.
      if (isClientCorrectableSmbError(err)) {
        logger.debug({ err }, 'SMB connect rejected (client-correctable)');
        const response: ApiResponse<never> = {
          success: false,
          error: {
            code: 'CONNECT_FAILED',
            message: err instanceof Error ? err.message : 'connect failed',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      logger.error({ err }, 'Internal error during SMB connect');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Internal error',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// `smbAuthService.connect()` throws for several reasons. Most are the
// user's input or LAN state and the right response is 400 with the
// message surfaced to the UI. A `node:fs` error or unexpected exception
// is internal and should propagate as 500 so we don't quietly mask
// real bugs as "wrong password".
function isClientCorrectableSmbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Validation failures from assertIniSafe(): caller can fix by
  // changing input.
  if (msg.includes('contains control characters') || msg.includes('reserved for INI')) return true;
  if (msg.includes('must not contain whitespace')) return true;
  if (msg.includes("must not start with '['")) return true;
  if (msg.includes('must be a non-empty string')) return true;
  // The connect() wrapper labels its rclone-lsd timeouts and auth
  // errors with this prefix.
  if (msg.startsWith('SMB connection test failed')) return true;
  // Common rclone/node error codes for "not the server's fault" cases.
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return true;
  if (code === 'ENOTFOUND') return true;
  return false;
}

/**
 * POST /api/cloud/smb/disconnect
 * Removes the [smb] block from rclone.conf and reverts settings to
 * a vanilla gdrive blob (preserving syncMode/syncFrequency).
 */
api.post(
  '/smb/disconnect',
  {
    summary: 'Disconnect SMB share',
    description:
      'Removes SMB credentials from rclone.conf and reverts cloud-sync provider to gdrive.',
    responses: {
      200: { description: 'Disconnected' },
      500: { description: 'Disconnect failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      await smbAuthService.disconnect();
      const current = (await settingsService.get()).cloudSync;
      await settingsService.update({
        cloudSync: {
          provider: 'gdrive',
          syncMode: current?.syncMode ?? 'manual',
          syncFrequency: current?.syncFrequency ?? 'daily',
          lastSync: null,
          lastSyncError: null,
        },
      });
      const response: ApiResponse<{ disconnected: boolean }> = {
        success: true,
        data: { disconnected: true },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to disconnect SMB share');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'DISCONNECT_FAILED',
          message: error instanceof Error ? error.message : 'Disconnect failed',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// =============================================================================
// Cloud Sync
// =============================================================================

/**
 * GET /api/cloud/status
 * Get overall cloud sync status
 */
api.get(
  '/status',
  {
    summary: 'Get cloud sync status',
    description:
      'Returns the current cloud sync status including connection state, sync mode, last sync time, and any errors.',
    responses: {
      200: { description: 'Cloud sync status' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const status = await cloudSyncService.getStatus();
      const response: ApiResponse<typeof status> = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get cloud status');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get status',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * POST /api/cloud/sync
 * Trigger a manual cloud sync
 */
api.post(
  '/sync',
  {
    summary: 'Trigger cloud sync',
    description: 'Manually triggers a sync of the local Kopia repository to Google Drive.',
    responses: {
      200: { description: 'Sync started' },
      409: { description: 'Sync already in progress' },
      500: { description: 'Sync failed' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      // Start sync in background, respond immediately
      cloudSyncService.syncToCloud().catch((error) => {
        logger.error({ error }, 'Background cloud sync failed');
      });

      const response: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: 'Cloud sync started' },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      const code = message.includes('already in progress') ? 409 : 500;

      const response: ApiResponse<never> = {
        success: false,
        error: { code: 'SYNC_FAILED', message },
        timestamp: new Date().toISOString(),
      };
      res.status(code).json(response);
    }
  }
);

/**
 * POST /api/cloud/sync/cancel
 * Cancel a running cloud sync
 */
api.post(
  '/sync/cancel',
  {
    summary: 'Cancel cloud sync',
    description: 'Cancels a running cloud sync by killing the kopia process.',
    responses: {
      200: { description: 'Sync cancelled' },
      404: { description: 'No sync in progress' },
    },
  },
  async (_req: Request, res: Response) => {
    const cancelled = cloudSyncService.cancelSync();

    if (cancelled) {
      const response: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: 'Cloud sync cancelled' },
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } else {
      const response: ApiResponse<never> = {
        success: false,
        error: { code: 'NO_SYNC', message: 'No sync in progress' },
        timestamp: new Date().toISOString(),
      };
      res.status(404).json(response);
    }
  }
);

/**
 * POST /api/cloud/config
 * Update cloud sync configuration
 */
api.post(
  '/config',
  {
    summary: 'Update cloud sync configuration',
    description: 'Update the cloud sync mode (manual, after_backup, scheduled) and frequency.',
    responses: {
      200: { description: 'Configuration updated' },
      500: { description: 'Update failed' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const { syncMode, syncFrequency } = req.body as {
        syncMode?: 'manual' | 'after_backup' | 'scheduled';
        syncFrequency?: 'daily' | 'weekly';
      };

      const updated = await cloudSyncService.updateConfig({
        ...(syncMode && { syncMode }),
        ...(syncFrequency && { syncFrequency }),
      });

      const response: ApiResponse<typeof updated> = {
        success: true,
        data: updated,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to update cloud config');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'CONFIG_FAILED',
          message: error instanceof Error ? error.message : 'Failed to update config',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/installs
 * List all installations on Google Drive
 */
api.get(
  '/installs',
  {
    summary: 'List cloud installations',
    description:
      'Lists all SignalK installations found on the connected Google Drive account. Used for cloud restore.',
    responses: {
      200: { description: 'List of cloud installations' },
      500: { description: 'Failed to list installations' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const installs = await cloudSyncService.listCloudInstalls();
      const response: ApiResponse<typeof installs> = {
        success: true,
        data: installs,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to list cloud installations');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'LIST_FAILED',
          message: error instanceof Error ? error.message : 'Failed to list installations',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/identity
 * Get the current installation identity
 */
api.get(
  '/identity',
  {
    summary: 'Get installation identity',
    description:
      'Returns the identity of this SignalK installation (vessel name, hardware, folder ID).',
    responses: {
      200: { description: 'Installation identity' },
      500: { description: 'Failed to get identity' },
    },
  },
  async (_req: Request, res: Response) => {
    try {
      const identity = await installIdentityService.getOrCreateIdentity();
      const response: ApiResponse<typeof identity> = {
        success: true,
        data: identity,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to get installation identity');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'IDENTITY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get identity',
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

// =============================================================================
// Cloud Restore
// =============================================================================

/**
 * POST /api/cloud/restore/prepare
 * Sync from a cloud installation and list available snapshots
 */
api.post(
  '/restore/prepare',
  {
    summary: 'Prepare cloud restore',
    description:
      'Syncs the Kopia repository from a cloud installation to the local device, then returns available snapshots. May take several minutes for large repos.',
    responses: {
      200: { description: 'Snapshot list from cloud installation' },
      400: { description: 'Missing folder parameter' },
      409: { description: 'Sync already in progress' },
      500: { description: 'Sync failed' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const { folder, password } = req.body as {
        folder?: string;
        password?: string;
      };

      if (!folder) {
        const response: ApiResponse<never> = {
          success: false,
          error: {
            code: 'MISSING_FOLDER',
            message: 'Cloud installation folder is required',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      const result = await cloudSyncService.prepareCloudRestore(folder, password || undefined);

      if (result.phase === 'failed') {
        const response: ApiResponse<typeof result> = {
          success: false,
          data: result,
          error: {
            code: 'PREPARE_FAILED',
            message: result.error || 'Failed to prepare cloud restore',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(500).json(response);
        return;
      }

      const response: ApiResponse<typeof result> = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('already in progress') ? 409 : 500;

      const response: ApiResponse<never> = {
        success: false,
        error: { code: 'CLOUD_RESTORE_ERROR', message },
        timestamp: new Date().toISOString(),
      };
      res.status(code).json(response);
    }
  }
);

/**
 * POST /api/cloud/restore/start
 * Start restoring from a specific cloud snapshot
 */
api.post(
  '/restore/start',
  {
    summary: 'Start cloud restore',
    description:
      'Starts a restore from a previously synced cloud snapshot. In clone mode, a new install identity is generated after restore.',
    responses: {
      202: { description: 'Restore started' },
      400: { description: 'Missing snapshotId or invalid mode' },
      409: { description: 'Restore already in progress' },
      500: { description: 'Failed to start restore' },
    },
  },
  async (req: Request, res: Response) => {
    try {
      const { snapshotId, mode } = req.body as {
        snapshotId?: string;
        mode?: string;
      };

      if (!snapshotId) {
        const response: ApiResponse<never> = {
          success: false,
          error: {
            code: 'MISSING_SNAPSHOT',
            message: 'snapshotId is required',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      if (mode && mode !== 'restore' && mode !== 'clone') {
        const response: ApiResponse<never> = {
          success: false,
          error: {
            code: 'INVALID_MODE',
            message: 'mode must be "restore" or "clone"',
          },
          timestamp: new Date().toISOString(),
        };
        res.status(400).json(response);
        return;
      }

      if (restoreService.isRestoring()) {
        const response: ApiResponse<never> = {
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

      const restoreMode = (mode as 'restore' | 'clone') || 'restore';

      // Start restore asynchronously
      restoreService
        .restore(snapshotId)
        .then(async (result) => {
          if (result.success && restoreMode === 'clone') {
            try {
              await installIdentityService.cloneIdentity();
              logger.info('Clone identity created after cloud restore');
            } catch (cloneError) {
              logger.error({ cloneError }, 'Failed to create clone identity (restore succeeded)');
            }
          }
          if (!result.success) {
            logger.error({ snapshotId, error: result.error }, 'Cloud restore failed');
          }
          // Reconnect to local repo now that restore is done
          await cloudSyncService.resetCloudRestore();
        })
        .catch((err) => {
          logger.error({ err }, 'Unexpected error in cloud restore');
          // Still try to reconnect to local repo on error
          cloudSyncService.resetCloudRestore().catch(() => {});
        });

      const response: ApiResponse<{
        snapshotId: string;
        mode: string;
        status: string;
      }> = {
        success: true,
        data: { snapshotId, mode: restoreMode, status: 'preparing' },
        timestamp: new Date().toISOString(),
      };
      res.status(202).json(response);
    } catch (error) {
      logger.error({ error }, 'Failed to start cloud restore');
      const response: ApiResponse<never> = {
        success: false,
        error: {
          code: 'CLOUD_RESTORE_START_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
      };
      res.status(500).json(response);
    }
  }
);

/**
 * GET /api/cloud/restore/status
 * Get cloud restore progress (combines sync phase + restore phase)
 */
api.get(
  '/restore/status',
  {
    summary: 'Get cloud restore status',
    description:
      'Returns current status of a cloud restore, covering both the sync-from-cloud phase and the local restore phase.',
    responses: {
      200: { description: 'Cloud restore status' },
    },
  },
  async (_req: Request, res: Response) => {
    const cloudProgress = cloudSyncService.getCloudRestoreProgress();
    const restoreProgress = restoreService.getProgress();

    const response: ApiResponse<{
      cloudPhase: string;
      cloudError: string | null;
      restore: RestoreProgress | null;
    }> = {
      success: true,
      data: {
        cloudPhase: cloudProgress.phase,
        cloudError: cloudProgress.error,
        restore: restoreProgress,
      },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

/**
 * POST /api/cloud/restore/reset
 * Reset cloud restore state
 */
api.post(
  '/restore/reset',
  {
    summary: 'Reset cloud restore state',
    description: 'Resets the cloud restore state machine after completion or failure.',
    responses: {
      200: { description: 'State reset' },
    },
  },
  async (_req: Request, res: Response) => {
    await cloudSyncService.resetCloudRestore();

    const response: ApiResponse<{ message: string }> = {
      success: true,
      data: { message: 'Cloud restore state reset' },
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  }
);

export const cloudRouter = api.router;
