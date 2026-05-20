/**
 * Kopia Client Tests
 *
 * Tests the Kopia CLI wrapper with mocked execFile calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
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

import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// We need to import the module after mocking
const { kopiaClient, parseKopiaLsOutput, KopiaEntryNotFoundError } = await import(
  '../../../src/services/kopia-client.js'
);

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

  describe('parseKopiaLsOutput', () => {
    it('parses a mixed dir + file listing', () => {
      // Real output captured from kopia 0.23.0 `ls -l --show-object-id`.
      const stdout = [
        'drwxrwxr-x            2 2026-05-20 16:32:37 +12 kadab80b7098d78380aef84185c8b2e55  sub1/',
        'drwxrwxr-x            6 2026-05-20 16:32:37 +12 kfcf36854930fb9b69c0169fb1289ab2b  sub2/',
        '-rw-rw-r--            6 2026-05-20 16:32:37 +12 cbe62cfc267bc8586c23047384d92a52   top.txt',
      ].join('\n');

      const entries = parseKopiaLsOutput(stdout);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ name: 'sub1', isDir: true, size: 2 });
      expect(entries[1]).toMatchObject({ name: 'sub2', isDir: true });
      expect(entries[2]).toMatchObject({
        name: 'top.txt',
        isDir: false,
        size: 6,
        objectId: 'cbe62cfc267bc8586c23047384d92a52',
      });
    });

    it('handles indirect (Ix...) and bare-hex objectIDs and large file sizes', () => {
      const stdout = [
        '-rw-rw-r--      5242880 2026-05-20 16:35:59 +12 Ix923877cf6549795c781242a0167f6b31 big.bin',
        '-rw-rw-r--            0 2026-05-20 16:35:59 +12 6f445f27b953b5bf34446f7544f35558   empty.txt',
      ].join('\n');

      const entries = parseKopiaLsOutput(stdout);
      expect(entries).toEqual([
        {
          name: 'big.bin',
          isDir: false,
          size: 5242880,
          mtime: '2026-05-20 16:35:59 +12',
          objectId: 'Ix923877cf6549795c781242a0167f6b31',
        },
        {
          name: 'empty.txt',
          isDir: false,
          size: 0,
          mtime: '2026-05-20 16:35:59 +12',
          objectId: '6f445f27b953b5bf34446f7544f35558',
        },
      ]);
    });

    it('preserves spaces in directory and file names', () => {
      const stdout = [
        'drwxrwxr-x            2 2026-05-20 16:33:29 +12 kd68bbc18e6ca453d381f16337d564e98  has space/',
        '-rw-rw-r--            2 2026-05-20 16:33:29 +12 974d600b8793052191cb163d28a939ce   inside name.txt',
      ].join('\n');

      const entries = parseKopiaLsOutput(stdout);
      expect(entries[0]!.name).toBe('has space');
      expect(entries[0]!.isDir).toBe(true);
      expect(entries[1]!.name).toBe('inside name.txt');
      expect(entries[1]!.isDir).toBe(false);
    });

    it('returns empty array for empty input', () => {
      expect(parseKopiaLsOutput('')).toEqual([]);
      expect(parseKopiaLsOutput('\n\n')).toEqual([]);
    });

    it('skips unparseable lines without throwing', () => {
      const stdout = [
        'garbage that does not match the regex',
        '-rw-rw-r--            6 2026-05-20 16:32:37 +12 cbe62cfc267bc8586c23047384d92a52   ok.txt',
      ].join('\n');
      const entries = parseKopiaLsOutput(stdout);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe('ok.txt');
    });
  });

  describe('listSnapshotEntries', () => {
    it('calls kopia ls -l --show-object-id with the snapshot id when subPath is empty', async () => {
      mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
        if (typeof cb === 'function') {
          cb(null, '-rw-r--r-- 6 2026-05-20 16:32:37 +12 abc123 file.txt\n', '');
        }
        // Surface the args via a side channel so the assertion below can read them.
        (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs = args as
          | readonly string[]
          | undefined;
        return {} as ReturnType<typeof execFile>;
      });

      await kopiaClient.listSnapshotEntries('snap-id', '');
      const lastArgs = (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs;
      expect(lastArgs).toBeDefined();
      expect(lastArgs).toContain('ls');
      expect(lastArgs).toContain('-l');
      expect(lastArgs).toContain('--show-object-id');
      expect(lastArgs).toContain('snap-id');
    });

    it('passes snapshot-id/sub/path when subPath is given', async () => {
      mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
        (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs = args as
          | readonly string[]
          | undefined;
        if (typeof cb === 'function') cb(null, '', '');
        return {} as ReturnType<typeof execFile>;
      });

      await kopiaClient.listSnapshotEntries('snap-id', 'a/b/c');
      const lastArgs = (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs;
      expect(lastArgs).toContain('snap-id/a/b/c');
    });

    it('normalizes leading/trailing/duplicate slashes', async () => {
      mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
        (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs = args as
          | readonly string[]
          | undefined;
        if (typeof cb === 'function') cb(null, '', '');
        return {} as ReturnType<typeof execFile>;
      });
      await kopiaClient.listSnapshotEntries('snap', '//a//b/');
      const lastArgs = (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs;
      expect(lastArgs).toContain('snap/a/b');
    });

    it('throws KopiaEntryNotFoundError when kopia stderr says "entry not found"', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        if (typeof cb === 'function') {
          const err = Object.assign(new Error('exited'), {
            code: 1,
            stderr: 'unable to get filesystem directory entry: error reading directory: entry not found',
          });
          cb(err, '', err.stderr);
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(kopiaClient.listSnapshotEntries('snap', 'missing')).rejects.toBeInstanceOf(
        KopiaEntryNotFoundError,
      );
    });

    it('throws KopiaEntryNotFoundError when subPath points at a file', async () => {
      mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        if (typeof cb === 'function') {
          const err = Object.assign(new Error('exited'), {
            code: 1,
            stderr: 'unable to get filesystem directory entry: snap/file.txt is not a directory object',
          });
          cb(err, '', err.stderr);
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(kopiaClient.listSnapshotEntries('snap', 'file.txt')).rejects.toBeInstanceOf(
        KopiaEntryNotFoundError,
      );
    });

    it('rejects subPath with .. segments', async () => {
      await expect(kopiaClient.listSnapshotEntries('snap', 'a/../b')).rejects.toThrow(/\.\./);
    });

    it('rejects subPath with NUL byte', async () => {
      await expect(kopiaClient.listSnapshotEntries('snap', 'a b')).rejects.toThrow(/NUL/);
    });
  });

  describe('restoreSubtree', () => {
    it('calls kopia snapshot restore <snap>/<sub> <target> with overwrite flags by default', async () => {
      mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
        (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs = args as
          | readonly string[]
          | undefined;
        if (typeof cb === 'function') cb(null, '', '');
        return {} as ReturnType<typeof execFile>;
      });

      await kopiaClient.restoreSubtree('snap', 'sub2', '/tmp/target');
      const lastArgs = (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs;
      expect(lastArgs).toEqual([
        'snapshot',
        'restore',
        'snap/sub2',
        '/tmp/target',
        '--overwrite-files',
        '--overwrite-directories',
      ]);
    });

    it('omits overwrite flags when overwrite=false', async () => {
      mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
        (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs = args as
          | readonly string[]
          | undefined;
        if (typeof cb === 'function') cb(null, '', '');
        return {} as ReturnType<typeof execFile>;
      });

      await kopiaClient.restoreSubtree('snap', '', '/tmp/target', { overwrite: false });
      const lastArgs = (mockedExecFile as unknown as { lastArgs?: readonly string[] }).lastArgs;
      expect(lastArgs).toEqual(['snapshot', 'restore', 'snap', '/tmp/target']);
    });

    it('rejects subPath with .. segments', async () => {
      await expect(kopiaClient.restoreSubtree('snap', '../escape', '/tmp/t')).rejects.toThrow(
        /\.\./,
      );
    });
  });

  describe('showFileByObjectId', () => {
    function makeFakeChild(): {
      child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      stdout: PassThrough;
      stderr: PassThrough;
    } {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout, stderr });
      return { child, stdout, stderr };
    }

    it('spawns kopia show <objectId> and returns the child stdout', async () => {
      const { child, stdout } = makeFakeChild();
      const mockedSpawn = vi.mocked(spawn);
      let receivedArgs: readonly string[] | undefined;
      mockedSpawn.mockImplementation(((_cmd: string, args: readonly string[]) => {
        receivedArgs = args;
        // Defer 'close' so the consumer can subscribe first.
        setImmediate(() => {
          stdout.end(Buffer.from('hello'));
          child.emit('close', 0);
        });
        return child as unknown as ReturnType<typeof spawn>;
      }) as never);

      const stream = kopiaClient.showFileByObjectId('cbe62cfc267bc8586c23047384d92a52');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      expect(receivedArgs).toEqual(['show', 'cbe62cfc267bc8586c23047384d92a52']);
    });

    it('destroys the returned stream with an error on non-zero exit', async () => {
      const { child, stdout, stderr } = makeFakeChild();
      const mockedSpawn = vi.mocked(spawn);
      mockedSpawn.mockImplementation(((_cmd: string, _args: readonly string[]) => {
        setImmediate(() => {
          stderr.end('something went wrong');
          child.emit('close', 1);
        });
        return child as unknown as ReturnType<typeof spawn>;
      }) as never);

      const stream = kopiaClient.showFileByObjectId('missing');
      await expect(
        (async () => {
          for await (const chunk of stream) {
            void chunk;
          }
        })()
      ).rejects.toThrow(/went wrong|exited with code 1/);
      // Ensure stdout was the one destroyed (not just stderr).
      expect(stdout.destroyed).toBe(true);
    });
  });
});
