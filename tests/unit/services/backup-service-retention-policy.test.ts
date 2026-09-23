import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/kopia-client.js', () => ({
  kopiaClient: { setPolicy: vi.fn() },
}));

import { backupService } from '../../../src/services/backup-service.js';
import { kopiaClient } from '../../../src/services/kopia-client.js';

// kopia prunes by count and cannot read the type tags, so any ceiling it enforces deletes the manual backups the app promises never to auto-delete.
describe('applyKopiaRetentionPolicy', () => {
  beforeEach(() => {
    vi.mocked(kopiaClient.setPolicy).mockClear();
  });

  it('leaves every deletion to enforceRetention', async () => {
    await backupService.applyKopiaRetentionPolicy();

    const [, retention] = vi.mocked(kopiaClient.setPolicy).mock.calls[0]!;

    expect(retention).toEqual({
      keepLatest: 0,
      keepHourly: 0,
      keepDaily: 0,
      keepWeekly: 0,
      keepMonthly: 0,
      keepAnnual: 0,
    });
  });

  it('sets no count that a large retention configuration could exceed', async () => {
    await backupService.applyKopiaRetentionPolicy();

    const [, retention] = vi.mocked(kopiaClient.setPolicy).mock.calls[0]!;

    for (const value of Object.values(retention)) {
      expect(value).toBe(0);
    }
  });
});
