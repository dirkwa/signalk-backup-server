import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/logger.js', () => {
  const fakeLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fakeLogger,
  };
  return { logger: fakeLogger };
});

vi.mock('../../../src/config/index.js', () => ({
  config: {
    dataDir: '/tmp/sk-rekey-test',
    signalkDataPath: '/tmp/sk-rekey-test-signalk',
    maxUploadSize: 1024,
    kopiaBinaryPath: '/usr/local/bin/kopia',
    kopiaRepoPath: '/tmp/sk-rekey-test-repo',
    kopiaConfigPath: '/tmp/sk-rekey-test-kopia.config',
  },
}));

vi.mock('../../../src/services/backup-service.js', () => ({ backupService: {} }));
vi.mock('../../../src/services/backup-scheduler.js', () => ({ backupScheduler: {} }));
vi.mock('../../../src/services/cloud-sync-service.js', () => ({
  cloudSyncService: {
    getStatus: vi.fn(),
    syncToCloud: vi.fn(),
  },
}));
vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {},
  DEFAULT_KOPIA_PASSWORD: 'keeperbackup',
}));
vi.mock('../../../src/services/restore-service.js', () => ({
  restoreService: { isRestoring: () => false, getProgress: () => null, reset: vi.fn() },
}));
vi.mock('../../../src/services/restore-partial-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/services/restore-partial-service.js')
  >('../../../src/services/restore-partial-service.js');
  return {
    ...actual,
    restorePartialService: { getProgress: () => null, reset: vi.fn() },
  };
});

const { rekeyMessageAndCloudResync } = await import('../../../src/api/backup-routes.js');
const { cloudSyncService } = await import('../../../src/services/cloud-sync-service.js');
import type { CloudSyncStatus } from '../../../src/services/cloud-sync-service.js';

const mockedGetStatus = vi.mocked(cloudSyncService.getStatus);
const mockedSyncToCloud = vi.mocked(cloudSyncService.syncToCloud);

const BASE = 'Backup password changed.';

describe('rekeyMessageAndCloudResync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSyncToCloud.mockResolvedValue(undefined);
  });

  it('returns the bare message and triggers no sync when cloud is not connected', async () => {
    mockedGetStatus.mockResolvedValue({ connected: false } as Partial<CloudSyncStatus>);
    const msg = await rekeyMessageAndCloudResync(BASE);
    expect(msg).toBe(BASE);
    expect(mockedSyncToCloud).not.toHaveBeenCalled();
  });

  it('appends the stale-cloud warning and starts a sync when cloud is connected', async () => {
    mockedGetStatus.mockResolvedValue({ connected: true } as Partial<CloudSyncStatus>);
    const msg = await rekeyMessageAndCloudResync(BASE);
    expect(msg).toContain(BASE);
    expect(msg).toMatch(/previous password/i);
    expect(msg).toMatch(/do not delete your old cloud backups/i);
    expect(mockedSyncToCloud).toHaveBeenCalledTimes(1);
  });

  it('does not fail the password change if the background sync rejects', async () => {
    mockedGetStatus.mockResolvedValue({ connected: true } as Partial<CloudSyncStatus>);
    mockedSyncToCloud.mockRejectedValue(new Error('sync blew up'));
    await expect(rekeyMessageAndCloudResync(BASE)).resolves.toMatch(/previous password/i);
  });

  it('falls back to the bare message when cloud status cannot be determined', async () => {
    mockedGetStatus.mockRejectedValue(new Error('status unavailable'));
    const msg = await rekeyMessageAndCloudResync(BASE);
    expect(msg).toBe(BASE);
    expect(mockedSyncToCloud).not.toHaveBeenCalled();
  });
});
