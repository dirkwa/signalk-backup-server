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
  copyFile: vi.fn(),
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
    setPassword: vi.fn(),
    isRepositoryConnected: vi.fn(),
    connectRepository: vi.fn(),
    disconnectRepository: vi.fn(),
    changePassword: vi.fn(),
  },
}));

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {},
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: {},
}));

import { existsSync, readdirSync } from 'fs';
import { readdir, copyFile, rm } from 'fs/promises';
import {
  hasRepositoryData,
  classifyConnectFailure,
  backupService,
} from '../../../src/services/backup-service.js';
import { kopiaClient } from '../../../src/services/kopia-client.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedDisconnect = vi.mocked(kopiaClient.disconnectRepository);
const mockedSetPassword = vi.mocked(kopiaClient.setPassword);
const mockedIsConnected = vi.mocked(kopiaClient.isRepositoryConnected);
const mockedConnect = vi.mocked(kopiaClient.connectRepository);
const mockedChangePassword = vi.mocked(kopiaClient.changePassword);
const mockedReaddir = vi.mocked(readdir);
const mockedCopyFile = vi.mocked(copyFile);
const mockedRm = vi.mocked(rm);

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

describe('rekeyRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Existing repo with data + a single kopia-config to stash.
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['kopia.repository.f'] as unknown as ReturnType<
      typeof readdirSync
    >);
    mockedReaddir.mockResolvedValue(['kopia-config'] as unknown as Awaited<
      ReturnType<typeof readdir>
    >);
    mockedCopyFile.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedDisconnect.mockResolvedValue(undefined);
    mockedConnect.mockResolvedValue(undefined);
    mockedChangePassword.mockResolvedValue(undefined);
    mockedIsConnected.mockResolvedValue(true);
  });

  it('re-keys, verifies with the new password, and discards the stash', async () => {
    await backupService.rekeyRepository('oldpw', 'newpw');

    expect(mockedChangePassword).toHaveBeenCalledWith('newpw');
    // Verify-reconnect ran with the new password set.
    expect(mockedSetPassword).toHaveBeenCalledWith('newpw');
    // Stash copied aside then removed on success.
    expect(mockedCopyFile).toHaveBeenCalledWith('/data/kopia-config', '/data/kopia-config.rekey-bak');
    expect(mockedRm).toHaveBeenCalledWith('/data/kopia-config.rekey-bak', { force: true });
    expect(backupService.isInitialized()).toBe(true);
  });

  it('aborts without changing anything when the current password cannot open the repo', async () => {
    mockedIsConnected.mockResolvedValue(false);
    mockedConnect.mockRejectedValue(new Error('repository password is invalid'));

    await expect(backupService.rekeyRepository('wrongpw', 'newpw')).rejects.toThrow(/SAFE/i);
    expect(mockedChangePassword).not.toHaveBeenCalled();
    expect(mockedCopyFile).not.toHaveBeenCalled();
  });

  it('restores the stashed config and keeps the old password when change-password fails', async () => {
    mockedChangePassword.mockRejectedValue(new Error('change-password failed'));

    await expect(backupService.rekeyRepository('oldpw', 'newpw')).rejects.toThrow(
      /previous password still works/i
    );
    // Stash restored from backup.
    expect(mockedCopyFile).toHaveBeenCalledWith('/data/kopia-config.rekey-bak', '/data/kopia-config');
    // Reverted to old password.
    expect(mockedSetPassword).toHaveBeenLastCalledWith('oldpw');
  });

  it('rolls back when the new password fails to reconnect (verify step)', async () => {
    // Already connected with old pw, so the only connectRepository() call is the
    // verify-reconnect with the new password — make that fail, then the old-pw
    // reconnect during rollback succeeds.
    mockedChangePassword.mockResolvedValue(undefined);
    mockedConnect
      .mockRejectedValueOnce(new Error('cannot open with new password'))
      .mockResolvedValueOnce(undefined);

    await expect(backupService.rekeyRepository('oldpw', 'newpw')).rejects.toThrow(/rolled back/i);
    expect(mockedCopyFile).toHaveBeenCalledWith('/data/kopia-config.rekey-bak', '/data/kopia-config');
    expect(mockedSetPassword).toHaveBeenLastCalledWith('oldpw');
  });

  it('short-circuits when there is no repository yet', async () => {
    mockedReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    await backupService.rekeyRepository('oldpw', 'newpw');
    expect(mockedChangePassword).not.toHaveBeenCalled();
    expect(mockedSetPassword).toHaveBeenCalledWith('newpw');
  });
});
