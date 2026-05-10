import { createReadStream, createWriteStream, existsSync } from 'fs';
import { mkdir, rm, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import archiver from 'archiver';
import { Extract } from 'unzip-stream';

import { config } from '../config/index.js';
import { logger } from './logger.js';
import { versionService } from './version-service.js';
import { kopiaClient, type KopiaSnapshot } from './kopia-client.js';
import { settingsService } from './settings-service.js';
// keeper used historyBackupService here; in signalk-backup history is
// deferred to v2 (no InfluxDB/Grafana access from inside the plugin).
import type {
  BackupMetadata,
  BackupRequest,
  BackupResult,
  BackupType,
  CleanupResult,
  StorageStats,
  BackupSizeEstimate,
  RetentionConfig,
  RepositoryStats,
} from '../types/backup.js';
import { DEFAULT_RETENTION } from '../types/backup.js';
import type { ImageVersion } from '../types/version.js';

const UNKNOWN_VERSION: ImageVersion = {
  tag: 'unknown',
  fullRef: 'unknown',
  registry: 'unknown',
  owner: 'unknown',
  repository: 'unknown',
  channel: 'stable',
};

const CONFIG_FILES = ['settings.json', 'security.json', 'package.json', 'baseDeltas.json'];

const CONFIG_DIRS = ['plugin-config-data', 'applicationData'];

const CA_BACKUP_DIR = '.https-ca';

const HISTORY_BACKUP_DIR = '.history-backup';

const DEFAULT_BACKUP_EXCLUSIONS = ['node_modules/', 'charts*/'];

/**
 * Patterns that are ALWAYS excluded, regardless of user settings.
 *
 * `.kopiaignore` — the file we write right next to the snapshot root.
 *
 * Inside our own plugin-config-data/signalk-backup/ tree, we must
 * exclude things that would cause snapshot N to contain snapshot N-1
 * of itself (kopia-repo grows without bound) but we deliberately
 * INCLUDE database-exports/ — that's the staging area the plugin uses
 * to drop QuestDB parquets that should travel with the snapshot.
 *
 * Architectural — these patterns are never user-toggleable.
 */
const ALWAYS_EXCLUDED = [
  '.kopiaignore',
  'plugin-config-data/signalk-backup/kopia-repo/',
  'plugin-config-data/signalk-backup/kopia-config',
  'plugin-config-data/signalk-backup/kopia-config.*',
  'plugin-config-data/signalk-backup/settings.json',
  'plugin-config-data/signalk-backup/install-id',
  'plugin-config-data/signalk-backup/.tmp/',
];

/**
 * Plugin-config-data subdirectories that contain *live database state*
 * (running InfluxDB / QuestDB / Grafana files, etc.). Filesystem-level
 * snapshots of these while the DB is writing can produce silently
 * inconsistent backups that look fine on disk but fail to restore.
 *
 * Excluded by default for safety — the user can override via
 * `dbDataExclusionsOverride: false` in settings to include them anyway,
 * which is appropriate when SignalK (and the DB containers) are stopped,
 * or when the user accepts the risk.
 *
 * The list is a glob-pattern match against the *immediate* subdirectory
 * name under plugin-config-data — `*` is a single-segment wildcard.
 */
const DB_PLUGIN_DEFAULT_EXCLUSIONS = [
  'plugin-config-data/signalk-questdb/',
  'plugin-config-data/signalk-grafana/',
  'plugin-config-data/signalk-influxdb*/',
  'plugin-config-data/signalk-history*/',
];

const CA_FILES = ['ca-cert.pem', 'ca-key.pem'];

/**
 * Convert a Kopia snapshot to BackupMetadata for API compatibility
 */
function snapshotToMetadata(snapshot: KopiaSnapshot): BackupMetadata {
  // Kopia prefixes user tags with "tag:" in JSON output — strip the prefix
  const rawTags = snapshot.tags ?? {};
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawTags)) {
    tags[key.replace(/^tag:/, '')] = value;
  }

  // Parse version from tags
  let version: ImageVersion = UNKNOWN_VERSION;
  const versionTag = tags['signalk-version'];
  if (versionTag) {
    try {
      version = JSON.parse(versionTag) as ImageVersion;
    } catch {
      version = { ...UNKNOWN_VERSION, tag: versionTag };
    }
  }

  return {
    id: snapshot.id,
    createdAt: snapshot.startTime,
    version,
    type: (tags['type'] ?? 'manual') as BackupType,
    size: snapshot.rootEntry?.summ?.size ?? 0,
    path: `kopia://${snapshot.id}`,
    description: snapshot.description || undefined,
    checksum: `kopia:${snapshot.id}`,
    includesPlugins: tags['includes-plugins'] === 'true',
    includesPluginData: tags['includes-plugin-data'] === 'true',
    includesHistory: tags['includes-history'] === 'true',
  };
}

class BackupService {
  private initialized = false;

  /**
   * Initialize backup service - set up Kopia repository
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Get repository password (always a string; default if no custom password set)
      const password = await settingsService.getKopiaPassword();
      kopiaClient.setPassword(password);

      // Check if repository already exists and is connected
      const connected = await kopiaClient.isRepositoryConnected();

      if (!connected) {
        // Try to connect to existing repository first
        if (existsSync(config.kopiaRepoPath)) {
          try {
            await kopiaClient.connectRepository();
            logger.info('Connected to existing Kopia repository');
          } catch {
            // Repository exists but can't connect - might be corrupted or password mismatch
            logger.warn('Failed to connect to existing repository, creating new one');
            await kopiaClient.initRepository();
          }
        } else {
          // Fresh installation - create new repository
          await kopiaClient.initRepository();
          logger.info('Created new Kopia repository');
        }
      }

      // Set default retention policy (Kopia's built-in; we also enforce per-tag)
      await kopiaClient.setPolicy(config.signalkDataPath, {
        keepLatest: 100,
        keepHourly: 0,
        keepDaily: 0,
        keepWeekly: 0,
        keepMonthly: 0,
        keepAnnual: 0,
      });

      this.initialized = true;
      logger.info('Backup service initialized with Kopia');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize backup service');
      throw error;
    }
  }

  async createBackup(request: BackupRequest = {}): Promise<BackupResult> {
    await this.ensureInitialized();

    const type = request.type ?? 'manual';
    const includePlugins = request.includePlugins ?? false;
    const includePluginData = request.includePluginData ?? false;

    // includeHistory: use explicit request flag if provided, else fall back to setting
    let includeHistory = request.includeHistory ?? undefined;
    if (includeHistory === undefined) {
      includeHistory = (await settingsService.getSetting('includeHistoryInBackups')) ?? false;
    }

    logger.info({ type, includePlugins, includePluginData, includeHistory }, 'Creating backup');

    try {
      // Get current SignalK version
      const version = await versionService.getCurrentVersion();

      // Build tags for this snapshot
      const tags: Record<string, string> = {
        type: type,
        'signalk-version': JSON.stringify(version ?? UNKNOWN_VERSION),
        'includes-plugins': String(includePlugins),
        'includes-plugin-data': String(includePluginData),
        'includes-history': String(includeHistory),
      };

      // Build description
      const description = request.description ?? `${type} backup`;

      // Build .kopiaignore from architectural defaults + DB plugin defaults
      // + user-configured exclusions + per-backup flags. Order matters only
      // for diagnostic clarity — kopia treats the file as a flat list.
      const exclusions = await this.getExclusions();
      const ignoreLines = [...ALWAYS_EXCLUDED, ...DB_PLUGIN_DEFAULT_EXCLUSIONS, ...exclusions];

      // Per-backup flags can override user exclusions
      if (includePlugins) {
        const idx = ignoreLines.indexOf('node_modules/');
        if (idx !== -1) ignoreLines.splice(idx, 1);
      }
      if (includePluginData) {
        const idx = ignoreLines.indexOf('plugin-config-data/');
        if (idx !== -1) ignoreLines.splice(idx, 1);
      }

      const ignorePath = join(config.signalkDataPath, '.kopiaignore');
      if (ignoreLines.length > 0) {
        await writeFile(ignorePath, ignoreLines.join('\n') + '\n');
        logger.debug({ ignoreLines }, 'Wrote .kopiaignore for backup exclusions');
      } else {
        await rm(ignorePath, { force: true });
      }

      // Stage CA files into signalk data dir so they're included in the snapshot
      const caBackupPath = join(config.signalkDataPath, CA_BACKUP_DIR);
      await this.stageCaFiles(caBackupPath);

      // keeper staged history data (InfluxDB/Grafana) here. In
      // signalk-backup-server history backups are deferred to v2 — the
      // plugin has no access to the host history dir or the InfluxDB
      // process. The flag is preserved for tag compatibility but does
      // nothing. See HISTORY_BACKUP_DIR below for the marker path.
      void HISTORY_BACKUP_DIR;

      try {
        // Create Kopia snapshot of SignalK data
        const snapshot = await kopiaClient.createSnapshot(config.signalkDataPath, {
          tags,
          description,
        });

        const metadata = snapshotToMetadata(snapshot);

        // Enforce retention policy
        await this.enforceRetention();

        logger.info(
          { backupId: metadata.id, size: metadata.size, type },
          'Backup created successfully'
        );

        return {
          success: true,
          backup: metadata,
        };
      } finally {
        // Always clean up staged files. History staging is a no-op in
        // this build (deferred to v2); only the ignore file and CA staging
        // dir need cleanup. See backup-service.stageHistoryFiles() above.
        await rm(ignorePath, { force: true });
        await rm(caBackupPath, { recursive: true, force: true });
      }
    } catch (error) {
      logger.error({ error, type }, 'Failed to create backup');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listBackups(): Promise<BackupMetadata[]> {
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch {
        return [];
      }
    }

    const snapshots = await kopiaClient.listSnapshots();
    return snapshots
      .map(snapshotToMetadata)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async listBackupsByType(type: BackupType): Promise<BackupMetadata[]> {
    await this.ensureInitialized();

    const snapshots = await kopiaClient.listSnapshots({
      tags: { type },
    });
    return snapshots
      .map(snapshotToMetadata)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getBackup(id: string): Promise<BackupMetadata | null> {
    await this.ensureInitialized();

    const snapshots = await kopiaClient.listSnapshots();
    const snapshot = snapshots.find((s) => s.id === id);
    return snapshot ? snapshotToMetadata(snapshot) : null;
  }

  async getLastBackupTime(): Promise<number> {
    const backups = await this.listBackups();
    if (backups.length === 0) return 0;

    const latest = backups[0];
    return latest ? new Date(latest.createdAt).getTime() : 0;
  }

  async deleteBackup(id: string): Promise<boolean> {
    await this.ensureInitialized();

    const backup = await this.getBackup(id);
    if (!backup) {
      logger.warn({ backupId: id }, 'Backup not found');
      return false;
    }

    try {
      await kopiaClient.deleteSnapshot(id);
      // Run maintenance to reclaim space from deleted snapshots
      await kopiaClient.maintenanceRun();
      logger.info({ backupId: id }, 'Backup deleted');
      return true;
    } catch (error) {
      logger.error({ error, backupId: id }, 'Failed to delete backup');
      return false;
    }
  }

  /**
   * Enforce retention policy - delete old backups by type
   */
  async enforceRetention(): Promise<CleanupResult> {
    await this.ensureInitialized();

    // keeper plumbed retention values through env vars (config.retention*).
    // signalk-backup-server has fixed retention defaults — exposed as
    // DEFAULT_RETENTION from the backup types module.
    const retention: RetentionConfig = { ...DEFAULT_RETENTION };

    const result: CleanupResult = {
      deletedCount: 0,
      freedBytes: 0,
      deletedIds: [],
    };

    const tiers: (keyof RetentionConfig)[] = ['hourly', 'daily', 'weekly', 'startup'];

    for (const tier of tiers) {
      const maxCount = retention[tier];
      const snapshots = await kopiaClient.listSnapshots({ tags: { type: tier } });
      const sorted = snapshots
        .map(snapshotToMetadata)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const toDelete = sorted.slice(maxCount);

      for (const backup of toDelete) {
        try {
          await kopiaClient.deleteSnapshot(backup.id);
          result.freedBytes += backup.size;
          result.deletedIds.push(backup.id);
          result.deletedCount++;
        } catch (error) {
          logger.warn({ error, backupId: backup.id }, 'Failed to delete expired backup');
        }
      }
    }

    if (result.deletedCount > 0) {
      // Run maintenance to reclaim space
      try {
        await kopiaClient.maintenanceRun();
      } catch (error) {
        logger.warn({ error }, 'Kopia maintenance after retention cleanup failed');
      }

      logger.info(
        { deletedCount: result.deletedCount, freedBytes: result.freedBytes },
        'Retention policy enforced'
      );
    }

    return result;
  }

  async getStorageStats(): Promise<StorageStats> {
    if (!this.initialized) {
      try {
        await this.initialize();
      } catch {
        return {
          totalSize: 0,
          countByType: {
            hourly: 0,
            daily: 0,
            weekly: 0,
            startup: 0,
            manual: 0,
            'pre-update': 0,
            'pre-restore': 0,
          },
          sizeByType: {
            hourly: 0,
            daily: 0,
            weekly: 0,
            startup: 0,
            manual: 0,
            'pre-update': 0,
            'pre-restore': 0,
          },
          oldestBackup: null,
          newestBackup: null,
        };
      }
    }

    const snapshots = await kopiaClient.listSnapshots();
    const backups = snapshots.map(snapshotToMetadata);

    const countByType: Record<BackupType, number> = {
      hourly: 0,
      daily: 0,
      weekly: 0,
      startup: 0,
      manual: 0,
      'pre-update': 0,
      'pre-restore': 0,
    };

    const sizeByType: Record<BackupType, number> = {
      hourly: 0,
      daily: 0,
      weekly: 0,
      startup: 0,
      manual: 0,
      'pre-update': 0,
      'pre-restore': 0,
    };

    let totalSize = 0;
    let oldestBackup: string | null = null;
    let newestBackup: string | null = null;

    for (const backup of backups) {
      countByType[backup.type]++;
      sizeByType[backup.type] += backup.size;
      totalSize += backup.size;

      if (!oldestBackup || backup.createdAt < oldestBackup) {
        oldestBackup = backup.createdAt;
      }
      if (!newestBackup || backup.createdAt > newestBackup) {
        newestBackup = backup.createdAt;
      }
    }

    return {
      totalSize,
      countByType,
      sizeByType,
      oldestBackup,
      newestBackup,
    };
  }

  /**
   * Get Kopia repository statistics (dedup, compression, etc.)
   */
  async getRepositoryStats(): Promise<RepositoryStats> {
    await this.ensureInitialized();

    try {
      const status = await kopiaClient.getRepositoryStatus();
      const snapshots = await kopiaClient.listSnapshots();
      const backups = snapshots.map(snapshotToMetadata);

      const originalSize = backups.reduce((sum, b) => sum + b.size, 0);

      return {
        totalSize: 0, // Will be populated from repo status when available
        originalSize,
        snapshotCount: backups.length,
        dedupSavings: 0,
        compressionRatio: 0,
        status: status.status ?? 'connected',
      };
    } catch (error) {
      logger.warn({ error }, 'Failed to get repository stats');
      return {
        totalSize: 0,
        originalSize: 0,
        snapshotCount: 0,
        dedupSavings: 0,
        compressionRatio: 0,
        status: 'error',
      };
    }
  }

  async calculateBackupSize(
    options: {
      includePlugins?: boolean;
      includePluginData?: boolean;
      includeHistory?: boolean;
    } = {}
  ): Promise<BackupSizeEstimate> {
    const signalkPath = config.signalkDataPath;
    let configSize = 0;
    let pluginsSize = 0;
    const pluginDataSize = 0;
    let historySize = 0;

    for (const file of CONFIG_FILES) {
      const filePath = join(signalkPath, file);
      if (existsSync(filePath)) {
        const stats = await stat(filePath);
        configSize += stats.size;
      }
    }

    for (const dir of CONFIG_DIRS) {
      const dirPath = join(signalkPath, dir);
      if (existsSync(dirPath)) {
        configSize += await this.getDirSize(dirPath);
      }
    }

    if (options.includePlugins) {
      const nodeModulesPath = join(signalkPath, 'node_modules');
      if (existsSync(nodeModulesPath)) {
        pluginsSize = await this.getDirSize(nodeModulesPath);
      }
    }

    // keeper measured config.historyDataPath here; history is deferred to v2
    // in signalk-backup-server, so historySize stays 0 even when the
    // includeHistory flag is set.
    if (options.includeHistory) {
      historySize = 0;
    }

    const totalSize = configSize + pluginsSize + pluginDataSize + historySize;

    let warning: string | undefined;
    if (totalSize > 100 * 1024 * 1024) {
      warning = `Backup will be ~${Math.round(totalSize / (1024 * 1024))} MB. Kopia deduplication will reduce actual storage needed.`;
    }

    return {
      configSize,
      pluginsSize,
      pluginDataSize,
      historySize,
      totalSize,
      warning,
    };
  }

  private async getDirSize(dirPath: string): Promise<number> {
    let size = 0;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          size += await this.getDirSize(fullPath);
        } else if (entry.isFile()) {
          const stats = await stat(fullPath);
          size += stats.size;
        }
      }
    } catch {
      // Ignore errors (permission issues, etc.)
    }

    return size;
  }

  /**
   * Convert backup to ZIP format for download.
   * Restores snapshot to temp dir, then creates ZIP.
   */
  async createZipFromBackup(id: string, outputPath: string): Promise<boolean> {
    await this.ensureInitialized();

    const backup = await this.getBackup(id);
    if (!backup) return false;

    // keeper used config.backupPath here; in signalk-backup that role is
    // played by config.dataDir (the plugin's data sub-path).
    const tempDir = join(config.dataDir, '.tmp', id);
    await mkdir(tempDir, { recursive: true });

    try {
      // Restore Kopia snapshot to temp directory
      await kopiaClient.restoreSnapshot(id, tempDir);

      // Create ZIP from restored files
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(tempDir, false);
        archive.finalize();
      });

      return true;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Import a backup from uploaded ZIP file
   */
  async importFromZip(zipPath: string, description?: string): Promise<BackupResult> {
    await this.ensureInitialized();

    const tempDir = join(config.dataDir, '.tmp', `import-${Date.now()}`);

    try {
      await mkdir(tempDir, { recursive: true });

      // Extract ZIP
      await new Promise<void>((resolve, reject) => {
        createReadStream(zipPath)
          .pipe(Extract({ path: tempDir }))
          .on('close', resolve)
          .on('error', reject);
      });

      const requiredFiles = ['settings.json', 'security.json'];
      for (const file of requiredFiles) {
        if (!existsSync(join(tempDir, file))) {
          throw new Error(`Invalid backup: missing ${file}`);
        }
      }

      const version = await versionService.getCurrentVersion();

      const tags: Record<string, string> = {
        type: 'manual',
        'signalk-version': JSON.stringify(version ?? UNKNOWN_VERSION),
        'includes-plugins': String(existsSync(join(tempDir, 'node_modules'))),
        'includes-plugin-data': 'false',
        'includes-history': 'false',
      };

      // Create Kopia snapshot from extracted content
      const snapshot = await kopiaClient.createSnapshot(tempDir, {
        tags,
        description: description ?? 'Uploaded backup',
      });

      const metadata = snapshotToMetadata(snapshot);
      logger.info({ backupId: metadata.id }, 'Backup imported from ZIP');

      return {
        success: true,
        backup: metadata,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to import backup from ZIP');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async verifyBackup(id: string): Promise<{ valid: boolean; error?: string }> {
    await this.ensureInitialized();

    const backup = await this.getBackup(id);
    if (!backup) {
      return { valid: false, error: 'Backup not found' };
    }

    const result = await kopiaClient.verifySnapshot(id);
    if (!result.verified) {
      return { valid: false, error: result.errors.join('; ') || 'Verification failed' };
    }

    return { valid: true };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * keeper used config.httpsDataPath to stage HTTPS CA files into the
   * snapshot. signalk-backup-server doesn't manage HTTPS, so this is a
   * no-op. Kept as a method to preserve callers in createBackup().
   */
  private async stageCaFiles(_destDir: string): Promise<void> {
    // No HTTPS in signalk-backup-server. Reference args to satisfy lint.
    void _destDir;
    void CA_FILES;
  }

  /**
   * keeper used config.httpsDataPath to restore HTTPS CA files after a
   * restore. signalk-backup-server doesn't manage HTTPS, so this is a
   * no-op.
   */
  async restoreCaFiles(): Promise<void> {
    // No HTTPS in signalk-backup-server.
    void CA_BACKUP_DIR;
  }
  /**
   * Get the current list of excluded directory patterns.
   * Returns user-configured exclusions, or defaults if none are set.
   */
  async getExclusions(): Promise<string[]> {
    const settings = await settingsService.get();
    return settings.backupExclusions ?? [...DEFAULT_BACKUP_EXCLUSIONS];
  }

  /**
   * Update the list of excluded directory patterns.
   * Deletes all existing snapshots and runs maintenance to reclaim space,
   * since old snapshots still contain data from previously-included directories.
   */
  async setExclusions(exclusions: string[]): Promise<void> {
    // Normalize: ensure trailing slash for directories
    const normalized = exclusions.map((e) => (e.endsWith('/') ? e : `${e}/`));

    // Separate history toggle from regular .kopiaignore exclusions
    const HISTORY_PATTERN = 'history (InfluxDB)/';
    const historyExcluded = normalized.includes(HISTORY_PATTERN);
    const dirExclusions = normalized.filter((e) => e !== HISTORY_PATTERN);

    await settingsService.update({
      backupExclusions: dirExclusions,
      includeHistoryInBackups: !historyExcluded,
    });
    logger.info(
      { exclusions: dirExclusions, includeHistory: !historyExcluded },
      'Backup exclusions updated'
    );

    // Delete all existing snapshots — they contain data based on old exclusions
    try {
      const snapshots = await this.listBackups();
      if (snapshots.length > 0) {
        logger.info(
          { count: snapshots.length },
          'Deleting existing snapshots after exclusion change'
        );
        for (const snapshot of snapshots) {
          await kopiaClient.deleteSnapshot(snapshot.id);
        }
        await kopiaClient.maintenanceRun(true);
        logger.info('Forced maintenance completed after exclusion change');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to clean up snapshots after exclusion change');
    }

    // Create a fresh backup with the new exclusions so the user isn't left with zero backups
    try {
      await this.createBackup({ type: 'manual', description: 'After exclusion change' });
      logger.info('Created fresh backup after exclusion change');
    } catch (error) {
      logger.warn({ error }, 'Failed to create backup after exclusion change');
    }
  }

  /**
   * List top-level directories in the SignalK data directory with sizes
   * and their exclusion status.
   *
   * `excluded`: matches a user-toggleable exclusion in `backupExclusions`.
   *             User can uncheck to include.
   * `lockedExcluded`: matches an architectural always-on exclusion (kopia
   *                   self-dir) or a DB plugin default. The UI should
   *                   render these as locked (read-only checked).
   * `lockReason`: human-readable why a row is locked.
   */
  async getDataDirectories(): Promise<
    Array<{
      name: string;
      size: number;
      excluded: boolean;
      lockedExcluded?: boolean;
      lockReason?: string;
      type?: 'dir' | 'history';
    }>
  > {
    const dataPath = config.signalkDataPath;
    const exclusions = await this.getExclusions();
    const includeHistory = (await settingsService.getSetting('includeHistoryInBackups')) ?? false;

    const entries = await readdir(dataPath, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const results = await Promise.all(
      dirs.map(async (dir) => {
        const dirPath = join(dataPath, dir.name);
        const size = await this.getDirectorySize(dirPath);
        const excluded = this.isExcluded(dir.name, exclusions);
        return {
          name: dir.name,
          size,
          excluded,
          type: 'dir' as const,
        };
      })
    );

    // keeper added a 'history (InfluxDB)' entry from config.historyDataPath
    // here. signalk-backup-server has no host history dir; we drop the row.
    void includeHistory;

    // Sort by size descending
    return results.sort((a, b) => b.size - a.size);
  }

  /**
   * List subdirectories of plugin-config-data with sizes and their
   * exclusion status. Distinct from getDataDirectories() because the UI
   * needs to render plugin-state separately — DB plugins (questdb, grafana,
   * influxdb) are auto-excluded for safety, our own state (signalk-backup)
   * is auto-excluded architecturally, and the user can toggle the rest.
   *
   * Only DB plugins and our own dir are flagged `lockedExcluded` in v0.1
   * — the override toggle for DB data lives in v0.2 (see docs/QuestDB-API
   * integration plan).
   */
  async getPluginDataDirectories(): Promise<
    Array<{
      name: string;
      size: number;
      excluded: boolean;
      lockedExcluded?: boolean;
      lockReason?: string;
    }>
  > {
    const pluginDataPath = join(config.signalkDataPath, 'plugin-config-data');
    if (!existsSync(pluginDataPath)) return [];

    const entries = await readdir(pluginDataPath, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

    const results = await Promise.all(
      dirs.map(async (dir) => {
        const dirPath = join(pluginDataPath, dir.name);
        const size = await this.getDirectorySize(dirPath);
        const lockInfo = this.lockedReasonForPluginDir(dir.name);
        return {
          name: dir.name,
          size,
          excluded: lockInfo !== null,
          lockedExcluded: lockInfo !== null,
          lockReason: lockInfo ?? undefined,
        };
      })
    );
    return results.sort((a, b) => b.size - a.size);
  }

  private lockedReasonForPluginDir(name: string): string | null {
    if (name === 'signalk-backup') {
      return 'Self-exclusion: backing up our own kopia repository would create infinite recursion.';
    }
    // Match against the DB defaults — these patterns are scoped to
    // plugin-config-data/<name>, so strip the prefix when comparing.
    for (const pattern of DB_PLUGIN_DEFAULT_EXCLUSIONS) {
      const stripped = pattern.replace(/^plugin-config-data\//, '').replace(/\/$/, '');
      if (this.matchesGlob(name, stripped)) {
        return 'Live database state — filesystem snapshot may be inconsistent. v0.2 will offer a safe export via the plugin API.';
      }
    }
    return null;
  }

  private matchesGlob(name: string, pattern: string): boolean {
    if (!pattern.includes('*')) return name === pattern;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(name);
  }

  /**
   * Check if a directory name matches any exclusion pattern.
   * Supports trailing slash and glob patterns (e.g., "charts*").
   */
  private isExcluded(dirName: string, exclusions: string[]): boolean {
    for (const pattern of exclusions) {
      const base = pattern.replace(/\/$/, '');
      if (base.includes('*')) {
        // Simple glob: convert "charts*" to regex
        const regex = new RegExp('^' + base.replace(/\*/g, '.*') + '$');
        if (regex.test(dirName)) return true;
      } else {
        if (dirName === base) return true;
      }
    }
    return false;
  }

  /**
   * Get the total size of a directory in bytes.
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let total = 0;
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isFile()) {
          const s = await stat(fullPath);
          total += s.size;
        } else if (entry.isDirectory()) {
          total += await this.getDirectorySize(fullPath);
        }
      }
    } catch {
      // Permission denied or inaccessible — return 0
    }
    return total;
  }
}

export const backupService = new BackupService();
