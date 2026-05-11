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
import { writeFile, readFile, readdir, stat, mkdir } from 'fs/promises';
import { connect, type Socket } from 'net';
import { join } from 'path';

import { config } from '../config/index.js';
import { logger } from './logger.js';
import {
  settingsService,
  type CloudSyncSettings,
  type CloudSyncProvider,
} from './settings-service.js';
import { installIdentityService } from './install-identity-service.js';
import { gdriveAuthService, RCLONE_GDRIVE_REMOTE_NAME } from './gdrive-auth-service.js';
import { localFsService } from './local-fs-service.js';
import { kopiaClient } from './kopia-client.js';
import type { CloudRestorePhase, CloudRestorePrepareResult } from '../types/backup.js';

/**
 * Provider-agnostic auth status. Each provider's auth-service must
 * project its own status shape into this minimal contract. The
 * `email?` field is the gdrive-style human-readable label for the
 * connection ("foo@gmail.com"); other providers can repurpose it
 * (e.g. `"user@host/share"` for SMB).
 */
interface ProviderAuthStatus {
  connected: boolean;
  configured: boolean;
  /** Human-readable label for the connected destination, when known. */
  email?: string;
}

/**
 * Provider-specific bits needed by the sync flow:
 *
 *  - `authService` — connect/disconnect/status, the gdrive-style auth flow.
 *  - `syncTarget` — how kopia is told to write to this destination.
 *    Two shapes today:
 *      - `kind: 'rclone'` for rclone-backed providers (gdrive, future smb).
 *        kopia talks to rclone, rclone talks to the destination.
 *      - `kind: 'filesystem'` for local/USB. kopia writes to a path
 *        directly; no rclone in the loop.
 *
 * Resolved per-call in cloud-sync-service so settings changes flow
 * through immediately without restarting anything.
 */
type SyncTarget =
  | {
      kind: 'rclone';
      remoteName: string;
      /** Build the full kopia/rclone path for an install's backups folder. */
      remotePath: (folderId: string) => string;
      /** Extra `--rclone-args=…` to pass on every kopia sync for this provider. */
      rcloneFlags: () => string[];
    }
  | {
      kind: 'filesystem';
      /** Container-side directory under which `SignalK-Backups/{folderId}/` lives. */
      basePath: string;
      /** Build the full container-side path for an install's backups folder. */
      installPath: (folderId: string) => string;
    };

interface ProviderBindings {
  authService: { getStatus(): Promise<ProviderAuthStatus> };
  syncTarget: SyncTarget;
}

/**
 * Default `cloudSync` blob for fresh installs (no settings.json yet, or
 * cloudSync absent). Defaults to gdrive since that's been the only
 * provider since 0.1.0 — picking a different default would silently
 * change behaviour on upgrade.
 */
function defaultCloudSyncSettings(): CloudSyncSettings {
  return {
    provider: 'gdrive',
    syncMode: 'manual',
    syncFrequency: 'daily',
    lastSync: null,
    lastSyncError: null,
  };
}

/**
 * Resolve provider-specific bindings from a (possibly partial) cloudSync
 * settings blob. Variants that need extra config (local needs the
 * container-side path) read it from the settings; variants that don't
 * (gdrive) ignore it.
 *
 * Falls back to the gdrive defaults when `cloudSync` is undefined so
 * callers can run on a fresh install before the user has configured
 * anything.
 */
function getProviderBindings(cloudSync: CloudSyncSettings | undefined): ProviderBindings {
  const provider: CloudSyncProvider = cloudSync?.provider ?? 'gdrive';
  switch (provider) {
    case 'gdrive':
      return {
        authService: gdriveAuthService,
        syncTarget: {
          kind: 'rclone',
          remoteName: RCLONE_GDRIVE_REMOTE_NAME,
          remotePath: (folderId) => `${RCLONE_GDRIVE_REMOTE_NAME}:SignalK-Backups/${folderId}`,
          // Drive performs better with smaller chunks for high-latency
          // round-trips. SMB/local won't want this.
          rcloneFlags: () => ['--rclone-args=--drive-chunk-size=256k'],
        },
      };
    case 'local': {
      // The path comes from the settings; bindings can't be resolved for
      // 'local' without it.
      if (!cloudSync || cloudSync.provider !== 'local') {
        throw new Error('local provider requires cloudSync.containerPath');
      }
      const basePath = cloudSync.containerPath;
      return {
        authService: localFsService,
        syncTarget: {
          kind: 'filesystem',
          basePath,
          installPath: (folderId) => `${basePath}/SignalK-Backups/${folderId}`,
        },
      };
    }
    default: {
      // Exhaustiveness check so adding a new variant to CloudSyncProvider
      // surfaces here as a compile error.
      const _exhaustive: never = provider;
      throw new Error(`Unknown cloud sync provider: ${String(_exhaustive)}`);
    }
  }
}

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
  /** Active cloud provider (currently only `gdrive` is implemented). */
  provider: CloudSyncProvider;
  /** Whether the active provider is connected. */
  connected: boolean;
  /** Whether the active provider's credentials are configured. */
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
  /** Human-readable label for the connected destination (gdrive email, etc). */
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
    const settings = await settingsService.get();
    const provider = settings.cloudSync?.provider ?? 'gdrive';
    const bindings = getProviderBindings(settings.cloudSync);
    const authStatus = await bindings.authService.getStatus();

    return {
      provider,
      connected: authStatus.connected,
      configured: authStatus.configured,
      syncing: this.syncing,
      syncMode: settings.cloudSync?.syncMode ?? null,
      syncFrequency: settings.cloudSync?.syncFrequency ?? null,
      lastSync: settings.cloudSync?.lastSync ?? null,
      lastSyncError: settings.cloudSync?.lastSyncError ?? null,
      internetAvailable: this.internetAvailable,
      email: authStatus.email,
      syncProgress: this.syncProgress ?? undefined,
    };
  }

  async syncToCloud(): Promise<void> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    // Set syncing flag immediately so status polls see it right away
    this.syncing = true;

    const settings = await settingsService.get();
    const provider = settings.cloudSync?.provider ?? 'gdrive';
    const bindings = getProviderBindings(settings.cloudSync);

    try {
      const authStatus = await bindings.authService.getStatus();
      if (!authStatus.connected) {
        throw new Error(`Cloud provider not connected: ${provider}`);
      }

      // Internet connectivity is only relevant for rclone-backed targets.
      // Local-filesystem syncs work fine offline.
      if (bindings.syncTarget.kind === 'rclone') {
        const online = await this.checkInternet();
        if (!online) {
          const error = 'No internet connection available';
          await this.updateSyncStatus(null, error);
          throw new Error(error);
        }
      }
    } catch (error) {
      this.syncing = false;
      throw error;
    }

    // Calculate repo size for progress display
    const repoSize = await this.getRepoSize();
    this.syncProgress = { totalBytes: repoSize };
    logger.info({ repoSizeBytes: repoSize, provider }, 'Starting cloud sync');

    try {
      const folderId = await installIdentityService.getFolderId();

      if (bindings.syncTarget.kind === 'rclone') {
        const remotePath = bindings.syncTarget.remotePath(folderId);
        await this.runKopiaSync('sync-to', remotePath, undefined, bindings.syncTarget);
        await this.writeInstallInfoToRclone(folderId, bindings.syncTarget.remoteName);
        logger.info({ remotePath, provider }, 'Cloud sync completed');
      } else {
        const installPath = bindings.syncTarget.installPath(folderId);
        await this.runKopiaSyncFilesystem('sync-to', installPath);
        await this.writeInstallInfoToFilesystem(folderId, bindings.syncTarget.basePath);
        logger.info({ installPath, provider }, 'Local sync completed');
      }

      const now = new Date().toISOString();
      await this.updateSyncStatus(now, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateSyncStatus(null, message);
      logger.error({ error: message, provider }, 'Cloud sync failed');
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

    const settings = await settingsService.get();
    const provider = settings.cloudSync?.provider ?? 'gdrive';
    const bindings = getProviderBindings(settings.cloudSync);
    const authStatus = await bindings.authService.getStatus();
    if (!authStatus.connected) {
      throw new Error(`Cloud provider not connected: ${provider}`);
    }

    if (bindings.syncTarget.kind === 'rclone') {
      const online = await this.checkInternet();
      if (!online) {
        throw new Error('No internet connection available');
      }
    }

    this.cloudRestorePhase = 'syncing';
    this.cloudRestoreError = null;

    try {
      // Connect to the cloud repo so we can list its snapshots
      await this.connectToCloudRepo(folder, password, bindings);

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
    const settings = await settingsService.get();
    const bindings = getProviderBindings(settings.cloudSync);
    const authStatus = await bindings.authService.getStatus();
    if (!authStatus.connected) {
      return [];
    }

    if (bindings.syncTarget.kind === 'rclone') {
      return this.listInstallsViaRclone(bindings.syncTarget.remoteName);
    }
    return this.listInstallsViaFilesystem(bindings.syncTarget.basePath);
  }

  private async listInstallsViaRclone(remoteName: string): Promise<CloudInstall[]> {
    try {
      const { stdout } = await execFile(
        config.rcloneBinaryPath,
        [
          'lsjson',
          '--config',
          config.rcloneConfigPath,
          `${remoteName}:SignalK-Backups/`,
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
              `${remoteName}:SignalK-Backups/${dir.Name}/install-info.json`,
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

  private async listInstallsViaFilesystem(basePath: string): Promise<CloudInstall[]> {
    const root = `${basePath}/SignalK-Backups`;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const installs: CloudInstall[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const install: CloudInstall = { folder: entry.name };
        try {
          const infoJson = await readFile(`${root}/${entry.name}/install-info.json`, 'utf-8');
          install.info = JSON.parse(infoJson) as Record<string, unknown>;
        } catch {
          // No install-info.json or parse error, skip
        }
        installs.push(install);
      }
      return installs;
    } catch (error) {
      // ENOENT just means no backups have ever been written; return empty.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      logger.error({ error, root }, 'Failed to list local installations');
      return [];
    }
  }

  async updateConfig(updates: Partial<CloudSyncSettings>): Promise<CloudSyncSettings> {
    const settings = await settingsService.get();
    const current: CloudSyncSettings = settings.cloudSync ?? defaultCloudSyncSettings();

    // TypeScript can't narrow `Partial<A | B>` to a single variant, so cast
    // through the current variant — caller is responsible for staying within
    // one provider (the routes layer never lets you switch provider+other
    // fields in one update).
    const updated = { ...current, ...updates } as CloudSyncSettings;
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

    const provider = settings.cloudSync.provider;
    const bindings = getProviderBindings(settings.cloudSync);
    const authStatus = await bindings.authService.getStatus();
    if (!authStatus.connected) {
      logger.debug({ provider }, 'Skipping post-backup cloud sync: provider not connected');
      return;
    }

    try {
      await this.syncToCloud();
    } catch (error) {
      // Don't fail the backup if cloud sync fails
      logger.warn({ error, provider }, 'Post-backup cloud sync failed (non-fatal)');
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
  private async connectToCloudRepo(
    folder: string,
    password: string | undefined,
    bindings: ProviderBindings
  ): Promise<void> {
    if (this.syncing) {
      throw new Error('Sync already in progress');
    }

    this.syncing = true;
    logger.info({ folder, hasCustomPassword: !!password }, 'Connecting to cloud repository');

    try {
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

      // Connect to the destination repo using a separate kopia config so the
      // local repo's connection isn't disturbed.  Credentials ARE persisted
      // so subsequent kopia commands (snapshot list, snapshot restore) can
      // start their own helper process (rclone, fs walker, …). The separate
      // config file is cleaned up on disconnect.
      const args =
        bindings.syncTarget.kind === 'rclone'
          ? [
              'repository',
              'connect',
              'rclone',
              '--remote-path',
              bindings.syncTarget.remotePath(folder),
              '--rclone-exe',
              config.rcloneBinaryPath,
              '--rclone-startup-timeout=120s',
              `--rclone-args=--config=${config.rcloneConfigPath}`,
            ]
          : [
              'repository',
              'connect',
              'filesystem',
              '--path',
              bindings.syncTarget.installPath(folder),
            ];

      await execFile(config.kopiaBinaryPath, args, {
        env,
        timeout: SYNC_TIMEOUT_MS,
      });

      // Set overrides so kopia-client commands (listBackups, restoreSnapshot) use cloud repo
      kopiaClient.setCloudOverrides(CLOUD_RESTORE_CONFIG_PATH, effectivePassword);

      logger.info({ folder, kind: bindings.syncTarget.kind }, 'Connected to restore repository');
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
    passwordOverride: string | undefined,
    target: Extract<SyncTarget, { kind: 'rclone' }>
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
      ...target.rcloneFlags(),
    ];
    return this.execKopiaSync(args, passwordOverride);
  }

  private async runKopiaSyncFilesystem(direction: 'sync-to', installPath: string): Promise<void> {
    // Ensure the parent dir exists — kopia's filesystem target writes to it
    // without auto-creating intermediate parents.
    await mkdir(installPath, { recursive: true });
    const args = ['repository', direction, 'filesystem', '--path', installPath];
    return this.execKopiaSync(args, undefined);
  }

  private execKopiaSync(args: string[], passwordOverride: string | undefined): Promise<void> {
    return (async () => {
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
    })();
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

  private async writeInstallInfoToRclone(folderId: string, remoteName: string): Promise<void> {
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
          `${remoteName}:SignalK-Backups/${folderId}/install-info.json`,
        ],
        { timeout: 30000 }
      );
    } catch (error) {
      // Non-fatal — the backup itself is fine
      logger.warn({ error }, 'Failed to write install-info.json to cloud');
    }
  }

  private async writeInstallInfoToFilesystem(folderId: string, basePath: string): Promise<void> {
    try {
      const info = await installIdentityService.getInstallInfo();
      const dir = `${basePath}/SignalK-Backups/${folderId}`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/install-info.json`, JSON.stringify(info, null, 2), 'utf-8');
    } catch (error) {
      // Non-fatal — the backup itself is fine
      logger.warn({ error, folderId }, 'Failed to write install-info.json to filesystem');
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
    const cloudSync: CloudSyncSettings = settings.cloudSync ?? defaultCloudSyncSettings();

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
