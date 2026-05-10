/**
 * Backup Migration Service
 *
 * Handles one-time migration from the legacy tar.gz backup format
 * to the new Kopia-based backup system. Runs automatically on
 * first startup when old-style manifest.json is detected.
 */

import { existsSync } from 'fs';
import { readFile, rename, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import * as tar from 'tar';

import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import { kopiaClient } from './kopia-client.js';
import type { BackupMetadata } from '../types/backup.js';

const logger = rootLogger.child({ service: 'backup-migration' });

/** Legacy manifest format */
interface LegacyManifest {
  version: number;
  backups: BackupMetadata[];
  lastUpdated: string;
}

/** Migration result */
export interface MigrationResult {
  migrated: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/**
 * Check if legacy backups need migration
 */
export async function shouldMigrate(): Promise<boolean> {
  const manifestPath = join(config.dataDir, 'manifest.json');
  const migratedPath = join(config.dataDir, 'manifest.json.migrated');

  // Only migrate if old manifest exists and hasn't been migrated yet
  return existsSync(manifestPath) && !existsSync(migratedPath);
}

/**
 * Migrate legacy tar.gz backups to Kopia repository.
 *
 * For each backup in the old manifest:
 * 1. Extract tar.gz to a temp directory
 * 2. Create a Kopia snapshot from the extracted content
 * 3. Tag with original metadata (type, version, etc.)
 *
 * After migration:
 * - manifest.json is renamed to manifest.json.migrated
 * - Old tar.gz files are left in place (user can delete them later)
 */
export async function migrateBackups(
  onProgress?: (message: string) => void
): Promise<MigrationResult> {
  const manifestPath = join(config.dataDir, 'manifest.json');

  const result: MigrationResult = {
    migrated: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Load the old manifest
  let manifest: LegacyManifest;
  try {
    const content = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(content) as LegacyManifest;
  } catch (error) {
    const msg = `Failed to read legacy manifest: ${(error as Error).message}`;
    logger.error(msg);
    result.errors.push(msg);
    return result;
  }

  const totalBackups = manifest.backups.length;
  logger.info({ totalBackups }, 'Starting migration of legacy backups to Kopia');
  onProgress?.(`Starting migration of ${totalBackups} backups...`);

  // Process each backup
  for (let i = 0; i < manifest.backups.length; i++) {
    const backup = manifest.backups[i]!;
    const progress = `[${i + 1}/${totalBackups}]`;

    if (!existsSync(backup.path)) {
      logger.warn({ backupId: backup.id, path: backup.path }, 'Backup file missing, skipping');
      onProgress?.(`${progress} Skipping ${backup.id} (file missing)`);
      result.skipped++;
      continue;
    }

    const tempDir = join(config.dataDir, '.tmp', `migrate-${backup.id}`);

    try {
      // Extract tar.gz to temp directory
      await mkdir(tempDir, { recursive: true });
      await tar.extract({ file: backup.path, cwd: tempDir });

      // Build tags from legacy metadata
      const tags: Record<string, string> = {
        type: backup.type,
        'signalk-version': JSON.stringify(backup.version),
        'includes-plugins': String(backup.includesPlugins),
        'includes-plugin-data': String(backup.includesPluginData ?? false),
        'includes-history': 'false',
        'migrated-from': 'legacy-tar-gz',
      };

      // Create Kopia snapshot from extracted content
      await kopiaClient.createSnapshot(tempDir, {
        tags,
        description:
          backup.description ?? `Migrated ${backup.type} backup from ${backup.createdAt}`,
      });

      result.migrated++;
      logger.info({ backupId: backup.id, type: backup.type }, 'Backup migrated');
      onProgress?.(`${progress} Migrated ${backup.type} backup ${backup.id}`);
    } catch (error) {
      const msg = `Failed to migrate backup ${backup.id}: ${(error as Error).message}`;
      logger.error({ error, backupId: backup.id }, msg);
      result.errors.push(msg);
      result.failed++;
      onProgress?.(`${progress} FAILED: ${backup.id}`);
    } finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Mark migration as complete by renaming the manifest
  try {
    const migratedPath = join(config.dataDir, 'manifest.json.migrated');
    await rename(manifestPath, migratedPath);
    logger.info('Legacy manifest renamed to manifest.json.migrated');
  } catch (error) {
    logger.error({ error }, 'Failed to rename legacy manifest');
  }

  logger.info(
    { migrated: result.migrated, failed: result.failed, skipped: result.skipped },
    'Backup migration completed'
  );
  onProgress?.(
    `Migration complete: ${result.migrated} migrated, ${result.failed} failed, ${result.skipped} skipped`
  );

  return result;
}
