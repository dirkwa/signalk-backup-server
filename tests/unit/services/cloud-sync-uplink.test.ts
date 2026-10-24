import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({
  cloudSync: {
    provider: 'gdrive' as 'gdrive' | 'smb',
    syncMode: 'scheduled' as 'scheduled' | 'after_backup',
    syncFrequency: 'daily' as const,
    lastSync: null as string | null,
    lastSyncError: null,
    host: 'nas.local',
    share: 'backups',
    user: 'signalk',
  },
}));

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
    get: vi.fn(async () => ({ cloudSync: { ...settingsState.cloudSync } })),
    update: vi.fn(async () => undefined),
  },
}));

vi.mock('../../../src/services/gdrive-auth-service.js', () => ({
  RCLONE_GDRIVE_REMOTE_NAME: 'gdrive',
  gdriveAuthService: {
    getStatus: vi.fn(async () => ({ connected: true, configured: true })),
  },
}));

vi.mock('../../../src/services/smb-auth-service.js', () => ({
  RCLONE_SMB_REMOTE_NAME: 'smb',
  smbAuthService: {
    getStatus: vi.fn(async () => ({ connected: true, configured: true })),
  },
}));

// getStatus probes the internet for a gdrive target; never let it reach the network.
vi.mock('net', async (importOriginal) => {
  const { EventEmitter } = await import('events');
  return {
    ...(await importOriginal<typeof import('net')>()),
    connect: () => {
      const socket = new EventEmitter();
      queueMicrotask(() => socket.emit('error', new Error('offline')));
      return Object.assign(socket, { destroy: vi.fn() });
    },
  };
});

import { cloudSyncService } from '../../../src/services/cloud-sync-service.js';
import { gdriveAuthService } from '../../../src/services/gdrive-auth-service.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('automatic cloud sync and the internet link', () => {
  let sync: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 23, 12) });
    settingsState.cloudSync.provider = 'gdrive';
    settingsState.cloudSync.syncMode = 'scheduled';
    settingsState.cloudSync.lastSync = new Date(Date.now() - 2 * DAY).toISOString();
    sync = vi.spyOn(cloudSyncService, 'syncToCloud').mockImplementation(async () => {
      settingsState.cloudSync.lastSync = new Date().toISOString();
    });
  });

  afterEach(async () => {
    // Leaving a held state restarts the schedule asynchronously; let that settle before stopping it.
    cloudSyncService.setUplinkState(null);
    await vi.advanceTimersByTimeAsync(0);
    cloudSyncService.stopSchedule();
    sync.mockRestore();
    vi.useRealTimers();
  });

  it.each(['metered', 'captive', 'offline'] as const)(
    'holds an overdue scheduled sync while the link is %s',
    async (state) => {
      cloudSyncService.setUplinkState(state);
      await cloudSyncService.startSchedule();

      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(sync).not.toHaveBeenCalled();
    }
  );

  it('runs the held sync as soon as the link is online again', async () => {
    cloudSyncService.setUplinkState('metered');
    await cloudSyncService.startSchedule();
    await vi.advanceTimersByTimeAsync(0);

    cloudSyncService.setUplinkState('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('syncs on schedule when no link state is known', async () => {
    await cloudSyncService.startSchedule();

    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps syncing to a LAN share while the internet link is metered', async () => {
    settingsState.cloudSync.provider = 'smb';
    cloudSyncService.setUplinkState('metered');
    await cloudSyncService.startSchedule();

    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('holds the post-backup sync while the link is metered and runs it once online', async () => {
    settingsState.cloudSync.syncMode = 'after_backup';
    cloudSyncService.setUplinkState('metered');

    await expect(cloudSyncService.onBackupComplete()).resolves.toEqual({
      result: 'skipped',
      target: 'gdrive',
    });
    expect(sync).not.toHaveBeenCalled();

    cloudSyncService.setUplinkState('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('retries a held post-backup sync that fails once the link is online', async () => {
    settingsState.cloudSync.syncMode = 'after_backup';
    cloudSyncService.setUplinkState('metered');
    await cloudSyncService.onBackupComplete();
    sync.mockRejectedValueOnce(new Error('rclone failed'));

    cloudSyncService.setUplinkState('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sync).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('retries a held post-backup sync while the provider is disconnected', async () => {
    settingsState.cloudSync.syncMode = 'after_backup';
    cloudSyncService.setUplinkState('metered');
    await cloudSyncService.onBackupComplete();
    vi.mocked(gdriveAuthService.getStatus).mockResolvedValueOnce({
      connected: false,
      configured: true,
    } as Awaited<ReturnType<typeof gdriveAuthService.getStatus>>);

    cloudSyncService.setUplinkState('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps a backup held during a running post-backup sync pending', async () => {
    settingsState.cloudSync.syncMode = 'after_backup';
    let finish: () => void = () => undefined;
    sync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const running = cloudSyncService.onBackupComplete();
    await vi.advanceTimersByTimeAsync(0);

    cloudSyncService.setUplinkState('metered');
    await expect(cloudSyncService.onBackupComplete()).resolves.toEqual({
      result: 'skipped',
      target: 'gdrive',
    });
    expect(sync).toHaveBeenCalledTimes(1);
    finish();
    await running;

    cloudSyncService.setUplinkState('online');
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('reports the link state in the status', async () => {
    cloudSyncService.setUplinkState('offline');

    await expect(cloudSyncService.getStatus()).resolves.toMatchObject({ uplinkState: 'offline' });
  });
});
