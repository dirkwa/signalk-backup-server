import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir } from 'fs/promises';
import { Readable } from 'stream';
import path from 'path';
import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';

const execFile = promisify(execFileCb);
const logger = rootLogger.child({ service: 'kopia-client' });

/** Default timeout for kopia commands (10 minutes) */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Short timeout for quick commands like list/status (30 seconds) */
const SHORT_TIMEOUT_MS = 30 * 1000;

export interface KopiaSnapshotSource {
  host: string;
  userName: string;
  path: string;
}

export interface KopiaSnapshotSummary {
  size: number;
  files: number;
  dirs: number;
  numFailed: number;
}

export interface KopiaSnapshot {
  id: string;
  source: KopiaSnapshotSource;
  description: string;
  startTime: string;
  endTime: string;
  tags: Record<string, string>;
  rootEntry: {
    obj: string;
    summ: KopiaSnapshotSummary;
  };
  retentionReasons?: string[];
}

export interface KopiaRepoStatus {
  configFile: string;
  status: string;
  storage: string;
  readonly?: boolean;
}

export interface KopiaContentStats {
  totalSize: number;
  count: number;
  dedupSavings?: number;
  compressionSavings?: number;
  originalSize?: number;
}

export interface KopiaPolicyRetention {
  keepLatest?: number;
  keepHourly?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepAnnual?: number;
}

export interface KopiaVerifyResult {
  verified: boolean;
  errors: string[];
}

export interface KopiaRestoreProgress {
  restoredFiles: number;
  restoredDirs: number;
  restoredBytes: number;
  /** e.g., "86.5 MB" */
  restoredSize: string;
  rawLine: string;
}

export interface KopiaLsEntry {
  name: string;
  /** Bytes; for directories this is kopia's logical entry count, not subtree size. */
  size: number;
  /** ISO-8601 with offset, as emitted by kopia. */
  mtime: string;
  isDir: boolean;
  /** Opaque kopia content/object ID — required to stream a file via `kopia show`. */
  objectId: string;
}

// Thrown when a snapshot or sub-path inside it doesn't exist, so route
// handlers can map to 404 instead of letting the generic kopia error
// surface as 500. Listing a file path instead of a directory raises the
// same error type — the message disambiguates.
export class KopiaEntryNotFoundError extends Error {
  constructor(
    message: string,
    public readonly snapshotId: string,
    public readonly subPath: string
  ) {
    super(message);
    this.name = 'KopiaEntryNotFoundError';
  }
}

class KopiaClient {
  private readonly binaryPath: string;
  private readonly repoPath: string;
  private readonly configPath: string;
  private password: string = '';

  /**
   * Temporary overrides for cloud restore — when set, all kopia commands
   * use the cloud config/password instead of the local one. This lets
   * cloud restore list + restore snapshots from the cloud repo without
   * disturbing the main local kopia connection.
   */
  private configPathOverride: string | null = null;
  private passwordOverride: string | null = null;

  constructor() {
    this.binaryPath = config.kopiaBinaryPath;
    this.repoPath = config.kopiaRepoPath;
    this.configPath = config.kopiaConfigPath;
  }

  /**
   * Set the repository password (called by backup service after reading from settings).
   * Kopia always requires a password.
   */
  setPassword(password: string): void {
    this.password = password;
  }

  /**
   * Set temporary config/password overrides for cloud restore.
   * While active, all kopia commands use the cloud repository connection.
   */
  setCloudOverrides(cloudConfigPath: string, cloudPassword: string): void {
    this.configPathOverride = cloudConfigPath;
    this.passwordOverride = cloudPassword;
  }

  /**
   * Clear cloud overrides, reverting to the local repository connection.
   */
  clearCloudOverrides(): void {
    this.configPathOverride = null;
    this.passwordOverride = null;
  }

  /**
   * Initialize a new Kopia filesystem repository.
   * Uses the password set via setPassword().
   */
  async initRepository(): Promise<void> {
    await mkdir(this.repoPath, { recursive: true });
    await mkdir(path.dirname(this.configPath), { recursive: true });

    const args = ['repository', 'create', 'filesystem', '--path', this.repoPath];

    await this.run(args, { timeout: SHORT_TIMEOUT_MS, json: false });

    logger.info({ repoPath: this.repoPath }, 'Kopia repository initialized');
  }

  /**
   * Connect to an existing Kopia repository.
   * Uses the password set via setPassword().
   */
  async connectRepository(): Promise<void> {
    const args = ['repository', 'connect', 'filesystem', '--path', this.repoPath];

    await this.run(args, { timeout: SHORT_TIMEOUT_MS, json: false });

    logger.debug('Connected to Kopia repository');
  }

  async isRepositoryConnected(): Promise<boolean> {
    try {
      await this.run(['repository', 'status'], {
        timeout: SHORT_TIMEOUT_MS,
        json: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getRepositoryStatus(): Promise<KopiaRepoStatus> {
    const result = await this.run(['repository', 'status'], {
      timeout: SHORT_TIMEOUT_MS,
    });
    return result as KopiaRepoStatus;
  }

  async disconnectRepository(): Promise<void> {
    await this.run(['repository', 'disconnect'], {
      timeout: SHORT_TIMEOUT_MS,
      json: false,
    });
  }

  async createSnapshot(
    sourcePath: string,
    options: {
      tags?: Record<string, string>;
      description?: string;
    } = {}
  ): Promise<KopiaSnapshot> {
    const args = ['snapshot', 'create', sourcePath];

    if (options.description) {
      args.push('--description', options.description);
    }

    if (options.tags) {
      for (const [key, value] of Object.entries(options.tags)) {
        args.push('--tags', `${key}:${value}`);
      }
    }

    const result = await this.run(args, { timeout: DEFAULT_TIMEOUT_MS });

    // kopia snapshot create --json returns the snapshot object
    return result as KopiaSnapshot;
  }

  async listSnapshots(
    options: {
      sourcePath?: string;
      tags?: Record<string, string>;
    } = {}
  ): Promise<KopiaSnapshot[]> {
    const args = ['snapshot', 'list', '--all'];

    if (options.sourcePath) {
      args.push(options.sourcePath);
    }

    if (options.tags) {
      for (const [key, value] of Object.entries(options.tags)) {
        args.push('--tags', `${key}:${value}`);
      }
    }

    const result = await this.run(args, { timeout: SHORT_TIMEOUT_MS });

    // kopia snapshot list --json returns either:
    // - A flat array of snapshot objects (each with id, source, tags, etc.)
    // - An array of source groups, each containing a "snapshots" array
    if (Array.isArray(result)) {
      const snapshots: KopiaSnapshot[] = [];
      for (const item of result) {
        const record = item as Record<string, unknown>;
        if (record && Array.isArray(record.snapshots)) {
          // Source-grouped format
          snapshots.push(...(record.snapshots as KopiaSnapshot[]));
        } else if (record && typeof record.id === 'string' && record.source) {
          // Flat snapshot format
          snapshots.push(item as KopiaSnapshot);
        }
      }
      return snapshots;
    }

    return [];
  }

  async restoreSnapshot(snapshotId: string, targetPath: string): Promise<void> {
    await mkdir(targetPath, { recursive: true });

    await this.run(
      [
        'snapshot',
        'restore',
        snapshotId,
        targetPath,
        '--overwrite-files',
        '--overwrite-directories',
      ],
      { timeout: DEFAULT_TIMEOUT_MS, json: false }
    );

    logger.info({ snapshotId, targetPath }, 'Snapshot restored');
  }

  /** Like restoreSnapshot but streams progress from stderr via spawn. */
  async restoreSnapshotWithProgress(
    snapshotId: string,
    targetPath: string,
    onProgress: (progress: KopiaRestoreProgress) => void
  ): Promise<void> {
    await mkdir(targetPath, { recursive: true });

    const args = [
      'snapshot',
      'restore',
      snapshotId,
      targetPath,
      '--overwrite-files',
      '--overwrite-directories',
    ];

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KOPIA_CONFIG_PATH: this.configPathOverride ?? this.configPath,
      KOPIA_PASSWORD: this.passwordOverride ?? this.password,
    };

    logger.debug({ cmd: this.binaryPath, args }, 'Running kopia restore with progress');

    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.binaryPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

      let stderrBuffer = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, DEFAULT_TIMEOUT_MS);

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        // Process complete lines
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? ''; // Keep incomplete last line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          logger.debug({ stderr: trimmed }, 'Kopia restore stderr');

          const progress = parseRestoreProgress(trimmed);
          if (progress) {
            onProgress(progress);
          }
        }
      });

      child.stdout.on('data', () => {
        // Discard stdout (not using --json)
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        // Process any remaining stderr
        if (stderrBuffer.trim()) {
          const progress = parseRestoreProgress(stderrBuffer.trim());
          if (progress) {
            onProgress(progress);
          }
        }

        if (timedOut) {
          reject(new Error('Kopia restore timed out'));
        } else if (code !== 0) {
          reject(new Error(`Kopia restore failed with exit code ${code}`));
        } else {
          logger.info({ snapshotId, targetPath }, 'Snapshot restored (with progress)');
          resolve();
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start kopia: ${err.message}`));
      });
    });
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.run(['snapshot', 'delete', snapshotId, '--delete'], {
      timeout: SHORT_TIMEOUT_MS,
      json: false,
    });

    logger.info({ snapshotId }, 'Snapshot deleted');
  }

  async verifySnapshot(snapshotId: string): Promise<KopiaVerifyResult> {
    try {
      await this.run(['snapshot', 'verify', '--sources', snapshotId], {
        timeout: DEFAULT_TIMEOUT_MS,
        json: false,
      });

      return { verified: true, errors: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { verified: false, errors: [message] };
    }
  }

  async setPolicy(sourcePath: string, retention: KopiaPolicyRetention): Promise<void> {
    const args = ['policy', 'set', sourcePath];

    if (retention.keepLatest !== undefined) {
      args.push('--keep-latest', String(retention.keepLatest));
    }
    if (retention.keepHourly !== undefined) {
      args.push('--keep-hourly', String(retention.keepHourly));
    }
    if (retention.keepDaily !== undefined) {
      args.push('--keep-daily', String(retention.keepDaily));
    }
    if (retention.keepWeekly !== undefined) {
      args.push('--keep-weekly', String(retention.keepWeekly));
    }
    if (retention.keepMonthly !== undefined) {
      args.push('--keep-monthly', String(retention.keepMonthly));
    }
    if (retention.keepAnnual !== undefined) {
      args.push('--keep-annual', String(retention.keepAnnual));
    }

    await this.run(args, { timeout: SHORT_TIMEOUT_MS, json: false });
    logger.info({ sourcePath, retention }, 'Kopia policy set');
  }

  /**
   * List one directory level inside a snapshot. `subPath` is relative to
   * the snapshot root and may be empty (= snapshot root). Throws
   * KopiaEntryNotFoundError when the path doesn't resolve to a directory
   * inside the snapshot — including when subPath points at a file (kopia
   * itself rejects this with "is not a directory object").
   */
  async listSnapshotEntries(snapshotId: string, subPath: string): Promise<KopiaLsEntry[]> {
    const normalized = normalizeSubPath(subPath);
    const target = normalized ? `${snapshotId}/${normalized}` : snapshotId;

    let stdout: string;
    try {
      const result = await this.run(['ls', '-l', '--show-object-id', target], {
        timeout: SHORT_TIMEOUT_MS,
        json: false,
      });
      stdout = typeof result === 'string' ? result : '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        /entry not found/i.test(message) ||
        /is not a directory object/i.test(message) ||
        /unable to parse ID/i.test(message)
      ) {
        throw new KopiaEntryNotFoundError(message, snapshotId, normalized);
      }
      throw err;
    }

    return parseKopiaLsOutput(stdout);
  }

  /**
   * Restore a sub-path of a snapshot into `targetPath`. For directories
   * targetPath is treated as the destination directory and is created if
   * missing. For single files targetPath is the destination file path
   * (kopia detects this from the source type). Pass `subPath = ''` to
   * restore the whole snapshot — equivalent to restoreSnapshot but
   * exposed here so partial restores share a single code path.
   */
  async restoreSubtree(
    snapshotId: string,
    subPath: string,
    targetPath: string,
    options: { overwrite?: boolean } = {}
  ): Promise<void> {
    const normalized = normalizeSubPath(subPath);
    const source = normalized ? `${snapshotId}/${normalized}` : snapshotId;
    const { overwrite = true } = options;

    if (overwrite) {
      // Both flags are needed: kopia would otherwise refuse to overwrite a
      // pre-existing file or directory at targetPath.
      await this.run(
        ['snapshot', 'restore', source, targetPath, '--overwrite-files', '--overwrite-directories'],
        { timeout: DEFAULT_TIMEOUT_MS, json: false }
      );
    } else {
      await this.run(['snapshot', 'restore', source, targetPath], {
        timeout: DEFAULT_TIMEOUT_MS,
        json: false,
      });
    }

    logger.info({ snapshotId, subPath: normalized, targetPath }, 'Subtree restored');
  }

  /**
   * Stream a single file's raw bytes from the repository by its kopia
   * object ID (obtained from listSnapshotEntries). Returns a Node Readable
   * the caller pipes into an HTTP response or another stream. Use for
   * download-only endpoints — partial restores go through restoreSubtree
   * so kopia handles permissions and atomicity.
   *
   * Caller is responsible for terminating the response on stream error;
   * we attach an `error` event so it surfaces instead of swallowing.
   */
  showFileByObjectId(objectId: string): Readable {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KOPIA_CONFIG_PATH: this.configPathOverride ?? this.configPath,
      KOPIA_PASSWORD: this.passwordOverride ?? this.password,
    };

    logger.debug({ objectId }, 'Streaming kopia show by objectId');

    const child = spawn(this.binaryPath, ['show', objectId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    let timedOut = false;
    let settled = false;
    // Match the rest of the wrapper: kopia subprocesses always have a
    // ceiling. Without this a hung kopia leaves the HTTP response open
    // until the client disconnects (or forever, for in-process callers).
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, DEFAULT_TIMEOUT_MS);

    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) child.stdout.destroy(err);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('close', (code) => {
      if (timedOut) {
        settle(new Error('kopia show timed out'));
      } else if (code !== 0) {
        const msg = stderrBuf.trim() || `kopia show exited with code ${code}`;
        // Emit via the stdout stream so the consumer's error handler runs.
        settle(new Error(msg));
      } else {
        settle();
      }
    });

    child.on('error', (err) => {
      settle(err);
    });

    return child.stdout;
  }

  /**
   * Run repository maintenance (garbage collection, compaction).
   * When force is true, uses --safety=none to skip the blob age check
   * and delete unreferenced blobs immediately.
   */
  async maintenanceRun(force = false): Promise<void> {
    const args = ['maintenance', 'run', '--full'];
    if (force) {
      args.push('--safety=none');
    }
    await this.run(args, {
      timeout: DEFAULT_TIMEOUT_MS,
      json: false,
    });
    logger.info({ force }, 'Kopia maintenance completed');
  }

  private async run(
    args: string[],
    options: { timeout?: number; json?: boolean } = {}
  ): Promise<unknown> {
    const { json = true } = options;
    let { timeout = DEFAULT_TIMEOUT_MS } = options;

    // When connected to a cloud repo via rclone, each kopia command starts a
    // new rclone subprocess that must authenticate with Google Drive. Short
    // timeouts (30s) aren't enough — use the default (10min) as a floor.
    if (this.configPathOverride && timeout < DEFAULT_TIMEOUT_MS) {
      timeout = DEFAULT_TIMEOUT_MS;
    }

    const fullArgs = [...args];
    if (json) {
      fullArgs.push('--json');
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      KOPIA_CONFIG_PATH: this.configPathOverride ?? this.configPath,
      KOPIA_PASSWORD: this.passwordOverride ?? this.password,
    };

    logger.debug({ cmd: this.binaryPath, args: fullArgs }, 'Running kopia command');

    try {
      const { stdout, stderr } = await execFile(this.binaryPath, fullArgs, {
        env,
        timeout,
        maxBuffer: 50 * 1024 * 1024, // 50MB for large snapshot listings
      });

      if (stderr && stderr.trim()) {
        logger.debug({ stderr: stderr.trim() }, 'Kopia stderr output');
      }

      if (json && stdout && stdout.trim()) {
        try {
          return JSON.parse(stdout) as unknown;
        } catch (parseError) {
          logger.warn(
            { stdout: stdout.substring(0, 500), parseError },
            'Failed to parse kopia JSON output'
          );
          throw new Error(`Failed to parse kopia output: ${(parseError as Error).message}`, {
            cause: parseError,
          });
        }
      }

      return stdout;
    } catch (error: unknown) {
      const execError = error as { code?: number; stderr?: string; message?: string };
      const errorMessage = execError.stderr?.trim() || execError.message || 'Unknown kopia error';

      logger.error(
        {
          args: fullArgs,
          exitCode: execError.code,
          error: errorMessage,
        },
        'Kopia command failed'
      );

      throw new Error(`Kopia command failed: ${errorMessage}`, { cause: error });
    }
  }
}

/**
 * Parse kopia restore stderr lines for progress info.
 * Kopia outputs lines like:
 *   "Restored 301 files, 84 directories and 0 symbolic links (86.5 MB)."
 *   "Processed 5 contents, 123456 bytes."
 *   "Restoring to ... "
 */
function parseRestoreProgress(line: string): KopiaRestoreProgress | null {
  // Match: "Restored N files, N directories and N symbolic links (SIZE)."
  const restoredMatch = line.match(/Restored\s+(\d+)\s+files?,\s*(\d+)\s+director/i);
  if (restoredMatch) {
    const files = parseInt(restoredMatch[1]!, 10);
    const dirs = parseInt(restoredMatch[2]!, 10);

    // Extract size: "(86.5 MB)" or "(1.2 GB)"
    const sizeMatch = line.match(/\(([^)]+)\)\s*\.?\s*$/);
    const sizeStr = sizeMatch?.[1] ?? '';
    const bytes = parseSizeToBytes(sizeStr);

    return {
      restoredFiles: files,
      restoredDirs: dirs,
      restoredBytes: bytes,
      restoredSize: sizeStr,
      rawLine: line,
    };
  }

  return null;
}

// `kopia ls` rejects `..` itself with "entry not found", but reject up
// front so the API surface returns a clean 400 rather than the kopia
// error masquerading as 404. Trim leading/trailing slashes and collapse
// runs of `/` — kopia handles them but normalization keeps logs readable.
function normalizeSubPath(subPath: string): string {
  if (!subPath) return '';
  if (subPath.includes('\0')) {
    throw new Error('subPath contains NUL byte');
  }
  const parts = subPath.split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '..')) {
    throw new Error('subPath must not contain ".." segments');
  }
  return parts.join('/');
}

const LS_LINE_REGEX =
  /^(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+[+-]?\S+)?)\s+(\S+)\s+(.+)$/;

// Parse the fixed-column output of `kopia ls -l --show-object-id`.
// Example line:
//   drwxrwxr-x            6 2026-05-20 16:32:37 +12 kfcf36854...  sub2/
//   -rw-rw-r--      5242880 2026-05-20 16:35:59 +12 Ix923877cf... big.bin
// The name column is everything after the objectId and may contain
// spaces. Directory entries always end in a trailing `/`.
export function parseKopiaLsOutput(stdout: string): KopiaLsEntry[] {
  const entries: KopiaLsEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = LS_LINE_REGEX.exec(line);
    if (!match) {
      logger.debug({ line }, 'Skipping unparseable kopia ls line');
      continue;
    }
    const [, mode, sizeStr, mtimeRaw, objectId, nameRaw] = match;
    const trimmedName = nameRaw!.replace(/\s+$/, '');
    const isDir = mode!.startsWith('d') || trimmedName.endsWith('/');
    const name = isDir ? trimmedName.replace(/\/+$/, '') : trimmedName;
    entries.push({
      name,
      size: parseInt(sizeStr!, 10),
      mtime: mtimeRaw!.trim(),
      isDir,
      objectId: objectId!,
    });
  }
  return entries;
}

function parseSizeToBytes(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
  if (!match) return 0;

  const value = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();

  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
    TB: 1000 * 1000 * 1000 * 1000,
    KIB: 1024,
    MIB: 1024 * 1024,
    GIB: 1024 * 1024 * 1024,
    TIB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(value * (multipliers[unit] ?? 1));
}

export const kopiaClient = new KopiaClient();
