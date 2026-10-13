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
      backupExclusions: [
        '!plugin-config-data/signalk-backup/kopia-repo/',
        '!plugin-config-data/signalk-questdb/',
      ],
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
import { backupService } from '../../../src/services/backup-service.js';

// In .kopiaignore a later line overrides an earlier `!pattern`.
describe('createBackup .kopiaignore order', () => {
  let lines: string[];

  beforeEach(async () => {
    vi.mocked(writeFile).mockClear();
    vi.spyOn(backupService, 'initialize').mockResolvedValue();
    await backupService.createBackup();
    expect(writeFile).toHaveBeenCalledWith('/signalk-data/.kopiaignore', expect.any(String));
    lines = String(vi.mocked(writeFile).mock.calls[0][1]).split('\n');
  });

  it('keeps our own repository out even when a user rule re-includes it', () => {
    expect(lines.lastIndexOf('plugin-config-data/signalk-backup/kopia-repo/')).toBeGreaterThan(
      lines.indexOf('!plugin-config-data/signalk-backup/kopia-repo/')
    );
  });

  it('lets a user rule re-include a database directory', () => {
    expect(lines.indexOf('!plugin-config-data/signalk-questdb/')).toBeGreaterThan(
      lines.indexOf('plugin-config-data/signalk-questdb/')
    );
  });
});
