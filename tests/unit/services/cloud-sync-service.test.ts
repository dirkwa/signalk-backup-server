import { describe, it, expect } from 'vitest';

import {
  buildFilesystemSyncArgs,
  buildRcloneSyncArgs,
  parseKopiaSyncProgress,
  type SyncProgress,
} from '../../../src/services/cloud-sync-service.js';

const newProgress = (): SyncProgress => ({ totalBytes: 1_000_000 });

describe('parseKopiaSyncProgress', () => {
  describe('destination-listing phase', () => {
    it('extracts processedBytes from "Found N BLOBs in the destination repository (X UNIT)"', () => {
      const p = newProgress();
      parseKopiaSyncProgress('\r  Found 9 BLOBs in the destination repository (10.9 KB)', p);
      expect(p.processedBytes).toBe(10_900);
      expect(p.processedBlobs).toBeUndefined();
      expect(p.totalBlobs).toBeUndefined();
    });

    it('handles bytes (no scale) — "30 B"', () => {
      const p = newProgress();
      parseKopiaSyncProgress('\r  Found 1 BLOBs in the destination repository (30 B)', p);
      expect(p.processedBytes).toBe(30);
    });

    it('handles GB scale', () => {
      const p = newProgress();
      parseKopiaSyncProgress('  Found 1000 BLOBs in the destination repository (1.2 GB)', p);
      expect(p.processedBytes).toBe(1_200_000_000);
    });

    it('handles base2 units (KOPIA_BYTES_STRING_BASE_2) — "1 MiB"', () => {
      const p = newProgress();
      parseKopiaSyncProgress('  Found 10 BLOBs in the destination repository (1 MiB)', p);
      expect(p.processedBytes).toBe(1_048_576);
    });
  });

  describe('source-listing phase', () => {
    it('sets totalBlobs from "blobs to copy" and resets processedBlobs to 0', () => {
      const p = newProgress();
      parseKopiaSyncProgress(
        '  Found 1234 BLOBs (5.6 GB) in the source repository, 200 (1.2 GB) to copy',
        p
      );
      expect(p.totalBlobs).toBe(200);
      expect(p.processedBlobs).toBe(0);
      expect(p.processedBytes).toBe(0);
    });
  });

  describe('upload phase', () => {
    it('updates processedBlobs and processedBytes from "Copied N blobs (X UNIT)"', () => {
      const p = newProgress();
      parseKopiaSyncProgress(
        '\r  Copied 17 blobs (456.7 MB), Speed: 12 MB/s, ETA: 1m30s (12:34)',
        p
      );
      expect(p.processedBlobs).toBe(17);
      expect(p.processedBytes).toBe(456_700_000);
    });

    it('updates processedBlobs without an existing totalBlobs', () => {
      const p = newProgress();
      parseKopiaSyncProgress('  Copied 5 blobs (12 KB), Speed: -, ETA: unknown', p);
      expect(p.processedBlobs).toBe(5);
      expect(p.processedBytes).toBe(12_000);
    });

    it('parses base2 byte units in the copy phase — "(2 MiB)"', () => {
      const p = newProgress();
      parseKopiaSyncProgress('  Copied 7 blobs (2 MiB), Speed: -, ETA: unknown', p);
      expect(p.processedBlobs).toBe(7);
      expect(p.processedBytes).toBe(2_097_152);
    });
  });

  describe('full sequence', () => {
    it('walks the destination-list → source-list → copy phases coherently', () => {
      const p = newProgress();

      parseKopiaSyncProgress('\r  Found 30 BLOBs in the destination repository (28.5 KB)', p);
      expect(p.processedBytes).toBe(28_500);
      expect(p.totalBlobs).toBeUndefined();

      parseKopiaSyncProgress(
        '  Found 500 BLOBs (3.0 GB) in the source repository, 40 (760 MB) to copy',
        p
      );
      expect(p.totalBlobs).toBe(40);
      expect(p.processedBlobs).toBe(0);
      expect(p.processedBytes).toBe(0);

      parseKopiaSyncProgress('  Copied 10 blobs (190 MB), Speed: 8 MB/s, ETA: 1m', p);
      expect(p.totalBlobs).toBe(40);
      expect(p.processedBlobs).toBe(10);
      expect(p.processedBytes).toBe(190_000_000);
    });
  });

  describe('non-matching lines', () => {
    it('leaves progress untouched on header lines', () => {
      const p = newProgress();
      parseKopiaSyncProgress('Synchronizing repositories:\n  Source: …\n  Destination: …', p);
      expect(p.processedBlobs).toBeUndefined();
      expect(p.totalBlobs).toBeUndefined();
      expect(p.processedBytes).toBeUndefined();
      expect(p.totalBytes).toBe(1_000_000);
    });

    it('leaves progress untouched on "Looking for BLOBs to synchronize..."', () => {
      const p = newProgress();
      parseKopiaSyncProgress('Looking for BLOBs to synchronize...', p);
      expect(p.processedBlobs).toBeUndefined();
      expect(p.processedBytes).toBeUndefined();
    });
  });
});

// Without --delete nothing surfaces the growing remote until a user runs out of cloud quota.
describe('sync arguments', () => {
  it('mirrors the local repository to an rclone destination', () => {
    const args = buildRcloneSyncArgs('sync-to', 'gdrive:SignalK-Backups/vessel-host-abc123', []);

    expect(args).toContain('--delete');
    expect(args.slice(0, 3)).toEqual(['repository', 'sync-to', 'rclone']);
  });

  it('mirrors the local repository to a filesystem destination', () => {
    const args = buildFilesystemSyncArgs(
      'sync-to',
      '/mnt/share/SignalK-Backups/vessel-host-abc123'
    );

    expect(args).toContain('--delete');
    expect(args.slice(0, 3)).toEqual(['repository', 'sync-to', 'filesystem']);
  });

  it('keeps provider flags after the ones the sync always sets', () => {
    const args = buildRcloneSyncArgs('sync-to', 'gdrive:x', [
      '--rclone-args=--drive-chunk-size=256k',
    ]);

    expect(args.at(-1)).toBe('--rclone-args=--drive-chunk-size=256k');
    expect(args).toContain('--delete');
  });
});
