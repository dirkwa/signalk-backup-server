import { statfs } from 'fs/promises';
import { logger } from './logger.js';
import { backupService } from './backup-service.js';
import { cloudSyncService, type CloudBackupCompleteOutcome } from './cloud-sync-service.js';
import { backupEvents } from './backup-events.js';
import { config } from '../config/index.js';
import type { SchedulerStatus, BackupResult } from '../types/backup.js';
import type { BackupCompletedEventType } from '../schemas/events.js';

const HOUR_MS = 60 * 60 * 1000;

class BackupScheduler {
  private hourlyInterval: NodeJS.Timeout | null = null;
  private dailyTimeout: NodeJS.Timeout | null = null;
  private weeklyTimeout: NodeJS.Timeout | null = null;
  private enabled = false;
  private lastBackupTime: number = 0;

  async start(): Promise<void> {
    if (this.enabled) {
      logger.debug('Backup scheduler already running');
      return;
    }

    this.enabled = true;
    this.lastBackupTime = await backupService.getLastBackupTime();

    this.scheduleHourly();

    this.scheduleDaily();

    this.scheduleWeekly();

    logger.info('Backup scheduler started');
  }

  stop(): void {
    this.enabled = false;

    if (this.hourlyInterval) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = null;
    }

    if (this.dailyTimeout) {
      clearTimeout(this.dailyTimeout);
      this.dailyTimeout = null;
    }

    if (this.weeklyTimeout) {
      clearTimeout(this.weeklyTimeout);
      this.weeklyTimeout = null;
    }

    logger.info('Backup scheduler stopped');
  }

  private scheduleHourly(): void {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);

    const msUntilNextHour = nextHour.getTime() - now.getTime();

    logger.debug(
      { nextHour: nextHour.toISOString(), msUntil: msUntilNextHour },
      'Scheduling first hourly backup'
    );

    setTimeout(() => {
      if (!this.enabled) return;

      this.triggerHourly();

      // Then run every hour
      this.hourlyInterval = setInterval(() => {
        if (!this.enabled) return;
        this.triggerHourly();
      }, HOUR_MS);
    }, msUntilNextHour);
  }

  private scheduleDaily(): void {
    const scheduleNext = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0); // Next midnight

      const msUntilMidnight = nextMidnight.getTime() - now.getTime();

      logger.debug({ nextRun: nextMidnight.toISOString() }, 'Scheduling daily backup');

      this.dailyTimeout = setTimeout(() => {
        if (!this.enabled) return;
        this.triggerDaily();
        scheduleNext(); // Reschedule for next day
      }, msUntilMidnight);
    };

    scheduleNext();
  }

  private scheduleWeekly(): void {
    const scheduleNext = () => {
      const now = new Date();
      const nextSunday = new Date(now);

      // Find next Sunday
      const daysUntilSunday = (7 - now.getDay()) % 7 || 7; // If today is Sunday, schedule for next Sunday
      nextSunday.setDate(nextSunday.getDate() + daysUntilSunday);
      nextSunday.setHours(0, 0, 0, 0);

      // If we're past midnight on Sunday, schedule for next week
      if (now.getDay() === 0 && now.getHours() >= 0) {
        nextSunday.setDate(nextSunday.getDate() + 7);
      }

      const msUntilSunday = nextSunday.getTime() - now.getTime();

      logger.debug({ nextRun: nextSunday.toISOString() }, 'Scheduling weekly backup');

      this.weeklyTimeout = setTimeout(() => {
        if (!this.enabled) return;
        this.triggerWeekly();
        scheduleNext(); // Reschedule for next week
      }, msUntilSunday);
    };

    scheduleNext();
  }

  async triggerHourly(): Promise<BackupResult> {
    const startedAt = new Date();
    logger.info('Running hourly backup');

    const result = await backupService.createBackup({
      type: 'hourly',
      description: 'Automatic hourly backup',
    });

    await this.recordRunOutcome('hourly', startedAt, result);
    return result;
  }

  async triggerDaily(): Promise<BackupResult> {
    const startedAt = new Date();
    logger.info('Running daily backup');

    const result = await backupService.createBackup({
      type: 'daily',
      description: 'Automatic daily backup',
    });

    await this.recordRunOutcome('daily', startedAt, result);
    return result;
  }

  async triggerWeekly(): Promise<BackupResult> {
    const startedAt = new Date();
    logger.info('Running weekly backup');

    const result = await backupService.createBackup({
      type: 'weekly',
      description: 'Automatic weekly backup',
    });

    await this.recordRunOutcome('weekly', startedAt, result);
    return result;
  }

  /**
   * Trigger a startup backup
   * Only creates backup if >24h since last backup
   */
  async triggerStartup(): Promise<BackupResult | null> {
    const lastBackup = await backupService.getLastBackupTime();
    const hoursSinceLastBackup = (Date.now() - lastBackup) / HOUR_MS;

    if (hoursSinceLastBackup < 24) {
      logger.debug(
        { hoursSinceLastBackup: hoursSinceLastBackup.toFixed(1) },
        'Skipping startup backup - recent backup exists'
      );
      return null;
    }

    const startedAt = new Date();
    logger.info(
      { hoursSinceLastBackup: hoursSinceLastBackup.toFixed(1) },
      'Running startup backup'
    );

    const result = await backupService.createBackup({
      type: 'startup',
      description: `Automatic startup backup (${hoursSinceLastBackup.toFixed(0)}h since last backup)`,
    });

    await this.recordRunOutcome('startup', startedAt, result);
    return result;
  }

  /**
   * Consolidates everything that should happen after a scheduled run resolves:
   *   - update lastBackupTime on success
   *   - structured log (info on success, error on failure)
   *   - chain cloudSyncService.onBackupComplete (only on success — a failed local
   *     snapshot has nothing new to push)
   *   - probe filesystem free-space on the Kopia repo path
   *   - emit a `backup-completed` event so the SSE route + the signalk-backup
   *     plugin (issue dirkwa/signalk-backup#33) can publish SignalK deltas
   *
   * Returns nothing; any error here is non-fatal to the backup itself.
   */
  private async recordRunOutcome(
    tier: BackupCompletedEventType['tier'],
    startedAt: Date,
    result: BackupResult
  ): Promise<void> {
    let cloudOutcome: CloudBackupCompleteOutcome = { result: 'skipped' };

    if (result.success) {
      this.lastBackupTime = Date.now();
      logger.info({ backupId: result.backup?.id }, `${tier} backup completed`);
      try {
        cloudOutcome = await cloudSyncService.onBackupComplete();
      } catch (error) {
        // onBackupComplete already swallows sync failures; an exception here
        // means something deeper went wrong (e.g. settings read). Record it
        // as a cloud failure rather than dropping the whole event.
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ error }, 'onBackupComplete threw unexpectedly');
        cloudOutcome = { result: 'failure', error: message };
      }
    } else {
      logger.error({ error: result.error }, `${tier} backup failed`);
    }

    const fsStats = await this.probeFreeSpace();

    const event: BackupCompletedEventType = {
      type: 'backup-completed',
      tier,
      timestamp: startedAt.toISOString(),
      localResult: result.success ? 'success' : 'failure',
      ...(result.success
        ? {
            localBytes: result.backup?.size ?? 0,
            backupId: result.backup?.id,
          }
        : {
            localError: result.error,
          }),
      ...(cloudOutcome.result !== 'skipped' || cloudOutcome.target
        ? {
            cloudResult: cloudOutcome.result,
            ...(cloudOutcome.target ? { cloudTarget: cloudOutcome.target } : {}),
            ...(cloudOutcome.error ? { cloudError: cloudOutcome.error } : {}),
          }
        : {}),
      freeBytes: fsStats.freeBytes,
      totalBytes: fsStats.totalBytes,
      nextScheduled: nextScheduledTimestamps(),
    };

    backupEvents.emit('backup-completed', event);
  }

  /**
   * Read disk free-space on the Kopia repo filesystem. Failures (path
   * missing, FS not statvfs-capable) collapse to zeros — the plugin treats
   * `totalBytes === 0` as "unknown" and skips the storageLow notification.
   */
  private async probeFreeSpace(): Promise<{ freeBytes: number; totalBytes: number }> {
    try {
      const s = await statfs(config.kopiaRepoPath);
      return {
        freeBytes: s.bsize * s.bavail,
        totalBytes: s.bsize * s.blocks,
      };
    } catch (error) {
      logger.debug({ error }, 'statfs on kopia repo path failed');
      return { freeBytes: 0, totalBytes: 0 };
    }
  }

  async getStatus(): Promise<SchedulerStatus> {
    const counts = {
      hourly: 0,
      daily: 0,
      weekly: 0,
      startup: 0,
      manual: 0,
      total: 0,
    };

    let lastBackup: string | null = null;

    try {
      const backups = await backupService.listBackups();
      counts.total = backups.length;

      for (const backup of backups) {
        if (backup.type in counts) {
          counts[backup.type as keyof typeof counts]++;
        }
      }

      const lastBackupTime = await backupService.getLastBackupTime();
      lastBackup = lastBackupTime > 0 ? new Date(lastBackupTime).toISOString() : null;
    } catch {
      logger.debug('Could not fetch backup counts (service may not be initialized yet)');
    }

    const next = nextScheduledTimestamps();

    return {
      enabled: this.enabled,
      lastBackup,
      nextBackups: {
        hourly: this.enabled ? next.hourly : null,
        daily: this.enabled ? next.daily : null,
        weekly: this.enabled ? next.weekly : null,
      },
      backupCounts: counts,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Compute next-scheduled ISO timestamps for all three tiers from `now`.
 * Pure, side-effect-free — same arithmetic as getStatus() used inline before;
 * extracted so recordRunOutcome can reuse it without bringing a `this`
 * reference into the event payload.
 */
export function nextScheduledTimestamps(now: Date = new Date()): {
  hourly: string;
  daily: string;
  weekly: string;
} {
  const nextHourly = new Date(now);
  nextHourly.setMinutes(0, 0, 0);
  nextHourly.setHours(nextHourly.getHours() + 1);

  const nextDaily = new Date(now);
  nextDaily.setHours(24, 0, 0, 0);

  const nextWeekly = new Date(now);
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
  nextWeekly.setDate(nextWeekly.getDate() + daysUntilSunday);
  nextWeekly.setHours(0, 0, 0, 0);

  return {
    hourly: nextHourly.toISOString(),
    daily: nextDaily.toISOString(),
    weekly: nextWeekly.toISOString(),
  };
}

export const backupScheduler = new BackupScheduler();
