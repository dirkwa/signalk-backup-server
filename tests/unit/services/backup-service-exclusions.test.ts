import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    get: vi.fn(async () => ({ backupExclusions: [] })),
    getSetting: vi.fn(async () => false),
    update: vi.fn(async () => ({})),
  },
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: { getCurrentVersion: vi.fn(async () => null) },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({
  kopiaClient: {
    listSnapshots: vi.fn(async () => [{ id: 'k1' }, { id: 'k2' }]),
    deleteSnapshot: vi.fn(async () => undefined),
    maintenanceRun: vi.fn(async () => undefined),
    createSnapshot: vi.fn(async () => {
      throw new Error('snapshot not expected');
    }),
  },
}));

import { kopiaClient } from '../../../src/services/kopia-client.js';
import { settingsService } from '../../../src/services/settings-service.js';
import { backupService } from '../../../src/services/backup-service.js';

describe('setExclusions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the patterns and keeps the existing snapshots', async () => {
    await backupService.setExclusions(['logs', 'plugin-config-data/foo/cache/']);

    expect(settingsService.update).toHaveBeenCalledWith({
      backupExclusions: ['logs/', 'plugin-config-data/foo/cache/'],
      includeHistoryInBackups: true,
    });
    expect(kopiaClient.deleteSnapshot).not.toHaveBeenCalled();
    expect(kopiaClient.maintenanceRun).not.toHaveBeenCalled();
    expect(kopiaClient.createSnapshot).not.toHaveBeenCalled();
  });
});
