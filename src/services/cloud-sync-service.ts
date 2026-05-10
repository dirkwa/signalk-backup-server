/**
 * Cloud Sync Service
 *
 * Syncs local Kopia backup repository to Google Drive via rclone.
 * Uses `kopia repository sync-to rclone` which pushes the entire
 * deduplicated, encrypted local repo to the cloud. rclone is just
 * the transport layer.
 *
 * Sync modes:
 * - manual: only when user clicks "Sync Now"
 * - after_backup: automatically after each successful local backup
 * - scheduled: daily/weekly via setInterval
 */

import { execFile as execFileCb, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { writeFile, readdir, stat } from 'fs/promises';
import { connect, type Socket } from 'net';
import { join } from 'path';

import { config } from '../config/index.js';
import { logger } from './logger.js';
import { settingsService, type CloudSyncSettings } from './settings-service.js';
import { installIdentityService } from './install-identity-service.js';
import { gdriveAuthService, RCLONE_REMOTE_NAME } from './gdrive-auth-service.js';
import { kopiaClient } from './kopia-client.js';
import type { CloudRestorePhase, CloudRestorePrepareResult } from '../types/backup.js';

const execFile = promisify(execFileCb);

const CLOUD_RESTORE_CONFIG_PATH = config.kopiaConfigPath + '-cloud-restore';

const SYNC_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const CONNECTIVITY_TIMEOUT_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * DAY_MS;

interface SyncProgress {
  /** Total size of local kopia repo in bytes */
  totalBytes: number;
  /** Blobs processed so far (from kopia stderr) */
  processedBlobs?: number;
  /** Total blobs to sync (from kopia stderr) */
  totalBlobs?: number;
  /** Bytes processed so far (from kopia stderr) */
  processedBytes?: number;
}

interface CloudSyncStatus {
  /** Whether Google Drive is connected */
  connected: boolean;
  /** Whether OAuth credentials are configured */
  configured: boolean;
  /** Whether a sync is currently running */
  syncing: boolean;
  /** Current sync mode */
  syncMode: CloudSyncSettings['syncMode'] | null;
  /** Sync frequency (for scheduled mode) */
  syncFrequency: CloudSyncSettings['syncFrequency'] | null;
  /** ISO timestamp of last successful sync */
  lastSync: string | null;
  /** Error from last sync attempt */
  lastSyncError: string | null;
  /** Whether internet is available */
  internetAvailable: boolean | null;
  /** Google account email */
  email?: string;
  /** Progress info during active sync */
  syncProgress?: SyncProgress;
}

interface CloudInstall {
  /** Folder name on Google Drive */
  folder: string;
  /** Install info (if install-info.json exists) */
  info?: Record<string, unknown>;
}

class CloudSyncService {
  private syncing = false;
  private activeSyncProcess: ChildProcess | null = null;
  private syncScheduleInterval: NodeJS.Timeout | null = null;
  private internetAvailable: boolean | null = null;
  private syncProgress: SyncProgress | null = null;

  // Cloud restore state
  private cloudRestorePhase: CloudRestorePhase = 'idle';
  private cloudRestoreError: string | null = null;

  async getStatus(): Promise<CloudSyncStatus> {
    const driveStatus = await gdriveAuthService.getStatus();
    const settings = await settingsService.get();

    return {
      connected: driveStatus.connected,
      configured: driveStatus.configured,
      syncing: this.syncing,
      syncMode: settings.cloudSync?.syncMode ?? null,
      syncFrequency: settings.cloudSync?.syncFrequency ?? null,
      lastSync: settings.cloudSync?.lastSync ?? null,
      lastSyncError: settings.cloudSync?.lastSyncError ?? null,
      internetAvailable: this.internetAvailable,
      email: driveStatus.email,
      syncProgress: this.syncProgress ?? undefined,
    };
  }

  async syncToCloud(): Promise<void> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    // Set syncing flag immediately so status polls see it right away
    this.syncing = true;

    try {
      const driveStatus = await gdriveAuthService.getStatus();
      if (!driveStatus.connected) {
        throw new Error('Google Drive not connected');
      }

      // Check internet connectivity
      const online = await this.checkInternet();
      if (!online) {
        const error = 'No internet connection available';
        await this.updateSyncStatus(null, error);
        throw new Error(error);
      }
    } catch (error) {
      this.syncing = false;
      throw error;
    }

    // Calculate repo size for progress display
    const repoSize = await this.getRepoSize();
    this.syncProgress = { totalBytes: repoSize };
    logger.info({ repoSizeBytes: repoSize }, 'Starting cloud sync to Google Drive');

    try {
      const folderId = await installIdentityService.getFolderId();
      const remotePath = `${RCLONE_REMOTE_NAME}:SignalK-Backups/${folderId}`;

      // Sync local Kopia repo to cloud via rclone
      await this.runKopiaSync('sync-to', remotePath);

      // Write install-info.json alongside the repo for human identification
      await this.writeInstallInfo(folderId);

      const now = new Date().toISOString();
      await this.updateSyncStatus(now, null);

      logger.info({ remotePath }, 'Cloud sync completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateSyncStatus(null, message);
      logger.error({ error: message }, 'Cloud sync failed');
      throw error;
    } finally {
      this.syncing = false;
      this.syncProgress = null;
    }
  }

  /**
   * Prepare a cloud restore: sync from cloud, then list available snapshots.
   *
   * @param folder - The cloud installation folder to sync from
   * @param password - Optional recovery password (for foreign installations)
   */
  async prepareCloudRestore(folder: string, password?: string): Promise<CloudRestorePrepareResult> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    const driveStatus = await gdriveAuthService.getStatus();
    if (!driveStatus.connected) {
      throw new Error('Google Drive not connected');
    }

    const online = await this.checkInternet();
    if (!online) {
      throw new Error('No internet connection available');
    }

    this.cloudRestorePhase = 'syncing';
    this.cloudRestoreError = null;

    try {
      // Connect to the cloud repo so we can list its snapshots
      await this.connectToCloudRepo(folder, password);

      // List snapshots from the cloud repository
      this.cloudRestorePhase = 'listing';

      // Lazy import to avoid circular dependency
      const { backupService } = await import('./backup-service.js');
      const snapshots = await backupService.listBackups();

      this.cloudRestorePhase = 'ready';
      return { phase: 'ready', snapshots };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.cloudRestorePhase = 'failed';
      this.cloudRestoreError = message;

      // Disconnect cloud repo on failure
      await this.disconnectCloudRepo();

      // Detect password errors specifically
      const isPasswordError =
        message.includes('invalid password') ||
        message.includes('wrong passphrase') ||
        message.includes('decryption') ||
        message.includes('invalid repository');

      return {
        phase: 'failed',
        snapshots: [],
        error: isPasswordError ? 'Wrong recovery password. Please check and try again.' : message,
      };
    }
  }

  getCloudRestoreProgress(): { phase: CloudRestorePhase; error: string | null } {
    return {
      phase: this.cloudRestorePhase,
      error: this.cloudRestoreError,
    };
  }

  async resetCloudRestore(): Promise<void> {
    this.cloudRestorePhase = 'idle';
    this.cloudRestoreError = null;
    await this.disconnectCloudRepo();
  }

  async listCloudInstalls(): Promise<CloudInstall[]> {
    const driveStatus = await gdriveAuthService.getStatus();
    if (!driveStatus.connected) {
      return [];
    }

    try {
      const { stdout } = await execFile(
        config.rcloneBinaryPath,
        [
          'lsjson',
          '--config',
          config.rcloneConfigPath,
          `${RCLONE_REMOTE_NAME}:SignalK-Backups/`,
          '--dirs-only',
        ],
        { timeout: 30000 }
      );

      const dirs = JSON.parse(stdout) as Array<{ Name: string; Path: string }>;
      const installs: CloudInstall[] = [];

      for (const dir of dirs) {
        const install: CloudInstall = { folder: dir.Name };

        // Try to read install-info.json
        try {
          const { stdout: infoJson } = await execFile(
            config.rcloneBinaryPath,
            [
              'cat',
              '--config',
              config.rcloneConfigPath,
              `${RCLONE_REMOTE_NAME}:SignalK-Backups/${dir.Name}/install-info.json`,
            ],
            { timeout: 15000 }
          );
          install.info = JSON.parse(infoJson) as Record<string, unknown>;
        } catch {
          // No install-info.json or parse error, skip
        }

        installs.push(install);
      }

      return installs;
    } catch (error) {
      logger.error({ error }, 'Failed to list cloud installations');
      return [];
    }
  }

  async updateConfig(updates: Partial<CloudSyncSettings>): Promise<CloudSyncSettings> {
    const settings = await settingsService.get();
    const current = settings.cloudSync ?? {
      provider: 'gdrive' as const,
      syncMode: 'manual' as const,
      syncFrequency: 'daily' as const,
      lastSync: null,
      lastSyncError: null,
    };

    const updated: CloudSyncSettings = { ...current, ...updates };
    await settingsService.update({ cloudSync: updated });

    // Restart schedule if mode changed
    this.restartSchedule(updated);

    return updated;
  }

  /**
   * Called after a successful local backup to trigger cloud sync
   * if syncMode is 'after_backup'.
   */
  async onBackupComplete(): Promise<void> {
    const settings = await settingsService.get();
    if (settings.cloudSync?.syncMode !== 'after_backup') {
      return;
    }

    const driveStatus = await gdriveAuthService.getStatus();
    if (!driveStatus.connected) {
      logger.debug('Skipping post-backup cloud sync: Google Drive not connected');
      return;
    }

    try {
      await this.syncToCloud();
    } catch (error) {
      // Don't fail the backup if cloud sync fails
      logger.warn({ error }, 'Post-backup cloud sync failed (non-fatal)');
    }
  }

  /**
   * Start the cloud sync schedule (called on service startup)
   */
  async startSchedule(): Promise<void> {
    const settings = await settingsService.get();
    if (settings.cloudSync) {
      this.restartSchedule(settings.cloudSync);
    }
  }

  cancelSync(): boolean {
    if (!this.syncing || !this.activeSyncProcess) {
      return false;
    }

    logger.info('Cancelling cloud sync');
    this.activeSyncProcess.kill('SIGTERM');
    return true;
  }

  stopSchedule(): void {
    if (this.syncScheduleInterval) {
      clearInterval(this.syncScheduleInterval);
      this.syncScheduleInterval = null;
    }
  }

  /**
   * Connect to a cloud repository for restore using a separate kopia config.
   * The local repo connection is NOT disturbed — backups continue normally.
   * Sets kopia-client overrides so listBackups/restoreSnapshot use the cloud repo.
   */
  private async connectToCloudRepo(folder: string, password?: string): Promise<void> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    this.syncing = true;
    logger.info({ folder, hasCustomPassword: !!password }, 'Connecting to cloud repository');

    try {
      const remotePath = `${RCLONE_REMOTE_NAME}:SignalK-Backups/${folder}`;
      const effectivePassword = password ?? (await settingsService.getKopiaPassword());

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        KOPIA_CONFIG_PATH: CLOUD_RESTORE_CONFIG_PATH,
        KOPIA_PASSWORD: effectivePassword,
      };

      // Disconnect any previous cloud restore connection
      try {
        await execFile(config.kopiaBinaryPath, ['repository', 'disconnect'], {
          env,
          timeout: 30000,
        });
      } catch {
        // May not be connected, ignore
      }

      // Connect to the cloud repo via rclone (using the separate config).
      // Credentials ARE persisted so subsequent kopia commands (snapshot list,
      // snapshot restore) can start their own rclone process. The separate
      // config file is cleaned up on disconnect.
      const args = [
        'repository',
        'connect',
        'rclone',
        '--remote-path',
        remotePath,
        '--rclone-exe',
        config.rcloneBinaryPath,
        '--rclone-startup-timeout=120s',
        `--rclone-args=--config=${config.rcloneConfigPath}`,
      ];

      await execFile(config.kopiaBinaryPath, args, {
        env,
        timeout: SYNC_TIMEOUT_MS,
      });

      // Set overrides so kopia-client commands (listBackups, restoreSnapshot) use cloud repo
      kopiaClient.setCloudOverrides(CLOUD_RESTORE_CONFIG_PATH, effectivePassword);

      logger.info({ folder }, 'Connected to cloud repository');
    } catch (error) {
      this.syncing = false;
      throw error;
    }
  }

  /**
   * Disconnect the cloud restore connection and clear kopia-client overrides.
   * The local repo connection was never disturbed, so no reconnection needed.
   */
  private async disconnectCloudRepo(): Promise<void> {
    try {
      // Clear kopia-client overrides first so any concurrent commands use local repo
      kopiaClient.clearCloudOverrides();

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        KOPIA_CONFIG_PATH: CLOUD_RESTORE_CONFIG_PATH,
        KOPIA_PASSWORD: 'unused', // disconnect doesn't need the password
      };

      await execFile(config.kopiaBinaryPath, ['repository', 'disconnect'], {
        env,
        timeout: 30000,
      });

      logger.info('Disconnected from cloud repository');
    } catch (error) {
      logger.warn({ error }, 'Failed to disconnect cloud restore repo (non-fatal)');
    } finally {
      this.syncing = false;
    }
  }

  private async runKopiaSync(
    direction: 'sync-to',
    remotePath: string,
    passwordOverride?: string
  ): Promise<void> {
    const args = [
      'repository',
      direction,
      'rclone',
      '--remote-path',
      remotePath,
      '--rclone-exe',
      config.rcloneBinaryPath,
      '--rclone-startup-timeout=120s',
      `--rclone-args=--config=${config.rcloneConfigPath}`,
      '--rclone-args=--transfers=8',
      '--rclone-args=--checkers=16',
      '--rclone-args=--drive-chunk-size=256k',
    ];

    const effectivePassword = passwordOverride ?? (await settingsService.getKopiaPassword());

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KOPIA_CONFIG_PATH: config.kopiaConfigPath,
      KOPIA_PASSWORD: effectivePassword,
    };

    logger.debug({ args }, 'Running kopia sync command');

    return new Promise<void>((resolve, reject) => {
      const child = execFileCb(
        config.kopiaBinaryPath,
        args,
        { env, timeout: SYNC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          this.activeSyncProcess = null;
          if (error) {
            if (error.killed || error.signal === 'SIGTERM') {
              reject(new Error('Sync cancelled by user'));
            } else {
              reject(error);
            }
            return;
          }
          if (stderr?.trim()) {
            logger.debug({ stderr: stderr.trim() }, 'Kopia sync stderr');
          }
          resolve();
        }
      );
      this.activeSyncProcess = child;

      // Stream stderr for progress parsing
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const line = data.toString();
          this.parseKopiaSyncProgress(line);
        });
      }
    });
  }

  /**
   * Parse kopia sync stderr output for progress information.
   * Kopia outputs lines like: "  processed X/Y blobs (Z bytes)"
   */
  private parseKopiaSyncProgress(line: string): void {
    // Match patterns like "Processed 5/42 blobs" or "processed 5 of 42 blobs"
    const blobMatch = line.match(/(\d+)\s*[/of]+\s*(\d+)\s*blobs?/i);
    if (blobMatch?.[1] && blobMatch[2] && this.syncProgress) {
      this.syncProgress.processedBlobs = parseInt(blobMatch[1], 10);
      this.syncProgress.totalBlobs = parseInt(blobMatch[2], 10);
    }

    // Match byte counts like "(1234567 bytes)"
    const byteMatch = line.match(/\((\d+)\s*bytes?\)/i);
    if (byteMatch?.[1] && this.syncProgress) {
      this.syncProgress.processedBytes = parseInt(byteMatch[1], 10);
    }
  }

  private async writeInstallInfo(folderId: string): Promise<void> {
    try {
      const info = await installIdentityService.getInstallInfo();
      const tmpPath = '/tmp/install-info.json';
      await writeFile(tmpPath, JSON.stringify(info, null, 2), 'utf-8');

      await execFile(
        config.rcloneBinaryPath,
        [
          'copyto',
          '--config',
          config.rcloneConfigPath,
          tmpPath,
          `${RCLONE_REMOTE_NAME}:SignalK-Backups/${folderId}/install-info.json`,
        ],
        { timeout: 30000 }
      );
    } catch (error) {
      // Non-fatal — the backup itself is fine
      logger.warn({ error }, 'Failed to write install-info.json to cloud');
    }
  }

  private async getRepoSize(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isFile()) {
            const s = await stat(fullPath);
            total += s.size;
          } else if (entry.isDirectory()) {
            await walk(fullPath);
          }
        }
      } catch {
        // Permission or access error — skip
      }
    };
    await walk(config.kopiaRepoPath);
    return total;
  }

  private checkInternet(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket: Socket = connect(
        { host: 'www.googleapis.com', port: 443, timeout: CONNECTIVITY_TIMEOUT_MS },
        () => {
          socket.destroy();
          this.internetAvailable = true;
          resolve(true);
        }
      );

      socket.on('error', () => {
        socket.destroy();
        this.internetAvailable = false;
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        this.internetAvailable = false;
        resolve(false);
      });
    });
  }

  private async updateSyncStatus(
    lastSync: string | null,
    lastSyncError: string | null
  ): Promise<void> {
    const settings = await settingsService.get();
    const cloudSync = settings.cloudSync ?? {
      provider: 'gdrive' as const,
      syncMode: 'manual' as const,
      syncFrequency: 'daily' as const,
      lastSync: null,
      lastSyncError: null,
    };

    if (lastSync !== null) {
      cloudSync.lastSync = lastSync;
    }
    cloudSync.lastSyncError = lastSyncError;
    await settingsService.update({ cloudSync });
  }

  private restartSchedule(cloudSync: CloudSyncSettings): void {
    this.stopSchedule();

    if (cloudSync.syncMode !== 'scheduled') {
      return;
    }

    const intervalMs = cloudSync.syncFrequency === 'weekly' ? WEEK_MS : DAY_MS;

    // Check if a sync is already overdue (e.g. after container restart)
    const lastSyncTime = cloudSync.lastSync ? new Date(cloudSync.lastSync).getTime() : 0;
    const elapsed = Date.now() - lastSyncTime;
    const overdue = elapsed >= intervalMs;

    logger.info(
      { frequency: cloudSync.syncFrequency, intervalMs, overdue, lastSync: cloudSync.lastSync },
      'Starting cloud sync schedule'
    );

    // If overdue (or never synced), sync immediately
    if (overdue) {
      this.syncToCloud().catch((error) => {
        logger.warn({ error }, 'Scheduled cloud sync failed (catch-up)');
      });
    }

    this.syncScheduleInterval = setInterval(async () => {
      try {
        await this.syncToCloud();
      } catch (error) {
        logger.warn({ error }, 'Scheduled cloud sync failed');
      }
    }, intervalMs);
  }
}

export const cloudSyncService = new CloudSyncService();
