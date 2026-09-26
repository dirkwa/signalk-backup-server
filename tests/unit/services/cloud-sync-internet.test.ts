import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProbeOutcome = 'success' | 'error';

const settingsState = vi.hoisted(() => ({
  cloudSync: {
    provider: 'gdrive' as 'gdrive' | 'local' | 'smb',
    syncMode: 'manual' as const,
    syncFrequency: 'daily' as const,
    lastSync: null,
    lastSyncError: null,
    containerPath: '/host-media/usb',
    hostPath: '/media/usb',
    host: 'nas.local',
    share: 'backups',
    user: 'signalk',
  },
}));

const probes = vi.hoisted(() => ({
  outcomes: [] as ProbeOutcome[],
  calls: 0,
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
    getKopiaPassword: vi.fn(async () => 'test-password'),
  },
}));

vi.mock('../../../src/services/gdrive-auth-service.js', () => ({
  RCLONE_GDRIVE_REMOTE_NAME: 'gdrive',
  gdriveAuthService: {
    getStatus: vi.fn(async () => ({ connected: true, configured: true, email: 'boat@example.com' })),
  },
}));

vi.mock('../../../src/services/local-fs-service.js', () => ({
  localFsService: {
    getStatus: vi.fn(async () => ({ connected: true, configured: true })),
  },
}));

vi.mock('../../../src/services/smb-auth-service.js', () => ({
  RCLONE_SMB_REMOTE_NAME: 'smb',
  smbAuthService: {
    getStatus: vi.fn(async () => ({ connected: true, configured: true })),
  },
}));

vi.mock('net', () => ({
  connect: (
    _options: { host: string; port: number; timeout: number },
    onConnect?: () => void
  ) => {
    const socket = new EventEmitter();
    probes.calls += 1;
    const outcome = probes.outcomes.shift() ?? 'error';
    const finish = () => {
      if (outcome === 'success') {
        onConnect?.();
        return;
      }
      socket.emit('error', new Error('offline'));
    };
    queueMicrotask(finish);
    return Object.assign(socket, { destroy: vi.fn() });
  },
}));

interface InternetInternals {
  internetAvailable: boolean | null;
  internetCheckedAt: number | null;
  internetCheckInFlight: Promise<boolean> | null;
  refreshInternetAvailability(): Promise<boolean>;
}

interface CloudSyncModule {
  cloudSyncService: InternetInternals & {
    syncing: boolean;
    getStatus(): Promise<{ internetAvailable: boolean | null }>;
    syncToCloud(): Promise<void>;
    prepareCloudRestore(folder: string, password?: string): Promise<unknown>;
  };
}

const TTL_MS = 60_000;
const FIRST_RETRY_DELAY_MS = 2_000;
const SECOND_RETRY_DELAY_MS = 4_000;

async function loadService(): Promise<CloudSyncModule['cloudSyncService']> {
  const loaded = (await import('../../../src/services/cloud-sync-service.js')) as CloudSyncModule;
  return loaded.cloudSyncService;
}

describe('cloud sync internet check', () => {
  let service: CloudSyncModule['cloudSyncService'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    vi.resetModules();
    probes.outcomes = [];
    probes.calls = 0;
    settingsState.cloudSync.provider = 'gdrive';
    service = await loadService();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // The socket stub settles on the microtask queue and the service chains
  // `.then`/`.finally` on top of it, so a single tick is not enough to know a
  // background refresh ran. Drain twice without moving the clock so a pending
  // retry timer still cannot fire.
  async function settleProbe(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  }

  // Attaches the rejection handler synchronously and resolves to the error
  // instead of the value, so a failing call can never surface as an unhandled
  // rejection while the fake timers are still running.
  function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => 'resolved',
      (error: unknown) => error
    );
  }

  it('succeeds on the first attempt without waiting', async () => {
    probes.outcomes = ['success'];

    const pending = service.refreshInternetAvailability();
    await settleProbe();

    await expect(pending).resolves.toBe(true);
    expect(probes.calls).toBe(1);
    expect(service.internetAvailable).toBe(true);
    expect(service.internetCheckedAt).toBe(Date.now());
  });

  it('retries once after 2s when the first attempt fails', async () => {
    probes.outcomes = ['error', 'success'];

    const pending = service.refreshInternetAvailability();
    await settleProbe();
    expect(probes.calls).toBe(1);
    expect(service.internetCheckedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS - 1);
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settleProbe();

    await expect(pending).resolves.toBe(true);
    expect(probes.calls).toBe(2);
    expect(service.internetAvailable).toBe(true);
  });

  it('returns false after three attempts and delays of 2s then 4s', async () => {
    probes.outcomes = ['error', 'error', 'error'];
    const startedAt = Date.now();

    const pending = service.refreshInternetAvailability();
    await settleProbe();
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);
    await settleProbe();
    expect(probes.calls).toBe(2);
    expect(service.internetCheckedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(SECOND_RETRY_DELAY_MS - 1);
    expect(probes.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    await settleProbe();

    await expect(pending).resolves.toBe(false);
    expect(probes.calls).toBe(3);
    expect(service.internetAvailable).toBe(false);
    expect(service.internetCheckedAt).toBe(startedAt + FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS);
  });

  it('reuses a true result until the 60s TTL expires', async () => {
    probes.outcomes = ['success', 'success'];
    await service.refreshInternetAvailability();
    await settleProbe();
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(TTL_MS - 1);
    const cached = await service.getStatus();
    expect(cached.internetAvailable).toBe(true);
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const refreshing = service.getStatus();
    await expect(refreshing).resolves.toMatchObject({ internetAvailable: true });
    await settleProbe();
    expect(probes.calls).toBe(2);
    expect(service.internetAvailable).toBe(true);
  });

  it('returns the known value immediately while a refresh is still retrying', async () => {
    probes.outcomes = ['success'];
    await service.refreshInternetAvailability();
    await settleProbe();

    await vi.advanceTimersByTimeAsync(TTL_MS);
    probes.outcomes = ['error', 'error', 'error'];

    const started = Date.now();
    const status = await service.getStatus();
    await settleProbe();
    expect(status.internetAvailable).toBe(true);
    expect(Date.now()).toBe(started);
    expect(probes.calls).toBe(2);
    expect(service.internetCheckInFlight).not.toBeNull();

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS);
    await settleProbe();
    expect(service.internetAvailable).toBe(false);
    expect(service.internetCheckInFlight).toBeNull();
  });

  it('shares one in-flight check across concurrent refreshes', async () => {
    probes.outcomes = ['error', 'success'];

    const first = service.refreshInternetAvailability();
    const second = service.refreshInternetAvailability();
    const third = service.getStatus();

    expect(second).toBe(first);
    await expect(third).resolves.toMatchObject({ internetAvailable: null });
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);
    await settleProbe();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(probes.calls).toBe(2);
    expect(service.internetAvailable).toBe(true);
  });

  it('serves every concurrent caller from one in-flight check and writes the result once', async () => {
    probes.outcomes = ['error', 'error', 'success'];

    const first = service.refreshInternetAvailability();
    await settleProbe();
    expect(probes.calls).toBe(1);

    const second = service.refreshInternetAvailability();
    const status = service.getStatus();

    expect(second).toBe(first);
    expect(service.internetCheckInFlight).toBe(first);
    await expect(status).resolves.toMatchObject({ internetAvailable: null });

    const finishedAt = Date.now() + FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS;
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);
    await settleProbe();
    expect(probes.calls).toBe(2);

    // A status poll while the shared check is still retrying joins it instead
    // of opening a competing probe.
    await expect(service.getStatus()).resolves.toMatchObject({ internetAvailable: null });
    expect(probes.calls).toBe(2);

    await vi.advanceTimersByTimeAsync(SECOND_RETRY_DELAY_MS);
    await settleProbe();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(probes.calls).toBe(3);
    expect(service.internetAvailable).toBe(true);
    expect(service.internetCheckedAt).toBe(finishedAt);
    expect(service.internetCheckInFlight).toBeNull();
  });

  it('writes internetCheckedAt only when the check finishes', async () => {
    probes.outcomes = ['error', 'success'];
    const pending = service.refreshInternetAvailability();
    await settleProbe();

    expect(service.internetCheckedAt).toBeNull();
    expect(service.internetAvailable).toBeNull();

    const finishedAt = Date.now() + FIRST_RETRY_DELAY_MS;
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);
    await settleProbe();
    await pending;

    expect(service.internetCheckedAt).toBe(finishedAt);
    expect(service.internetAvailable).toBe(true);
  });

  it.each(['local', 'smb'] as const)(
    'does not probe Google from getStatus() for %s',
    async (provider) => {
      settingsState.cloudSync.provider = provider;

      const status = await service.getStatus();

      expect(status.internetAvailable).toBeNull();
      expect(probes.calls).toBe(0);
      expect(service.internetCheckInFlight).toBeNull();
    }
  );

  it('lets sync share an in-flight status refresh', async () => {
    probes.outcomes = ['error', 'error', 'error'];
    const status = service.getStatus();
    await expect(status).resolves.toMatchObject({ internetAvailable: null });
    expect(probes.calls).toBe(1);

    const syncOutcome = captureRejection(service.syncToCloud());
    await settleProbe();
    expect(probes.calls).toBe(1);
    expect(service.syncing).toBe(true);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS);
    await settleProbe();

    const reason = await syncOutcome;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('No internet connection available');
    expect(probes.calls).toBe(3);
    expect(service.internetAvailable).toBe(false);
    expect(service.syncing).toBe(false);
  });

  it('lets restore share an in-flight status refresh', async () => {
    probes.outcomes = ['error', 'error', 'error'];
    const status = service.getStatus();
    await expect(status).resolves.toMatchObject({ internetAvailable: null });
    expect(probes.calls).toBe(1);

    const restoreOutcome = captureRejection(service.prepareCloudRestore('folder-1'));
    await settleProbe();
    expect(probes.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS);
    await settleProbe();

    const reason = await restoreOutcome;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('No internet connection available');
    expect(probes.calls).toBe(3);
    expect(service.internetAvailable).toBe(false);
  });
});