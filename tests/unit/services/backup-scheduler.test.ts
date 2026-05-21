// WHY scope: timer-based scheduling is left alone; only the new SSE emission path is verified.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockConfig = { kopiaRepoPath: '/tmp/kopia-repo-test' };
vi.mock('../../../src/config/index.js', () => ({
  config: mockConfig,
}));

const mockCreateBackup = vi.fn();
const mockGetLastBackupTime = vi.fn().mockResolvedValue(0);
const mockListBackups = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/services/backup-service.js', () => ({
  backupService: {
    createBackup: mockCreateBackup,
    getLastBackupTime: mockGetLastBackupTime,
    listBackups: mockListBackups,
  },
}));

const mockOnBackupComplete = vi.fn();
vi.mock('../../../src/services/cloud-sync-service.js', () => ({
  cloudSyncService: {
    onBackupComplete: mockOnBackupComplete,
  },
}));

// statfs is called via fs/promises inside the scheduler. We mock the whole
// module so other fs/promises imports (none in scheduler today) still work
// via vi.importActual.
const mockStatfs = vi.fn();
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    statfs: mockStatfs,
  };
});

const { backupScheduler, nextScheduledTimestamps } = await import(
  '../../../src/services/backup-scheduler.js'
);
const { backupEvents } = await import('../../../src/services/backup-events.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLastBackupTime.mockResolvedValue(0);
  mockOnBackupComplete.mockResolvedValue({ result: 'skipped' });
  // 1 KiB blocks × (10 free of 100 total) → 10 KB free, 100 KB total
  mockStatfs.mockResolvedValue({ bsize: 1024, bavail: 10, blocks: 100 });
});

function captureNextEvent(): Promise<unknown> {
  return new Promise((resolve) => {
    backupEvents.once('backup-completed', resolve);
  });
}

describe('triggerHourly emits backup-completed', () => {
  it('on success: localResult=success, includes backupId + localBytes', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-123', size: 4096 },
    });

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as {
      type: string;
      tier: string;
      localResult: string;
      backupId?: string;
      localBytes?: number;
      freeBytes: number;
      totalBytes: number;
      nextScheduled: { hourly: string; daily: string; weekly: string };
    };

    expect(event.type).toBe('backup-completed');
    expect(event.tier).toBe('hourly');
    expect(event.localResult).toBe('success');
    expect(event.backupId).toBe('snap-123');
    expect(event.localBytes).toBe(4096);
    expect(event.freeBytes).toBe(1024 * 10);
    expect(event.totalBytes).toBe(1024 * 100);
    expect(typeof event.nextScheduled.hourly).toBe('string');
    expect(typeof event.nextScheduled.daily).toBe('string');
    expect(typeof event.nextScheduled.weekly).toBe('string');
  });

  it('omits localBytes entirely when backup metadata lacks a size', async () => {
    // WHY: 0 would look like a 0-byte snapshot. Missing field signals "unknown size".
    mockCreateBackup.mockResolvedValue({ success: true, backup: { id: 'snap-no-size' } });

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as { localBytes?: number; backupId?: string };

    expect(event.localBytes).toBeUndefined();
    expect(event.backupId).toBe('snap-no-size');
  });

  it('on failure: localResult=failure, localError set, no backupId', async () => {
    mockCreateBackup.mockResolvedValue({
      success: false,
      error: 'ENOSPC: no space left on device',
    });

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as {
      localResult: string;
      localError?: string;
      backupId?: string;
      localBytes?: number;
    };

    expect(event.localResult).toBe('failure');
    expect(event.localError).toBe('ENOSPC: no space left on device');
    expect(event.backupId).toBeUndefined();
    expect(event.localBytes).toBeUndefined();
  });

  it('cloud failure surfaces as cloudResult=failure with cloudTarget + cloudError', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-1', size: 1 },
    });
    mockOnBackupComplete.mockResolvedValue({
      result: 'failure',
      target: 'gdrive',
      error: '403 quota exceeded',
    });

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as {
      localResult: string;
      cloudResult?: string;
      cloudTarget?: string;
      cloudError?: string;
    };

    expect(event.localResult).toBe('success');
    expect(event.cloudResult).toBe('failure');
    expect(event.cloudTarget).toBe('gdrive');
    expect(event.cloudError).toBe('403 quota exceeded');
  });

  it('does not call cloud sync when local backup fails', async () => {
    mockCreateBackup.mockResolvedValue({ success: false, error: 'kopia exit 1' });

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    await eventP;

    expect(mockOnBackupComplete).not.toHaveBeenCalled();
  });

  it('absorbs onBackupComplete throwing and reports as cloudResult=failure', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-1', size: 1 },
    });
    mockOnBackupComplete.mockRejectedValue(new Error('settings read failed'));

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as { cloudResult?: string; cloudError?: string };

    expect(event.cloudResult).toBe('failure');
    expect(event.cloudError).toContain('settings read failed');
  });

  it('statfs failure collapses to freeBytes=0, totalBytes=0', async () => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-1', size: 1 },
    });
    mockStatfs.mockRejectedValue(new Error('ENOENT'));

    const eventP = captureNextEvent();
    await backupScheduler.triggerHourly();
    const event = (await eventP) as { freeBytes: number; totalBytes: number };

    expect(event.freeBytes).toBe(0);
    expect(event.totalBytes).toBe(0);
  });
});

describe('triggerDaily / triggerWeekly / triggerStartup', () => {
  it.each([
    ['triggerDaily', 'daily'],
    ['triggerWeekly', 'weekly'],
  ] as const)('%s emits tier=%s', async (method, tier) => {
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-1', size: 1 },
    });

    const eventP = captureNextEvent();
    await backupScheduler[method]();
    const event = (await eventP) as { tier: string };

    expect(event.tier).toBe(tier);
  });

  it('triggerStartup skips when last backup <24h ago', async () => {
    // Last backup 1 hour ago.
    mockGetLastBackupTime.mockResolvedValue(Date.now() - 60 * 60 * 1000);

    let received: unknown = null;
    const handler = (e: unknown): void => {
      received = e;
    };
    backupEvents.on('backup-completed', handler);
    try {
      const result = await backupScheduler.triggerStartup();
      expect(result).toBeNull();
      expect(received).toBeNull();
      expect(mockCreateBackup).not.toHaveBeenCalled();
    } finally {
      backupEvents.off('backup-completed', handler);
    }
  });

  it('triggerStartup runs and emits when last backup >24h ago', async () => {
    mockGetLastBackupTime.mockResolvedValue(Date.now() - 48 * 60 * 60 * 1000);
    mockCreateBackup.mockResolvedValue({
      success: true,
      backup: { id: 'snap-startup', size: 999 },
    });

    const eventP = captureNextEvent();
    await backupScheduler.triggerStartup();
    const event = (await eventP) as { tier: string; localBytes?: number };

    expect(event.tier).toBe('startup');
    expect(event.localBytes).toBe(999);
  });
});

describe('nextScheduledTimestamps', () => {
  it('produces three ISO timestamps strictly after `now`', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const next = nextScheduledTimestamps(now);
    expect(new Date(next.hourly).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(next.daily).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(next.weekly).getTime()).toBeGreaterThan(now.getTime());
  });

  it('weekly lands on a Sunday in the local timezone', () => {
    // The scheduler computes the next Sunday using local-time day-of-week
    // arithmetic (`getDay()`, `setDate`, `setHours(0,0,0,0)`). Reflect that
    // here so the test is timezone-agnostic.
    const now = new Date('2026-05-21T12:00:00Z'); // Thursday in UTC; weekday varies by TZ
    const { weekly } = nextScheduledTimestamps(now);
    expect(new Date(weekly).getDay()).toBe(0);
  });
});
