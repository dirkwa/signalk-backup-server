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
import pino from 'pino';

import { config } from '../config/index.js';

const logger = pino({ name: 'settings-service' });

/** Default Kopia repository password (Kopia always requires a password) */
export const DEFAULT_KOPIA_PASSWORD = 'keeperbackup';

/** Cloud sync configuration */
export interface CloudSyncSettings {
  /** Cloud storage provider */
  provider: 'gdrive';
  /** When to sync: manual, after each local backup, or on a schedule */
  syncMode: 'manual' | 'after_backup' | 'scheduled';
  /** Frequency for scheduled sync mode */
  syncFrequency: 'daily' | 'weekly';
  /** ISO timestamp of last successful sync */
  lastSync: string | null;
  /** Error message from last sync attempt, null if last sync succeeded */
  lastSyncError: string | null;
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
  /** Cloud sync configuration (set when Google Drive is connected) */
  cloudSync?: CloudSyncSettings;
  /** Installation identity (computed on first cloud backup setup) */
  identity?: InstallIdentitySettings;
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

      logger.info({ settings: this.settings }, 'Settings loaded');
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
      await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2));
      logger.info({ settings: this.settings }, 'Settings saved');
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

  /**
   * Set a custom backup password.
   * WARNING: Requires re-creating the Kopia repository.
   */
  async setBackupPassword(password: string): Promise<void> {
    await this.update({ backupPassword: password });
    logger.info('Custom backup password set');
  }

  /**
   * Reset to the default backup password.
   * WARNING: Requires re-creating the Kopia repository.
   */
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
