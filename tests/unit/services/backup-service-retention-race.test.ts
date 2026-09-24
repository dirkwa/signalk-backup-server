import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ ids: new Set<string>() }));

vi.mock('../../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/services/settings-service.js', () => ({
  settingsService: {
    get: vi.fn(async () => ({ retention: { hourly: 1, daily: 7, weekly: 4, startup: 3 } })),
  },
}));

vi.mock('../../../src/services/kopia-client.js', () => ({
  kopiaClient: {
    listSnapshots: vi.fn(async (options: { tags?: Record<string, string> }) =>
      options.tags?.['type'] === 'hourly'
        ? [...store.ids].map((id, i) => ({
            id,
            startTime: new Date(Date.UTC(2026, 8, 24, i)).toISOString(),
            tags: { 'tag:type': 'hourly' },
          }))
        : []
    ),
    deleteSnapshot: vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!store.ids.delete(id)) throw new Error(`no snapshots matched ${id}`);
    }),
    maintenanceRun: vi.fn(),
  },
}));

import { backupService } from '../../../src/services/backup-service.js';
import { logger } from '../../../src/services/logger.js';

// The hourly and daily schedules both fire at midnight, so two retention passes start together.
describe('enforceRetention concurrency', () => {
  beforeEach(() => {
    store.ids = new Set(['a', 'b', 'c']);
    vi.mocked(logger.warn).mockClear();
    vi.spyOn(backupService, 'initialize').mockResolvedValue();
  });

  it('never deletes the same expired snapshot twice', async () => {
    const [first, second] = await Promise.all([
      backupService.enforceRetention(),
      backupService.enforceRetention(),
    ]);

    expect(first.deletedCount + second.deletedCount).toBe(2);
    expect(store.ids).toEqual(new Set(['c']));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps running later passes after one fails', async () => {
    vi.mocked(backupService.initialize).mockRejectedValueOnce(new Error('boom'));

    await expect(backupService.enforceRetention()).rejects.toThrow('boom');
    await expect(backupService.enforceRetention()).resolves.toMatchObject({ deletedCount: 2 });
  });
});
