import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return mkdtempSync(join(tmpdir(), 'sbs-plugin-dirs-'));
});

vi.mock('../../../src/config/index.js', () => ({
  config: {
    kopiaRepoPath: '/data/kopia-repo',
    kopiaConfigPath: '/data/kopia-config',
    signalkDataPath: root,
  },
}));

vi.mock('../../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {
    get: vi.fn(async () => ({
      backupExclusions: ['plugin-config-data/tracks/', 'plugin-config-data/kip*/'],
    })),
    getSetting: vi.fn(async () => false),
  },
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: { getCurrentVersion: vi.fn(async () => null) },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({ kopiaClient: {} }));

import { backupService } from '../../../src/services/backup-service.js';

describe('getPluginDataDirectories', () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('marks the plugin directories the user excluded, and the locked ones', async () => {
    for (const name of ['tracks', 'kip', 'tides', 'signalk-questdb']) {
      mkdirSync(join(root, 'plugin-config-data', name), { recursive: true });
      writeFileSync(join(root, 'plugin-config-data', name, 'f'), 'x');
    }

    const dirs = await backupService.getPluginDataDirectories();
    const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));

    expect(byName.tracks).toMatchObject({ excluded: true, lockedExcluded: false });
    expect(byName.kip).toMatchObject({ excluded: true, lockedExcluded: false });
    expect(byName.tides).toMatchObject({ excluded: false, lockedExcluded: false });
    expect(byName['signalk-questdb']).toMatchObject({ excluded: true, lockedExcluded: true });
  });
});
