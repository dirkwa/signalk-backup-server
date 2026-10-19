import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';

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
    dataDir: '/tmp/sk-exclusions-test-data',
    signalkDataPath: '/tmp/sk-exclusions-test-signalk',
    maxUploadSize: 1024,
    kopiaBinaryPath: '/usr/local/bin/kopia',
    kopiaRepoPath: '/tmp/sk-exclusions-test-repo',
    kopiaConfigPath: '/tmp/sk-exclusions-test-kopia.config',
  },
}));

vi.mock('../../../src/services/backup-service.js', () => ({
  backupService: {
    setExclusions: vi.fn(async () => undefined),
    getExclusions: vi.fn(async () => []),
  },
}));
vi.mock('../../../src/services/backup-scheduler.js', () => ({ backupScheduler: {} }));
vi.mock('../../../src/services/cloud-sync-service.js', () => ({ cloudSyncService: {} }));
vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: { update: vi.fn(async () => ({})) },
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
    restorePartialService: {
      getProgress: () => null,
      reset: vi.fn(),
      describeExistingTarget: vi.fn(),
      restorePartial: vi.fn(),
      isRestoring: () => false,
    },
  };
});

const { backupRouter } = await import('../../../src/api/backup-routes.js');
const { settingsRouter } = await import('../../../src/api/settings-routes.js');
const { backupService } = await import('../../../src/services/backup-service.js');
const { settingsService } = await import('../../../src/services/settings-service.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/backups', backupRouter);
  app.use('/api/settings', settingsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function put(path: string, body: unknown): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: json.error?.code };
}

describe('saving exclusions', () => {
  it('PUT /backups/exclusions rejects a pattern kopia cannot read and stores nothing', async () => {
    expect(
      await put('/backups/exclusions', { exclusions: ['logs/', 'plugin-config-data/a[b/'] })
    ).toEqual({
      status: 400,
      code: 'INVALID_EXCLUSIONS',
    });
    expect(backupService.setExclusions).not.toHaveBeenCalled();
  });

  it('PUT /backups/exclusions accepts a pattern kopia reads, even one that matches nothing', async () => {
    expect(
      (await put('/backups/exclusions', { exclusions: ['logs/', 'plugin-config-data/[z-a]/'] }))
        .status
    ).toBe(200);
    expect(backupService.setExclusions).toHaveBeenCalledWith([
      'logs/',
      'plugin-config-data/[z-a]/',
    ]);
  });

  it('PUT /settings rejects backupExclusions kopia cannot read and stores nothing', async () => {
    expect(await put('/settings', { backupExclusions: ['plugin-config-data/k*\\'] })).toEqual({
      status: 400,
      code: 'INVALID_EXCLUSIONS',
    });
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it('PUT /settings stores readable backupExclusions', async () => {
    expect((await put('/settings', { backupExclusions: ['logs/'] })).status).toBe(200);
    expect(settingsService.update).toHaveBeenCalledWith({ backupExclusions: ['logs/'] });
  });
});
