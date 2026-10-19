import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {
    get: vi.fn(async () => ({ backupExclusions: ['logs/'] })),
    getSetting: vi.fn(async () => false),
  },
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: { getCurrentVersion: vi.fn(async () => null) },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({
  kopiaClient: {
    createSnapshot: vi.fn(async () => {
      throw new Error('snapshot not needed');
    }),
  },
}));

import { writeFile } from 'fs/promises';
import { backupService } from '../../../src/services/backup-service.js';
import { settingsService } from '../../../src/services/settings-service.js';

describe('createBackup .kopiaignore', () => {
  beforeEach(() => {
    vi.mocked(writeFile).mockClear();
    vi.spyOn(backupService, 'initialize').mockResolvedValue();
  });

  it('excludes plugin cache and temp directories alongside the user exclusions', async () => {
    await backupService.createBackup();

    expect(writeFile).toHaveBeenCalledWith('/signalk-data/.kopiaignore', expect.any(String));
    const lines = String(vi.mocked(writeFile).mock.calls[0][1]).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'plugin-config-data/*/cache/',
        'plugin-config-data/*/.cache/',
        'plugin-config-data/*/*-cache/',
        'plugin-config-data/*/tmp/',
        'plugin-config-data/*/.tmp/',
        'plugin-config-data/*/temp/',
        'plugin-config-data/*/vfs/cache/',
        'plugin-config-data/*/vfs/.cache/',
        'plugin-config-data/*/vfs/*-cache/',
        'plugin-config-data/*/vfs/tmp/',
        'plugin-config-data/*/vfs/.tmp/',
        'plugin-config-data/*/vfs/temp/',
        'logs/',
      ])
    );
    expect(lines).not.toContain('plugin-config-data/signalk-charts-provider-simple/');
  });

  it('writes user lines after the cache defaults, so a ! line can re-include a cache', async () => {
    vi.mocked(settingsService.get).mockResolvedValueOnce({
      backupExclusions: ['!plugin-config-data/tides/harmonics-cache/'],
    } as Awaited<ReturnType<typeof settingsService.get>>);
    await backupService.createBackup();

    const lines = String(vi.mocked(writeFile).mock.calls[0][1]).split('\n');
    expect(lines.indexOf('!plugin-config-data/tides/harmonics-cache/')).toBeGreaterThan(
      lines.indexOf('plugin-config-data/*/*-cache/')
    );
  });
});
