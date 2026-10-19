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
    get: vi.fn(async () => ({
      backupExclusions: ['logs/', 'plugin-config-data/a[b/', 'plugin-config-data/[z-a]/'],
    })),
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
import { logger } from '../../../src/services/logger.js';
import { backupService } from '../../../src/services/backup-service.js';

describe('createBackup with a stored pattern kopia cannot read', () => {
  beforeEach(() => {
    vi.spyOn(backupService, 'initialize').mockResolvedValue();
  });

  it('leaves that line out of .kopiaignore with a warning, and keeps the rest', async () => {
    await backupService.createBackup();

    const lines = String(vi.mocked(writeFile).mock.calls[0]?.[1]).split('\n');
    expect(lines).toContain('logs/');
    expect(lines).toContain('plugin-config-data/[z-a]/');
    expect(lines).not.toContain('plugin-config-data/a[b/');
    expect(logger.warn).toHaveBeenCalledWith(
      { unreadable: ['plugin-config-data/a[b/'] },
      'Skipping exclusion patterns kopia cannot read'
    );
  });
});
