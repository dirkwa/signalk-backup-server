/**
 * Backup and restore types
 */

import type { ImageVersion } from './version.js';

/** Backup trigger type - extended for tiered retention */
export type BackupType =
  | 'hourly' // Automatic hourly backup
  | 'daily' // Automatic daily backup (midnight)
  | 'weekly' // Automatic weekly backup (Sunday midnight)
  | 'startup' // On SignalK start (if >24h since last backup)
  | 'manual' // User-triggered backup
  | 'pre-update' // Before SignalK version update
  | 'pre-restore'; // Safety backup before restore

/** Backup metadata */
export interface BackupMetadata {
  /** Unique backup identifier (Kopia snapshot manifest ID) */
  id: string;
  /** Backup creation timestamp (ISO 8601) */
  createdAt: string;
  /** SignalK version at backup time */
  version: ImageVersion;
  /** What triggered the backup */
  type: BackupType;
  /** Backup size in bytes */
  size: number;
  /** Snapshot reference (kopia snapshot ID) */
  path: string;
  /** User-provided description */
  description?: string;
  /** Integrity reference (managed by Kopia) */
  checksum: string;
  /** Whether plugins node_modules were included */
  includesPlugins: boolean;
  /** Whether plugin data (e.g., signalk-parquet) was included */
  includesPluginData?: boolean;
  /** Whether history data (InfluxDB + Grafana) was included */
  includesHistory?: boolean;
}

/** Tiered retention configuration */
export interface RetentionConfig {
  /** Number of hourly backups to keep (default: 24) */
  hourly: number;
  /** Number of daily backups to keep (default: 7) */
  daily: number;
  /** Number of weekly backups to keep (default: 4) */
  weekly: number;
  /** Number of startup backups to keep (default: 3) */
  startup: number;
  // manual backups are never auto-deleted
}

/** Default retention values */
export const DEFAULT_RETENTION: RetentionConfig = {
  hourly: 24,
  daily: 7,
  weekly: 4,
  startup: 3,
};

/** Backup creation request */
export interface BackupRequest {
  /** Optional description for the backup */
  description?: string;
  /** Backup type (defaults to 'manual') */
  type?: BackupType;
  /** Include plugins in backup (overrides config) */
  includePlugins?: boolean;
  /** Include plugin data directories (e.g., signalk-parquet data) */
  includePluginData?: boolean;
  /** Include history data (InfluxDB + Grafana) in backup */
  includeHistory?: boolean;
}

/** Backup creation result */
export interface BackupResult {
  success: boolean;
  backup?: BackupMetadata;
  error?: string;
}

/** Cloud restore operation phase */
export type CloudRestorePhase = 'idle' | 'syncing' | 'listing' | 'ready' | 'failed';

/** Cloud restore prepare result */
export interface CloudRestorePrepareResult {
  phase: CloudRestorePhase;
  snapshots: BackupMetadata[];
  error?: string;
}

/** Restore operation status */
export type RestoreStatus =
  | 'idle'
  | 'preparing'
  | 'extracting'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back';

/** Restore operation context for state machine */
export interface RestoreContext {
  /** Backup ID being restored */
  backupId: string | null;
  /** Safety backup ID (created before restore) */
  safetyBackupId: string | null;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current status message */
  statusMessage: string;
  /** Error message if failed */
  error: string | null;
  /** Timestamp when restore started */
  startedAt: string | null;
  /** Timestamp when restore completed */
  completedAt: string | null;
}

/** Initial restore context */
export const initialRestoreContext: RestoreContext = {
  backupId: null,
  safetyBackupId: null,
  progress: 0,
  statusMessage: '',
  error: null,
  startedAt: null,
  completedAt: null,
};

/** Restore state machine events */
export type RestoreEvent =
  | { type: 'START_RESTORE'; backupId: string }
  | { type: 'PROGRESS'; progress: number; statusMessage: string }
  | { type: 'SAFETY_BACKUP_CREATED'; safetyBackupId: string }
  | { type: 'PREPARE_COMPLETE' }
  | { type: 'EXTRACT_COMPLETE' }
  | { type: 'INSTALL_COMPLETE' }
  | { type: 'RESTART_COMPLETE' }
  | { type: 'VERIFY_SUCCESS' }
  | { type: 'VERIFY_FAILED'; reason: string }
  | { type: 'ERROR'; error: string }
  | { type: 'ROLLBACK' }
  | { type: 'ROLLBACK_COMPLETE' }
  | { type: 'RESET' };

/** Restore request */
export interface RestoreRequest {
  /** Backup ID to restore from */
  backupId: string;
  /** Restart SignalK after restore */
  restartAfterRestore: boolean;
}

/** Restore result */
export interface RestoreResult {
  success: boolean;
  backupId: string;
  error?: string;
}

/** Scheduler status */
export interface SchedulerStatus {
  /** Whether automatic backups are enabled */
  enabled: boolean;
  /** Timestamp of last backup (any type) */
  lastBackup: string | null;
  /** Scheduled next backup times */
  nextBackups: {
    hourly: string | null;
    daily: string | null;
    weekly: string | null;
  };
  /** Current backup counts by type */
  backupCounts: {
    hourly: number;
    daily: number;
    weekly: number;
    startup: number;
    manual: number;
    total: number;
  };
}

/** Storage statistics */
export interface StorageStats {
  /** Total backup storage used in bytes */
  totalSize: number;
  /** Backup count by type */
  countByType: Record<BackupType, number>;
  /** Size by type in bytes */
  sizeByType: Record<BackupType, number>;
  /** Oldest backup timestamp */
  oldestBackup: string | null;
  /** Newest backup timestamp */
  newestBackup: string | null;
}

/** Cleanup result */
export interface CleanupResult {
  /** Number of backups deleted */
  deletedCount: number;
  /** Total space freed in bytes */
  freedBytes: number;
  /** IDs of deleted backups */
  deletedIds: string[];
}

/** Upload request (for uploaded .zip files) */
export interface UploadRequest {
  /** Whether to restore immediately after upload */
  restoreImmediately: boolean;
  /** Optional description for the imported backup */
  description?: string;
}

/** Upload result */
export interface UploadResult {
  success: boolean;
  /** The imported backup metadata */
  backup?: BackupMetadata;
  /** Restore status if restoreImmediately was true */
  restoreStatus?: RestoreStatus;
  error?: string;
}

/** Size estimate for backup options */
export interface BackupSizeEstimate {
  /** Config files size */
  configSize: number;
  /** Plugin node_modules size (if includePlugins) */
  pluginsSize: number;
  /** Plugin data size (if includePluginData) */
  pluginDataSize: number;
  /** History data size (if includeHistory) */
  historySize: number;
  /** Total estimated size */
  totalSize: number;
  /** Warning message if backup would be large */
  warning?: string;
}

/** Kopia repository statistics */
export interface RepositoryStats {
  /** Total repository size on disk in bytes */
  totalSize: number;
  /** Total original data size across all snapshots */
  originalSize: number;
  /** Number of snapshots */
  snapshotCount: number;
  /** Deduplication savings in bytes */
  dedupSavings: number;
  /** Compression ratio (0-1, where 0.5 means 50% compression) */
  compressionRatio: number;
  /** Repository status */
  status: string;
}
