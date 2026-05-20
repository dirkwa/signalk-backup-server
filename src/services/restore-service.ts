import { createActor, type ActorRefFrom } from 'xstate';
import { existsSync } from 'fs';

import { join } from 'path';
import { writeFile, readFile } from 'fs/promises';

import { restoreMachine } from './backup-machine.js';
import { backupService } from './backup-service.js';
import { kopiaClient } from './kopia-client.js';
import { isAnyRestoreActive, registerRestoreActiveProbe } from './restore-lock.js';
import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import type { RestoreContext, RestoreStatus, BackupMetadata } from '../types/backup.js';

// keeper used podmanService here; in signalk-backup the plugin handles
// container/process lifecycle. We drop the npm-install + restart steps and
// instead leave a marker file the plugin/UI can surface to the user.
const RESTORE_PENDING_FILE = 'restore-pending';

const logger = rootLogger.child({ service: 'restore-service' });

export interface RestoreProgress {
  state: RestoreStatus;
  progress: number;
  statusMessage: string;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  backupId: string;
  error?: string;
  duration?: number;
}

class RestoreService {
  private actor: ActorRefFrom<typeof restoreMachine> | null = null;
  private currentBackup: BackupMetadata | null = null;
  private safetyBackupId: string | null = null;
  private startTime: number = 0;

  async restore(
    backupId: string,
    onProgress?: (progress: RestoreProgress) => void
  ): Promise<RestoreResult> {
    // Consult the shared lock so a partial restore in progress blocks a
    // full restore (and vice versa). isRestoring() below is the
    // full-restore self-check; isAnyRestoreActive() covers cross-service.
    if (this.isRestoring() || isAnyRestoreActive()) {
      return {
        success: false,
        backupId,
        error: 'A restore operation is already in progress',
      };
    }

    if (this.actor) {
      this.actor.stop();
      this.actor = null;
    }

    this.startTime = Date.now();

    const backup = await backupService.getBackup(backupId);
    if (!backup) {
      return {
        success: false,
        backupId,
        error: 'Backup not found',
      };
    }

    this.currentBackup = backup;

    this.actor = createActor(restoreMachine);

    if (onProgress) {
      this.actor.subscribe((state) => {
        const context = state.context as RestoreContext;
        onProgress({
          state: state.value as RestoreStatus,
          progress: context.progress,
          statusMessage: context.statusMessage,
          error: context.error || undefined,
        });
      });
    }

    this.actor.start();
    this.actor.send({ type: 'START_RESTORE', backupId });

    logger.info({ backupId, backupPath: backup.path }, 'Starting restore operation');

    try {
      await this.executePrepare();
      await this.executeExtract();
      await this.executeNpmInstall();
      await this.executeRestart();
      await this.executeVerify();

      this.actor.send({ type: 'VERIFY_SUCCESS' });

      const duration = Date.now() - this.startTime;
      logger.info({ backupId, duration }, 'Restore completed successfully');

      return {
        success: true,
        backupId,
        duration,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, backupId }, 'Restore failed');

      this.actor.send({ type: 'ERROR', error: errorMessage });

      if (this.safetyBackupId) {
        try {
          logger.info({ safetyBackupId: this.safetyBackupId }, 'Attempting automatic rollback');
          this.actor.send({ type: 'ROLLBACK' });
          await this.executeRollback();
          this.actor.send({ type: 'ROLLBACK_COMPLETE' });
          logger.info('Rollback completed successfully');
        } catch (rollbackError) {
          logger.error({ rollbackError }, 'Automatic rollback failed');
          this.actor.send({
            type: 'ERROR',
            error: `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          });
        }
      }

      return {
        success: false,
        backupId,
        error: errorMessage,
        duration: Date.now() - this.startTime,
      };
    }
  }

  getProgress(): RestoreProgress | null {
    if (!this.actor) {
      return null;
    }

    const snapshot = this.actor.getSnapshot();
    const context = snapshot.context as RestoreContext;

    return {
      state: snapshot.value as RestoreStatus,
      progress: context.progress,
      statusMessage: context.statusMessage,
      error: context.error || undefined,
    };
  }

  getState(): RestoreStatus {
    if (!this.actor) {
      return 'idle';
    }
    return this.actor.getSnapshot().value as RestoreStatus;
  }

  isRestoring(): boolean {
    const state = this.getState();
    return (
      state !== 'idle' && state !== 'completed' && state !== 'failed' && state !== 'rolled_back'
    );
  }

  reset(): void {
    if (this.actor) {
      this.actor.send({ type: 'RESET' });
    }
    this.currentBackup = null;
    this.safetyBackupId = null;
  }

  private async executePrepare(): Promise<void> {
    logger.info('Creating safety backup before restore');

    this.actor?.send({
      type: 'PROGRESS',
      progress: 5,
      statusMessage: 'Creating safety backup...',
    });

    const safetyResult = await backupService.createBackup({
      type: 'pre-restore',
      description: `Safety backup before restoring ${this.currentBackup?.id}`,
    });

    if (!safetyResult.success || !safetyResult.backup) {
      throw new Error(`Failed to create safety backup: ${safetyResult.error}`);
    }

    this.safetyBackupId = safetyResult.backup.id;

    this.actor?.send({
      type: 'SAFETY_BACKUP_CREATED',
      safetyBackupId: this.safetyBackupId,
    });

    this.actor?.send({ type: 'PREPARE_COMPLETE' });
    logger.info({ safetyBackupId: this.safetyBackupId }, 'Safety backup created');
  }

  private async executeExtract(): Promise<void> {
    if (!this.currentBackup) {
      throw new Error('No backup to restore');
    }

    const signalkPath = config.signalkDataPath;
    logger.info({ backupId: this.currentBackup.id, signalkPath }, 'Restoring backup snapshot');

    this.actor?.send({
      type: 'PROGRESS',
      progress: 25,
      statusMessage: 'Downloading and restoring backup files...',
    });

    await kopiaClient.restoreSnapshotWithProgress(
      this.currentBackup.id,
      signalkPath,
      (progress) => {
        const sizeInfo = progress.restoredSize ? ` (${progress.restoredSize})` : '';
        this.actor?.send({
          type: 'PROGRESS',
          progress: 25,
          statusMessage: `Restored ${progress.restoredFiles} files, ${progress.restoredDirs} directories${sizeInfo}`,
        });
      }
    );

    await backupService.restoreCaFiles();

    // keeper restored history (InfluxDB/Grafana) here via historyBackupService.
    // signalk-backup-server defers history to v2 — if a backup contains a
    // staged history dir (.history-backup) we just leave it on disk for the
    // user to deal with (or for a future v2 to pick up).

    this.actor?.send({ type: 'EXTRACT_COMPLETE' });
    logger.info('Backup snapshot restored successfully');
  }

  private async executeNpmInstall(): Promise<void> {
    const signalkPath = config.signalkDataPath;
    const packageJsonPath = `${signalkPath}/package.json`;

    if (!existsSync(packageJsonPath)) {
      logger.info('No package.json found, skipping npm install');
      this.actor?.send({ type: 'INSTALL_COMPLETE' });
      return;
    }

    // keeper used podmanService here to run `npm install --omit=dev` inside
    // the SignalK container after a restore. signalk-backup-server runs as a
    // SignalK plugin and has no container access — record the need for an
    // npm install in the restore-pending marker so the user/plugin can act.
    logger.info(
      'Restore copied package.json — npm install must happen on next SignalK restart ' +
        '(this would happen if we had container access; please restart SignalK manually)'
    );

    await this.appendPendingMarker(
      'npm install needed: package.json was restored from backup. ' +
        'Restart SignalK so plugins are reinstalled.'
    );

    this.actor?.send({
      type: 'PROGRESS',
      progress: 45,
      statusMessage: 'Plugins will be reinstalled on next SignalK restart',
    });

    this.actor?.send({ type: 'INSTALL_COMPLETE' });
  }

  private async executeRestart(): Promise<void> {
    // keeper used podmanService.restartContainer / systemctl here. In
    // signalk-backup-server the restore runs inside a separate container and
    // has no way to restart its parent SignalK process. Record the need so
    // the host plugin / user can do it manually.
    logger.info(
      'SignalK restart needed (this would happen if we had container access; please restart SignalK manually)'
    );

    await this.appendPendingMarker(
      'SignalK must be restarted to pick up the restored configuration.'
    );

    this.actor?.send({
      type: 'PROGRESS',
      progress: 65,
      statusMessage: 'Restart SignalK manually to apply the restore',
    });

    this.actor?.send({ type: 'RESTART_COMPLETE' });
  }

  private async executeVerify(): Promise<void> {
    // keeper polled SignalK / the podman container here to confirm the server
    // came back up. signalk-backup-server runs alongside SignalK as a plugin
    // and can't drive a restart, so there's nothing to verify — the user
    // restarts SignalK manually. We just record the marker and complete.
    logger.info(
      'Restore file copy complete (this would verify SignalK health if we had container access; please restart SignalK manually)'
    );

    this.actor?.send({
      type: 'PROGRESS',
      progress: 95,
      statusMessage: 'Restore file copy complete — restart SignalK to finish',
    });
  }

  private async executeRollback(): Promise<void> {
    if (!this.safetyBackupId) {
      throw new Error('No safety backup available for rollback');
    }

    const safetyBackup = await backupService.getBackup(this.safetyBackupId);
    if (!safetyBackup) {
      throw new Error('Safety backup not found');
    }

    logger.info({ safetyBackupId: this.safetyBackupId }, 'Rolling back to safety backup');

    const signalkPath = config.signalkDataPath;
    await kopiaClient.restoreSnapshot(this.safetyBackupId, signalkPath);

    // keeper used podmanService / systemctl here to restart SignalK after
    // rollback. signalk-backup-server has no container access; record the
    // need so the user can restart manually.
    await this.appendPendingMarker(
      'Rollback completed: a safety backup was restored. ' +
        'Restart SignalK manually to apply the rollback.'
    );

    logger.info('Rollback completed');
  }

  /**
   * Append a message to the restore-pending marker file. The marker is a
   * simple JSONL log so multiple restore steps each leave a line. The
   * plugin/UI can read it via getPendingRestoreNotification().
   */
  private async appendPendingMarker(message: string): Promise<void> {
    try {
      const path = join(config.dataDir, RESTORE_PENDING_FILE);
      const line =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          message,
        }) + '\n';
      // Read existing content (if any) and append; tolerate missing file.
      let existing = '';
      try {
        existing = await readFile(path, 'utf-8');
      } catch {
        existing = '';
      }
      await writeFile(path, existing + line, 'utf-8');
    } catch (error) {
      logger.warn({ error }, 'Failed to write restore-pending marker (non-fatal)');
    }
  }

  /**
   * Returns the contents of the restore-pending marker file (a JSONL log of
   * actions the user must complete after a restore — typically restarting
   * SignalK), or null if no restore is pending.
   */
  async getPendingRestoreNotification(): Promise<string | null> {
    try {
      const path = join(config.dataDir, RESTORE_PENDING_FILE);
      if (!existsSync(path)) return null;
      const content = await readFile(path, 'utf-8');
      return content.length > 0 ? content : null;
    } catch {
      return null;
    }
  }
}

export const restoreService = new RestoreService();
registerRestoreActiveProbe(() => restoreService.isRestoring());
