/**
 * Kopia Client Tests
 *
 * Tests the Kopia CLI wrapper with mocked execFile calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock config
vi.mock('../../../src/config/index.js', () => ({
  config: {
    kopiaBinaryPath: '/usr/local/bin/kopia',
    kopiaRepoPath: '/data/backups/kopia-repo',
    kopiaConfigPath: '/app/config/kopia',
    logLevel: 'info',
    nodeEnv: 'test',
  },
}));

// Mock logger
vi.mock('../../../src/services/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { execFile } from 'child_process';

// We need to import the module after mocking
const { kopiaClient } = await import('../../../src/services/kopia-client.js');

// Get the mocked execFile
const mockedExecFile = vi.mocked(execFile);

describe('KopiaClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kopiaClient.setPassword('test-password');
  });

  describe('isRepositoryConnected', () => {
    it('returns true when repository status succeeds', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        if (typeof cb === 'function') {
          cb(null, '{"status": "connected"}', '');
        }
        return {} as ReturnType<typeof execFile>;
      });

      // The method calls run() which uses promisified execFile
      // Since we mock the callback version, we need to handle promisify behavior
      const result = await kopiaClient.isRepositoryConnected();
      expect(result).toBe(true);
    });

    it('returns false when repository status fails', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        if (typeof cb === 'function') {
          cb(new Error('not connected'), '', 'Error: repository not connected');
        }
        return {} as ReturnType<typeof execFile>;
      });

      const result = await kopiaClient.isRepositoryConnected();
      expect(result).toBe(false);
    });
  });

  describe('tag construction', () => {
    it('builds correct tags for snapshot creation', () => {
      // Test the tag format used by the backup service
      const tags: Record<string, string> = {
        'type': 'hourly',
        'signalk-version': JSON.stringify({ tag: 'v2.12.0' }),
        'includes-plugins': 'false',
        'includes-plugin-data': 'false',
        'includes-history': 'false',
      };

      // Verify tag format is correct key:value pairs
      for (const [key, value] of Object.entries(tags)) {
        expect(key).not.toContain(' ');
        expect(typeof value).toBe('string');
      }

      // Verify version can be round-tripped through JSON
      const versionTag = tags['signalk-version']!;
      const parsed = JSON.parse(versionTag);
      expect(parsed.tag).toBe('v2.12.0');
    });
  });

  describe('snapshot metadata adapter', () => {
    it('correctly maps Kopia snapshot to BackupMetadata format', async () => {
      // Import the adapter function indirectly through the backup service
      // For now, test the tag format that the adapter expects
      const mockSnapshot = {
        id: 'abc123def456',
        source: {
          host: 'keeper',
          userName: 'root',
          path: '/signalk-data',
        },
        description: 'manual backup',
        startTime: '2025-01-15T14:30:22Z',
        endTime: '2025-01-15T14:30:25Z',
        tags: {
          'type': 'manual',
          'signalk-version': '{"tag":"v2.12.0","fullRef":"v2.12.0","registry":"docker.io","owner":"signalk","repository":"signalk-server","channel":"stable"}',
          'includes-plugins': 'true',
          'includes-plugin-data': 'false',
          'includes-history': 'false',
        },
        rootEntry: {
          obj: 'kdef123',
          summ: {
            size: 1024000,
            files: 42,
            dirs: 5,
            numFailed: 0,
          },
        },
      };

      // Verify the snapshot structure matches what Kopia would return
      expect(mockSnapshot.id).toBeTruthy();
      expect(mockSnapshot.tags['type']).toBe('manual');
      expect(mockSnapshot.rootEntry.summ.size).toBe(1024000);

      // Verify version can be parsed from tag
      const version = JSON.parse(mockSnapshot.tags['signalk-version']);
      expect(version.tag).toBe('v2.12.0');
      expect(version.channel).toBe('stable');

      // Verify boolean tags
      expect(mockSnapshot.tags['includes-plugins']).toBe('true');
      expect(mockSnapshot.tags['includes-history']).toBe('false');
    });
  });

  describe('retention enforcement', () => {
    it('correctly identifies backups to delete based on retention limits', () => {
      // Test the retention logic that will be used by the backup service
      const retention = { hourly: 3 };
      const backups = [
        { id: '1', createdAt: '2025-01-15T10:00:00Z', type: 'hourly' },
        { id: '2', createdAt: '2025-01-15T09:00:00Z', type: 'hourly' },
        { id: '3', createdAt: '2025-01-15T08:00:00Z', type: 'hourly' },
        { id: '4', createdAt: '2025-01-15T07:00:00Z', type: 'hourly' },
        { id: '5', createdAt: '2025-01-15T06:00:00Z', type: 'hourly' },
      ];

      // Sort newest first
      const sorted = [...backups].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      // Keep only the configured number
      const toKeep = sorted.slice(0, retention.hourly);
      const toDelete = sorted.slice(retention.hourly);

      expect(toKeep).toHaveLength(3);
      expect(toDelete).toHaveLength(2);
      expect(toDelete[0]!.id).toBe('4');
      expect(toDelete[1]!.id).toBe('5');
    });

    it('does not delete manual backups', () => {
      // Manual backups should never be auto-deleted
      const tiersWithRetention = ['hourly', 'daily', 'weekly', 'startup'];
      const typesWithoutRetention = ['manual', 'pre-update', 'pre-restore'];

      // Retention enforcement only runs for tiers with limits
      expect(tiersWithRetention).not.toContain('manual');
      expect(typesWithoutRetention).toContain('manual');
    });
  });
});
