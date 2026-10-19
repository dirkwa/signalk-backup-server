import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

const root = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return mkdtempSync(join(tmpdir(), 'sbs-cache-candidates-'));
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
      backupExclusions: ['plugin-config-data/excluded/', 'plugin-config-data/router/skipped/'],
    })),
    getSetting: vi.fn(async () => false),
  },
}));

vi.mock('../../../src/services/version-service.js', () => ({
  versionService: { getCurrentVersion: vi.fn(async () => null) },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({ kopiaClient: {} }));

import { backupService } from '../../../src/services/backup-service.js';

const MB = 1024 * 1024;
const DAY_S = 24 * 60 * 60;

// Sparse, so a 150 MB fixture takes no disk.
function file(rel: string, bytes: number, ageS = 0): void {
  const path = join(root, 'plugin-config-data', rel);
  mkdirSync(join(path, '..'), { recursive: true });
  const fd = openSync(path, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
  const t = Date.now() / 1000 - ageS;
  utimesSync(path, t, t);
}

describe('getCacheCandidates', () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('suggests big subdirectories mostly written in the last day, and nothing kopia already skips', async () => {
    file('router/forecast/2026101900/wind.bin', 150 * MB);
    file('router/forecast/2026101900/index.json', 1);
    file('router/ecmwf/run.grib2', 120 * MB);
    file('router/ecmwf/old.grib2', 100 * MB, 2 * DAY_S);
    file('router/coastline/gshhs.shp', 150 * MB, 30 * DAY_S);
    file('router/mixed/new.bin', 60 * MB);
    file('router/mixed/old.bin', 90 * MB, 3 * DAY_S);
    file('router/small/new.bin', 10 * MB);
    file('router/skipped/new.bin', 150 * MB);
    file('router/tagged/new.bin', 150 * MB);
    writeFileSync(
      join(root, 'plugin-config-data/router/tagged/CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55\n'
    );
    file('router/nested/own.bin', 20 * MB);
    file('router/nested/tiles/new.bin', 150 * MB);
    writeFileSync(
      join(root, 'plugin-config-data/router/nested/tiles/CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55'
    );
    file('router/badtag/new.bin', 150 * MB);
    writeFileSync(join(root, 'plugin-config-data/router/badtag/CACHEDIR.TAG'), 'not a tag');
    file('router/settings.json', 150 * MB);
    file('wasm/vfs/data/forecast/new.bin', 130 * MB);
    file('wasm/vfs/config/own.json', 1);
    file('taggedwasm/vfs/data/new.bin', 150 * MB);
    writeFileSync(
      join(root, 'plugin-config-data/taggedwasm/vfs/CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55'
    );
    file('excluded/cache-like/new.bin', 150 * MB);
    file('signalk-questdb/db/new.bin', 150 * MB);

    const candidates = await backupService.getCacheCandidates();

    expect(candidates.map((c) => c.path)).toEqual([
      'plugin-config-data/router/badtag/',
      'plugin-config-data/router/forecast/',
      'plugin-config-data/wasm/vfs/data/',
      'plugin-config-data/router/ecmwf/',
    ]);
    expect(candidates[1]).toEqual({
      path: 'plugin-config-data/router/forecast/',
      size: 150 * MB + 1,
      recentBytes: 150 * MB + 1,
    });
    expect(candidates[3]).toMatchObject({ size: 220 * MB, recentBytes: 120 * MB });
  });
});
