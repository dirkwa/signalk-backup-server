import { logger } from './logger.js';
import { backupService } from './backup-service.js';
import { cloudSyncService } from './cloud-sync-service.js';
import type { SchedulerStatus, BackupResult } from '../types/backup.js';

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
    logger.info('Running hourly backup');

    const result = await backupService.createBackup({
      type: 'hourly',
      description: 'Automatic hourly backup',
    });

    if (result.success) {
      this.lastBackupTime = Date.now();
      logger.info({ backupId: result.backup?.id }, 'Hourly backup completed');
      cloudSyncService.onBackupComplete().catch(() => {});
    } else {
      logger.error({ error: result.error }, 'Hourly backup failed');
    }

    return result;
  }

  async triggerDaily(): Promise<BackupResult> {
    logger.info('Running daily backup');

    const result = await backupService.createBackup({
      type: 'daily',
      description: 'Automatic daily backup',
    });

    if (result.success) {
      this.lastBackupTime = Date.now();
      logger.info({ backupId: result.backup?.id }, 'Daily backup completed');
      cloudSyncService.onBackupComplete().catch(() => {});
    } else {
      logger.error({ error: result.error }, 'Daily backup failed');
    }

    return result;
  }

  async triggerWeekly(): Promise<BackupResult> {
    logger.info('Running weekly backup');

    const result = await backupService.createBackup({
      type: 'weekly',
      description: 'Automatic weekly backup',
    });

    if (result.success) {
      this.lastBackupTime = Date.now();
      logger.info({ backupId: result.backup?.id }, 'Weekly backup completed');
      cloudSyncService.onBackupComplete().catch(() => {});
    } else {
      logger.error({ error: result.error }, 'Weekly backup failed');
    }

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

    logger.info(
      { hoursSinceLastBackup: hoursSinceLastBackup.toFixed(1) },
      'Running startup backup'
    );

    const result = await backupService.createBackup({
      type: 'startup',
      description: `Automatic startup backup (${hoursSinceLastBackup.toFixed(0)}h since last backup)`,
    });

    if (result.success) {
      this.lastBackupTime = Date.now();
      logger.info({ backupId: result.backup?.id }, 'Startup backup completed');
      cloudSyncService.onBackupComplete().catch(() => {});
    } else {
      logger.error({ error: result.error }, 'Startup backup failed');
    }

    return result;
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

    const now = new Date();

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
      enabled: this.enabled,
      lastBackup,
      nextBackups: {
        hourly: this.enabled ? nextHourly.toISOString() : null,
        daily: this.enabled ? nextDaily.toISOString() : null,
        weekly: this.enabled ? nextWeekly.toISOString() : null,
      },
      backupCounts: counts,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const backupScheduler = new BackupScheduler();
