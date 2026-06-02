/**
 * Settings Service - Persistent user settings management
 *
 * Stores settings in a JSON file in the config directory
 * (config.dataDir/settings.json).
 *
 * In keeper this also held container/version-management settings (autostart,
 * release-channel preferences, etc.). signalk-backup-server is backup-only,
 * so we keep just the backup/cloud/identity/excludes fields.
 */

import { promises as fs } from 'fs';
import path from 'path';

import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';

// Child of the shared logger so the redact config (backupPassword,
// password, etc.) applies here too.
const logger = rootLogger.child({ name: 'settings-service' });

/** Default Kopia repository password (Kopia always requires a password) */
export const DEFAULT_KOPIA_PASSWORD = 'keeperbackup';

/**
 * Cloud sync provider identifier. Discriminator for the
 * CloudSyncSettings union.
 *
 * - `gdrive`: Google Drive via rclone (OAuth)
 * - `local`: a path on the host (USB drive, NFS mount, anything the
 *   user has mounted under /media or /mnt). No rclone — kopia writes
 *   to the path directly.
 * - `smb`: SMB/CIFS share (NAS, Synology, TrueNAS, Windows shares,
 *   generic Samba) via rclone's smb backend. Credentials live in
 *   rclone.conf in clear text (matching `rclone config`'s default).
 */
export type CloudSyncProvider = 'gdrive' | 'local' | 'smb';

/** Fields shared by every variant of CloudSyncSettings. */
export interface CloudSyncSettingsBase {
  /** When to sync: manual, after each local backup, or on a schedule */
  syncMode: 'manual' | 'after_backup' | 'scheduled';
  /** Frequency for scheduled sync mode */
  syncFrequency: 'daily' | 'weekly';
  /** ISO timestamp of last successful sync */
  lastSync: string | null;
  /** Error message from last sync attempt, null if last sync succeeded */
  lastSyncError: string | null;
}

/** Google Drive cloud sync configuration. */
export interface GDriveCloudSyncSettings extends CloudSyncSettingsBase {
  provider: 'gdrive';
}

/**
 * Local-path cloud sync configuration (USB drive, mounted folder, NFS,
 * anything mounted on the host). The path is expressed as it appears
 * **inside the backup-server container** — the plugin is responsible
 * for arranging the host→container bind mount via signalk-container's
 * `volumes` field with `ifMissing: 'skip'` policy on baseline mounts
 * like /media and /mnt.
 *
 * Per the v0.3 multi-destination plan, the plugin baseline-mounts
 * `/media → /host-media` and `/mnt → /host-mnt`. So a USB drive at
 * host `/media/dirk/USB-SSD` is reachable inside the container as
 * `/host-media/dirk/USB-SSD`. That's what gets stored here.
 */
export interface LocalCloudSyncSettings extends CloudSyncSettingsBase {
  provider: 'local';
  /**
   * Container-side path where backups will be written. Always under
   * `/host-media` or `/host-mnt`; the plugin's discovery API surfaces
   * candidates by walking those baseline mounts.
   */
  containerPath: string;
  /**
   * Original host-side path the user picked, kept for display in the
   * UI ("backing up to /media/dirk/USB-SSD"). Not used for I/O.
   */
  hostPath: string;
}

/**
 * SMB / CIFS share cloud sync configuration. The actual password is
 * persisted only in rclone.conf (mode 0o600) — never in settings.json
 * — so a settings.json copy doesn't leak share credentials.
 */
export interface SmbCloudSyncSettings extends CloudSyncSettingsBase {
  provider: 'smb';
  /** Hostname or IP, e.g. "synology.local" or "192.168.1.50". */
  host: string;
  /** Share name (no leading slash, no host), e.g. "backups". */
  share: string;
  /** SMB user. */
  user: string;
  /** Optional NetBIOS / NTLM domain; defaults to WORKGROUP. */
  domain?: string;
}

/**
 * Cloud sync configuration — discriminated on `provider`.
 *
 * Add a new variant by:
 *  1. extending CloudSyncProvider with the new id,
 *  2. adding an interface `XxxCloudSyncSettings extends CloudSyncSettingsBase`
 *     with `provider: 'xxx'` and any variant-specific fields,
 *  3. adding it to this union,
 *  4. extending `migrateCloudSyncSettings()` below if needed.
 */
export type CloudSyncSettings =
  | GDriveCloudSyncSettings
  | LocalCloudSyncSettings
  | SmbCloudSyncSettings;

/**
 * Migrate an arbitrary loaded `cloudSync` blob into the canonical
 * discriminated-union form. Old settings.json files predate the union
 * shape — `provider` may be missing or unknown. Treat anything we
 * don't recognise as `gdrive` (the only variant that existed before
 * the refactor), preserving the rest of the shape.
 *
 * Returns undefined when input is null/undefined or wholly malformed.
 */
export function migrateCloudSyncSettings(input: unknown): CloudSyncSettings | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const base: CloudSyncSettingsBase = {
    syncMode: (raw.syncMode as CloudSyncSettingsBase['syncMode']) ?? 'manual',
    syncFrequency: (raw.syncFrequency as CloudSyncSettingsBase['syncFrequency']) ?? 'daily',
    lastSync: typeof raw.lastSync === 'string' ? raw.lastSync : null,
    lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
  };
  if (raw.provider === 'local' && typeof raw.containerPath === 'string') {
    return {
      provider: 'local',
      ...base,
      containerPath: raw.containerPath,
      hostPath: typeof raw.hostPath === 'string' ? raw.hostPath : raw.containerPath,
    };
  }
  if (raw.provider === 'smb') {
    // Reject empty/whitespace-only required fields — those would
    // produce an unusable rclone.conf section and silently land users
    // on a broken provider.
    const host = typeof raw.host === 'string' ? raw.host.trim() : '';
    const share = typeof raw.share === 'string' ? raw.share.trim() : '';
    const user = typeof raw.user === 'string' ? raw.user.trim() : '';
    if (host && share && user) {
      const domain = typeof raw.domain === 'string' ? raw.domain.trim() : '';
      return {
        provider: 'smb',
        ...base,
        host,
        share,
        user,
        ...(domain ? { domain } : {}),
      };
    }
    // Fall through to gdrive default — settings.json had a
    // half-formed smb blob, treat as not configured.
  }
  // Default: gdrive. Anything we don't recognise falls through.
  return { provider: 'gdrive', ...base };
}

/** Installation identity for cloud backup folder naming */
export interface InstallIdentitySettings {
  /** Human-readable name (e.g., "SV-Wanderlust-RPi4") */
  installName: string;
  /** 4-char hex ID derived from server UUID */
  installId: string;
  /** SignalK server UUID */
  serverUUID: string;
  /** Cloud backup folder name: "{installName}-{installId}" */
  folderId: string;
  /** Vessel name from SignalK settings */
  vesselName: string;
  /** Hardware description */
  hardware: string;
}

/** User-configurable settings */
export interface BackupServerSettings {
  /** Enable automatic backups (hourly/daily/weekly/startup) */
  backupsEnabled: boolean;
  /** Custom backup password. When absent, DEFAULT_KOPIA_PASSWORD is used. */
  backupPassword?: string;
  /** Directories to exclude from backups (relative to SignalK data dir) */
  backupExclusions?: string[];
  /** Include InfluxDB/Grafana history data in backups (deferred to v2 — flag preserved for compat) */
  includeHistoryInBackups?: boolean;
  /** Per-tier retention limits. Falls back to DEFAULT_RETENTION when absent. */
  retention?: RetentionSettings;
  /** Cloud sync configuration (set when Google Drive is connected) */
  cloudSync?: CloudSyncSettings;
  /** Installation identity (computed on first cloud backup setup) */
  identity?: InstallIdentitySettings;
}

// Kept separate from kopia's RetentionConfig so settings-service stays decoupled.
export interface RetentionSettings {
  hourly: number;
  daily: number;
  weekly: number;
  startup: number;
}

/**
 * Compat alias for code copied from keeper that still references the old
 * KeeperSettings name. New code should use BackupServerSettings.
 */
export type KeeperSettings = BackupServerSettings;

/** Default settings */
const DEFAULT_SETTINGS: BackupServerSettings = {
  backupsEnabled: true,
};

export class SettingsService {
  private settingsPath: string;
  private settings: BackupServerSettings | null = null;

  constructor(configDir: string = config.dataDir) {
    this.settingsPath = path.join(configDir, 'settings.json');
  }

  /**
   * Load settings from disk
   */
  async load(): Promise<BackupServerSettings> {
    if (this.settings) {
      return this.settings;
    }

    try {
      const data = await fs.readFile(this.settingsPath, 'utf-8');
      const loaded = JSON.parse(data) as Record<string, unknown>;

      // Strip keeper-only top-level fields that may exist in older settings
      // files copied from a keeper install (autostart, version).
      delete loaded.autostart;
      delete loaded.version;

      this.settings = {
        ...DEFAULT_SETTINGS,
        ...loaded,
      } as BackupServerSettings;

      // Migration: normalise cloudSync into the discriminated-union shape.
      // Old settings.json files have `provider: 'gdrive'` already, but the
      // migration helper also tolerates missing/unknown provider values.
      if (this.settings.cloudSync !== undefined) {
        const migrated = migrateCloudSyncSettings(this.settings.cloudSync);
        this.settings.cloudSync = migrated;
      }

      // Migration: convert old encryption.password to backupPassword
      const legacy = (loaded as Record<string, unknown>).encryption as
        | { enabled?: boolean; password?: string }
        | undefined;
      if (legacy?.enabled && legacy.password) {
        this.settings.backupPassword = legacy.password;
        delete (loaded as Record<string, unknown>).encryption;
        this.settings = { ...DEFAULT_SETTINGS, ...loaded } as BackupServerSettings;
        await this.save();
        logger.info('Migrated encryption password to backupPassword');
      } else if (legacy) {
        delete (loaded as Record<string, unknown>).encryption;
        this.settings = { ...DEFAULT_SETTINGS, ...loaded } as BackupServerSettings;
        await this.save();
        logger.info('Removed legacy encryption config');
      }

      logger.info('Settings loaded');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, use defaults
        logger.info('No settings file found, using defaults');
        this.settings = { ...DEFAULT_SETTINGS };
        // Save defaults to create the file
        await this.save();
      } else {
        logger.error({ error }, 'Failed to load settings, using defaults');
        this.settings = { ...DEFAULT_SETTINGS };
      }
    }

    return this.settings;
  }

  /**
   * Save settings to disk
   */
  async save(): Promise<void> {
    if (!this.settings) {
      this.settings = { ...DEFAULT_SETTINGS };
    }

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
      // 0o600 = owner-only; file contains the kopia repo password in plaintext.
      await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), {
        mode: 0o600,
      });
      // writeFile's `mode` only applies on CREATE — chmod fixes pre-existing files.
      try {
        await fs.chmod(this.settingsPath, 0o600);
      } catch (chmodErr) {
        logger.warn({ err: chmodErr }, 'Could not chmod settings.json to 0o600');
      }
      logger.info('Settings saved');
    } catch (error) {
      logger.error({ error }, 'Failed to save settings');
      throw error;
    }
  }

  /**
   * Get current settings
   */
  async get(): Promise<BackupServerSettings> {
    if (!this.settings) {
      await this.load();
    }
    return this.settings!;
  }

  /**
   * Update settings
   */
  async update(updates: Partial<BackupServerSettings>): Promise<BackupServerSettings> {
    if (!this.settings) {
      await this.load();
    }

    this.settings = { ...this.settings!, ...updates };
    await this.save();
    return this.settings;
  }

  /**
   * Get a specific setting
   */
  async getSetting<K extends keyof BackupServerSettings>(key: K): Promise<BackupServerSettings[K]> {
    const settings = await this.get();
    return settings[key];
  }

  /**
   * Set a specific setting
   */
  async setSetting<K extends keyof BackupServerSettings>(
    key: K,
    value: BackupServerSettings[K]
  ): Promise<BackupServerSettings> {
    return this.update({ [key]: value } as Partial<BackupServerSettings>);
  }

  /**
   * Get the Kopia repository password. Always returns a string.
   * Returns custom password if set, otherwise the default.
   */
  async getKopiaPassword(): Promise<string> {
    const settings = await this.get();
    return settings.backupPassword ?? DEFAULT_KOPIA_PASSWORD;
  }

  /**
   * Check if a custom backup password has been set.
   */
  async hasCustomPassword(): Promise<boolean> {
    const settings = await this.get();
    return !!settings.backupPassword;
  }

  // Records the password in settings; the route re-keys the repo (rekeyRepository) before calling this.
  async setBackupPassword(password: string): Promise<void> {
    await this.update({ backupPassword: password });
    logger.info('Custom backup password set');
  }

  // Clears the custom password from settings; the route re-keys the repo to the default before calling this.
  async resetBackupPassword(): Promise<void> {
    const settings = await this.get();
    delete settings.backupPassword;
    this.settings = settings;
    await this.save();
    logger.info('Backup password reset to default');
  }

  /**
   * Return settings safe for API responses (excludes sensitive fields)
   */
  async getPublicSettings(): Promise<
    Omit<BackupServerSettings, 'backupPassword'> & { hasCustomPassword: boolean }
  > {
    const settings = await this.get();
    const { backupPassword, ...rest } = settings;
    return {
      ...rest,
      hasCustomPassword: !!backupPassword,
    };
  }
}

/** Singleton instance */
export const settingsService = new SettingsService();
