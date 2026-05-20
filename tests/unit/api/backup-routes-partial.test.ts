// Tests for the partial-restore route layer added in signalk-backup#30.
// The route handler logic is intentionally thin — most work lives in
// restore-partial-service, which has its own integration tests. What we
// verify here is the surface: error-code → HTTP status mapping, and the
// SSE/JSON envelope shape via the lightweight helper.

import { describe, it, expect, vi } from 'vitest';

// Heavy modules pulled in by backup-routes.ts must be stubbed before
// import; the route file initialises a multer instance and pulls
// config.dataDir at module load.
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
    dataDir: '/tmp/sk-route-test-data',
    signalkDataPath: '/tmp/sk-route-test-signalk',
    maxUploadSize: 1024,
    kopiaBinaryPath: '/usr/local/bin/kopia',
    kopiaRepoPath: '/tmp/sk-route-test-repo',
    kopiaConfigPath: '/tmp/sk-route-test-kopia.config',
  },
}));

// Service modules — we don't need them to do anything real for the
// status-mapping test.
vi.mock('../../../src/services/backup-service.js', () => ({
  backupService: { getBackup: vi.fn() },
}));
vi.mock('../../../src/services/backup-scheduler.js', () => ({
  backupScheduler: {},
}));
vi.mock('../../../src/services/cloud-sync-service.js', () => ({
  cloudSyncService: {},
}));
vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {},
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

const { partialErrorStatus, backupRouter } = await import(
  '../../../src/api/backup-routes.js'
);
import type { PartialRestoreError } from '../../../src/services/restore-partial-service.js';
const { generateOpenApiDocument, setRoutePrefixByTag } = await import(
  '../../../src/api/openapi-registry.js'
);

describe('partialErrorStatus', () => {
  it.each<[PartialRestoreError['code'], number]>([
    ['INVALID_SOURCE', 400],
    ['INVALID_TARGET', 400],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['BUSY', 409],
    ['RESTORE_NEEDS_FULL', 409],
    ['INTERNAL', 500],
  ])('maps %s → %i', (code, status) => {
    expect(partialErrorStatus(code)).toBe(status);
  });
});

describe('partial-restore route registration', () => {
  // Sanity-check that the new routes registered with the OpenAPI registry.
  // If a route handler is wired without going through createApiRouter the
  // OpenAPI doc would drift — this guards against that for the new routes.

  it('registers the four new partial-restore routes in OpenAPI', () => {
    // backupRouter is imported above just to side-effect-register routes
    // with the OpenAPI registry; reference it so the import isn't dropped.
    expect(backupRouter).toBeDefined();
    setRoutePrefixByTag('Backups', '/api/backups');

    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { summary?: string }>>;
    };

    expect(doc.paths['/api/backups/{id}/tree']?.get?.summary).toBeDefined();
    expect(doc.paths['/api/backups/{id}/download-subtree']?.get?.summary).toBeDefined();
    expect(doc.paths['/api/backups/{id}/restore-partial']?.post?.summary).toBeDefined();
    expect(doc.paths['/api/backups/restore-partial/status']?.get?.summary).toBeDefined();
    expect(doc.paths['/api/backups/restore-partial/stream']?.get?.summary).toBeDefined();
    expect(doc.paths['/api/backups/restore-partial/reset']?.post?.summary).toBeDefined();
  });
});
