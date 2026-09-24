import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ lastSync: null as string | null }));

vi.mock('../../../src/services/logger.js', () => {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { logger };
});

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {
    get: vi.fn(async () => ({
      cloudSync: {
        provider: 'gdrive',
        syncMode: 'scheduled',
        syncFrequency: 'daily',
        lastSync: state.lastSync,
        lastSyncError: null,
      },
    })),
  },
}));

import { cloudSyncService } from '../../../src/services/cloud-sync-service.js';
import { settingsService } from '../../../src/services/settings-service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('scheduled cloud sync', () => {
  let sync: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 24, 12) });
    sync = vi.spyOn(cloudSyncService, 'syncToCloud').mockImplementation(async () => {
      state.lastSync = new Date().toISOString();
    });
  });

  afterEach(() => {
    cloudSyncService.stopSchedule();
    sync.mockRestore();
    vi.useRealTimers();
  });

  it('syncs at startup when overdue, then one interval later', async () => {
    state.lastSync = new Date(Date.now() - 2 * DAY).toISOString();
    await cloudSyncService.startSchedule();

    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  // A manual sync in between must push the scheduled one out rather than trigger a second sync hours later.
  it('lets a sync made outside the schedule move the next run', async () => {
    state.lastSync = new Date(Date.now() - 12 * HOUR).toISOString();
    await cloudSyncService.startSchedule();

    await vi.advanceTimersByTimeAsync(6 * HOUR);
    state.lastSync = new Date().toISOString();

    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(18 * HOUR);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('retries an hour after a failed sync instead of waiting a full interval', async () => {
    state.lastSync = null;
    sync.mockRejectedValueOnce(new Error('offline'));
    await cloudSyncService.startSchedule();

    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not reschedule after being stopped mid-sync', async () => {
    state.lastSync = null;
    let finish: () => void = () => undefined;
    sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await cloudSyncService.startSchedule();
    await vi.advanceTimersByTimeAsync(0);

    cloudSyncService.stopSchedule();
    finish();
    await vi.advanceTimersByTimeAsync(2 * DAY);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not start a sync when stopped while the timer is reading settings', async () => {
    state.lastSync = new Date(Date.now() - DAY + HOUR).toISOString();
    await cloudSyncService.startSchedule();

    const real = vi.mocked(settingsService.get).getMockImplementation()!;
    const pendingRead: { release?: () => void } = {};
    vi.mocked(settingsService.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pendingRead.release = () => void real().then(resolve);
        })
    );

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(pendingRead.release).toBeDefined();
    cloudSyncService.stopSchedule();
    pendingRead.release?.();
    await vi.advanceTimersByTimeAsync(2 * DAY);

    expect(sync).not.toHaveBeenCalled();
  });
});
