import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    kopiaRepoPath: '/data/kopia-repo',
    kopiaConfigPath: '/data/kopia-config',
    signalkDataPath: '/signalk-data',
  },
}));

vi.mock('../../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({
  kopiaClient: {
    disconnectRepository: vi.fn(),
  },
}));

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {},
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: {},
}));

import { existsSync, readdirSync } from 'fs';
import {
  hasRepositoryData,
  classifyConnectFailure,
  backupService,
} from '../../../src/services/backup-service.js';
import { kopiaClient } from '../../../src/services/kopia-client.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedDisconnect = vi.mocked(kopiaClient.disconnectRepository);

describe('hasRepositoryData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is false when the storage directory does not exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(hasRepositoryData('/data/kopia-repo')).toBe(false);
    expect(mockedReaddirSync).not.toHaveBeenCalled();
  });

  it('is false when the storage directory exists but is empty', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);
    expect(hasRepositoryData('/data/kopia-repo')).toBe(false);
  });

  it('is true when the storage directory holds entries', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['kopia.repository.f'] as unknown as ReturnType<
      typeof readdirSync
    >);
    expect(hasRepositoryData('/data/kopia-repo')).toBe(true);
  });

  it('assumes data present (never create-over) when the directory is unreadable', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(hasRepositoryData('/data/kopia-repo')).toBe(true);
  });
});

describe('classifyConnectFailure', () => {
  it('maps a password failure to a data-is-safe password message', () => {
    const err = classifyConnectFailure(
      'error connecting to repository: repository password is invalid',
      '/data/kopia-repo'
    );
    expect(err.message).toMatch(/backups are SAFE/i);
    expect(err.message).toMatch(/password/i);
    expect(err.message).toMatch(/NOT be modified/i);
  });

  it('maps "found existing data" to a reconnect-with-config-lost message', () => {
    const err = classifyConnectFailure(
      'unable to get repository storage: found existing data in storage location',
      '/data/kopia-repo'
    );
    expect(err.message).toMatch(/backups are SAFE/i);
    expect(err.message).toMatch(/kopia repository connect filesystem --path \/data\/kopia-repo/);
    expect(err.message).toMatch(/NOT be re-created/i);
  });

  it('falls back to a generic safe message for unrecognised stderr', () => {
    const err = classifyConnectFailure('some unexpected kopia error', '/data/kopia-repo');
    expect(err.message).toMatch(/backups are safe/i);
    expect(err.message).toContain('some unexpected kopia error');
  });
});

describe('resetInitialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disconnects the repository so the next init reconnects with the new password', async () => {
    mockedDisconnect.mockResolvedValue(undefined);
    await backupService.resetInitialization();
    expect(mockedDisconnect).toHaveBeenCalledTimes(1);
    expect(backupService.isInitialized()).toBe(false);
  });

  it('still clears the cache when disconnect fails (repo not connected yet)', async () => {
    mockedDisconnect.mockRejectedValue(new Error('not connected'));
    await expect(backupService.resetInitialization()).resolves.toBeUndefined();
    expect(backupService.isInitialized()).toBe(false);
  });
});
