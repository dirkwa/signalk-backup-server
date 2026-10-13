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

describe('createBackup .kopiaignore', () => {
  beforeEach(() => {
    vi.mocked(writeFile).mockClear();
    vi.spyOn(backupService, 'initialize').mockResolvedValue();
  });

  it('excludes chart provider caches alongside the user exclusions', async () => {
    await backupService.createBackup();

    expect(writeFile).toHaveBeenCalledWith('/signalk-data/.kopiaignore', expect.any(String));
    const lines = String(vi.mocked(writeFile).mock.calls[0][1]).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'plugin-config-data/signalk-charts-provider-simple/raster-tile-cache/',
        'plugin-config-data/signalk-charts-provider-simple/catalog-cache/',
        'plugin-config-data/signalk-charts-provider-simple/noaa-enc-cache/',
        'logs/',
      ])
    );
    expect(lines).not.toContain('plugin-config-data/signalk-charts-provider-simple/');
  });
});
