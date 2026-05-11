import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir } from 'fs/promises';
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
