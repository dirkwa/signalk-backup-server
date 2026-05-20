// Drives the partial-restore XState machine for restoring a single file
// or sub-directory from a snapshot. Two concerns separate from the full
// restore: (1) path safety — the custom target must resolve under
// signalkDataPath; (2) a sibling-rename "safety backup" instead of a
// kopia safety snapshot. Renaming the existing entry to a timestamped
// sibling is atomic, instant, and reversible — a kopia snapshot of just
// the destination subtree would add a real row to the backup list and
// run in seconds-to-minutes for what should feel like a copy.

import { createActor, type ActorRefFrom } from 'xstate';
import { existsSync } from 'fs';
import { rename, rm, stat, realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

import { restorePartialMachine } from './restore-partial-machine.js';
import { kopiaClient, KopiaEntryNotFoundError } from './kopia-client.js';
import { isAnyRestoreActive, registerRestoreActiveProbe } from './restore-lock.js';
import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import type {
  PartialRestoreContext,
  PartialRestoreProgress,
  PartialRestoreRequest,
  PartialRestoreResult,
  PartialRestoreStatus,
} from '../types/backup.js';

const logger = rootLogger.child({ service: 'restore-partial-service' });

// Source paths that must go through the full-restore code path because
// they have side effects partial restore can't satisfy: package.json
// changes require npm install on next SignalK start; node_modules drift
// breaks plugins; .kopia* is the repository's own state and restoring it
// would corrupt the working repo. Matching is leading-segment so e.g.
// `node_modules/some-plugin` is rejected without rejecting `data/node_modules.json`.
const REJECT_SOURCE_PATHS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^package\.json$/, reason: 'package.json requires npm install — use a full restore' },
  {
    pattern: /^package-lock\.json$/,
    reason: 'package-lock.json requires npm install — use a full restore',
  },
  {
    pattern: /^node_modules(\/|$)/,
    reason: 'node_modules must come from npm install, not a partial restore',
  },
  {
    pattern: /^\.kopia/,
    reason: 'kopia repository state must not be partially restored',
  },
];

export interface ResolvedTarget {
  /** Absolute path the entry will be written to. */
  absoluteTarget: string;
  /** Sibling path used to stash the existing entry before overwrite. */
  safetyPath: string;
}

/**
 * Resolve the on-disk target for a partial restore, enforcing that the
 * final path stays under signalkDataPath. Symlink-resolved using realpath
 * on the deepest existing ancestor (the target itself may not exist yet).
 *
 * Re-checked at restore time, not just request time — the parent could be
 * swapped to a symlink between the validation call and the kopia restore
 * call. Treat the function as the single boundary.
 */
export async function resolvePartialTarget(
  request: PartialRestoreRequest,
  options: { signalkDataPath: string }
): Promise<ResolvedTarget> {
  const { sourcePath, targetMode, customPath } = request;

  // Defence in depth — KopiaClient also rejects these, but rejecting at
  // the API boundary means the route returns 400 instead of a 500-shaped
  // kopia error.
  if (!sourcePath) {
    throw new PartialRestoreError('sourcePath is required', 'INVALID_SOURCE');
  }
  if (sourcePath.includes('\0')) {
    throw new PartialRestoreError('sourcePath must not contain NUL bytes', 'INVALID_SOURCE');
  }
  if (sourcePath.split('/').some((p) => p === '..')) {
    throw new PartialRestoreError('sourcePath must not contain ".." segments', 'INVALID_SOURCE');
  }
  if (isAbsolute(sourcePath)) {
    throw new PartialRestoreError(
      'sourcePath must be relative to the snapshot root',
      'INVALID_SOURCE'
    );
  }

  const root = await safeRealpath(options.signalkDataPath);

  let rawTarget: string;
  if (targetMode === 'original') {
    // Reject-list only applies to original-mode restores; custom-mode is
    // a copy the user inspects, so npm-install / .kopia concerns don't apply.
    for (const { pattern, reason } of REJECT_SOURCE_PATHS) {
      if (pattern.test(sourcePath)) {
        throw new PartialRestoreError(reason, 'RESTORE_NEEDS_FULL');
      }
    }
    rawTarget = join(root, sourcePath);
  } else {
    if (!customPath) {
      throw new PartialRestoreError(
        'customPath is required when targetMode is "custom"',
        'INVALID_TARGET'
      );
    }
    if (customPath.includes('\0')) {
      throw new PartialRestoreError('customPath must not contain NUL bytes', 'INVALID_TARGET');
    }
    // Trailing slash = "this is a directory" intent. Append the source's
    // basename so a file restore to "tmp/" produces "tmp/<filename>"
    // instead of overwriting "tmp" as a file.
    const explicitDir = /[/\\]$/.test(customPath);
    const baseCustom = explicitDir ? customPath.replace(/[/\\]+$/, '') : customPath;
    const joined = isAbsolute(baseCustom) ? baseCustom : join(root, baseCustom);
    rawTarget = explicitDir ? join(joined, basename(sourcePath)) : joined;
  }

  const resolved = resolve(rawTarget);
  // Resolve symlinks on the deepest existing ancestor — the target itself
  // may not exist (typical for "restore to custom path"). This catches
  // the "target's parent is a symlink to /etc" escape.
  const resolvedAncestor = await resolveExistingAncestor(resolved);
  const rel = relative(root, resolvedAncestor);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PartialRestoreError(
      `target ${rawTarget} resolves outside signalkDataPath`,
      'INVALID_TARGET'
    );
  }

  return {
    absoluteTarget: resolved,
    safetyPath: makeSafetyPath(resolved),
  };
}

function makeSafetyPath(targetAbs: string): string {
  // ISO timestamp, colon-free so the filename works on every OS. Sibling
  // rename keeps the existing inode reachable; no copy, no Kopia round-trip.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${targetAbs}.partial-restore-backup-${stamp}`;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // signalkDataPath should always exist in a working server; if it
    // doesn't, surface a clearer error than the symlink one.
    throw new PartialRestoreError(`signalkDataPath does not resolve: ${p}`, 'INTERNAL');
  }
}

async function resolveExistingAncestor(target: string): Promise<string> {
  let current = target;
  // Walk upward until we hit something that does exist (always
  // terminates at the root).
  while (current !== dirname(current)) {
    try {
      return await realpath(current);
    } catch {
      current = dirname(current);
    }
  }
  return await realpath(current);
}

export class PartialRestoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_SOURCE'
      | 'INVALID_TARGET'
      | 'RESTORE_NEEDS_FULL'
      | 'CONFLICT'
      | 'BUSY'
      | 'NOT_FOUND'
      | 'INTERNAL'
  ) {
    super(message);
    this.name = 'PartialRestoreError';
  }
}

class RestorePartialService {
  private actor: ActorRefFrom<typeof restorePartialMachine> | null = null;
  private startTime: number = 0;

  /**
   * Restore a single file or directory from a snapshot. The caller must
   * have already checked that no full restore is in progress — the
   * shared lock lives on RestoreService. We assert the partial-side lock
   * here.
   */
  async restorePartial(
    backupId: string,
    request: PartialRestoreRequest,
    onProgress?: (progress: PartialRestoreProgress) => void
  ): Promise<PartialRestoreResult> {
    if (this.isRestoring() || isAnyRestoreActive()) {
      throw new PartialRestoreError('A restore operation is already in progress', 'BUSY');
    }

    // Resolve + validate before we touch any actor state — a path-safety
    // error must not leave a half-started machine behind.
    const resolved = await resolvePartialTarget(request, {
      signalkDataPath: config.signalkDataPath,
    });

    // Conflict probe: if the target exists and the caller didn't opt in
    // to overwrite, surface the existing entry's mtime+size so the UI
    // can show a confirmation diff.
    const existing = await safeStat(resolved.absoluteTarget);
    if (existing && !request.confirmOverwrite) {
      throw new PartialRestoreError(`Target ${resolved.absoluteTarget} already exists`, 'CONFLICT');
    }

    if (this.actor) {
      this.actor.stop();
      this.actor = null;
    }

    this.startTime = Date.now();
    this.actor = createActor(restorePartialMachine);

    if (onProgress) {
      this.actor.subscribe((state) => {
        const context = state.context as PartialRestoreContext;
        onProgress({
          state: state.value as PartialRestoreStatus,
          progress: context.progress,
          statusMessage: context.statusMessage,
          error: context.error || undefined,
          backupId: context.backupId ?? undefined,
          sourcePath: context.sourcePath ?? undefined,
          targetPath: context.targetPath ?? undefined,
        });
      });
    }

    this.actor.start();
    this.actor.send({
      type: 'START_RESTORE',
      backupId,
      sourcePath: request.sourcePath,
      targetPath: resolved.absoluteTarget,
    });

    let safetyPathStashed: string | null = null;

    try {
      this.actor.send({ type: 'PREPARE_COMPLETE' });

      // Stash any existing target as a sibling before overwriting. This
      // is the partial-restore "safety backup": atomic, instant,
      // reversible via the inverse rename.
      if (existing) {
        await rename(resolved.absoluteTarget, resolved.safetyPath);
        safetyPathStashed = resolved.safetyPath;
        logger.info(
          { target: resolved.absoluteTarget, safetyPath: resolved.safetyPath },
          'Stashed existing target before partial restore'
        );
      }
      this.actor.send({
        type: 'SAFETY_SNAPSHOT_CREATED',
        safetyBackupId: safetyPathStashed ?? '',
      });

      // Re-validate the resolved target after the rename — TOCTOU defence:
      // a symlink swap between the initial probe and now would still get
      // caught here because realpath is run fresh.
      await resolvePartialTarget(request, {
        signalkDataPath: config.signalkDataPath,
      });

      this.actor.send({
        type: 'PROGRESS',
        progress: 50,
        statusMessage: 'Restoring sub-path from snapshot...',
      });

      await kopiaClient.restoreSubtree(backupId, request.sourcePath, resolved.absoluteTarget);

      this.actor.send({ type: 'EXTRACT_COMPLETE' });

      // Verify: kopia returns success if it wrote anything; confirm the
      // target now exists. A missing target after a "successful" kopia
      // run would mean the snapshot path was bogus (kopia's exit code
      // can be 0 even when the source path didn't exist in the snapshot
      // for some shapes — defence in depth).
      const wrote = existsSync(resolved.absoluteTarget);
      if (!wrote) {
        throw new Error(
          `kopia restore returned success but target ${resolved.absoluteTarget} does not exist`
        );
      }

      this.actor.send({ type: 'VERIFY_SUCCESS' });

      // Clean up the safety stash on success. Best-effort — if rm fails
      // the restore still succeeded; surface as a warning.
      if (safetyPathStashed) {
        await rm(safetyPathStashed, { recursive: true, force: true }).catch((err) => {
          logger.warn(
            { err, safetyPath: safetyPathStashed },
            'Failed to remove safety stash after successful partial restore'
          );
        });
      }

      const duration = Date.now() - this.startTime;
      logger.info(
        { backupId, sourcePath: request.sourcePath, target: resolved.absoluteTarget, duration },
        'Partial restore completed'
      );
      return {
        success: true,
        backupId,
        sourcePath: request.sourcePath,
        targetPath: resolved.absoluteTarget,
        duration,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, backupId, sourcePath: request.sourcePath }, 'Partial restore failed');

      this.actor.send({ type: 'ERROR', error: errorMessage });

      if (safetyPathStashed) {
        try {
          this.actor.send({ type: 'ROLLBACK' });
          // Inverse rename — best-effort, target might be partially
          // written so remove it first.
          await rm(resolved.absoluteTarget, { recursive: true, force: true });
          await rename(safetyPathStashed, resolved.absoluteTarget);
          this.actor.send({ type: 'ROLLBACK_COMPLETE' });
        } catch (rollbackError) {
          const rollbackMsg =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          logger.error(
            { rollbackError, safetyPath: safetyPathStashed },
            'Partial-restore rollback failed'
          );
          this.actor.send({ type: 'ERROR', error: rollbackMsg });
        }
      }

      if (err instanceof KopiaEntryNotFoundError) {
        throw new PartialRestoreError(
          `Source ${request.sourcePath} not found in backup`,
          'NOT_FOUND'
        );
      }
      throw new PartialRestoreError(errorMessage, 'INTERNAL');
    }
  }

  /**
   * Probe the existing target for a 409 conflict response. The route
   * handler calls this before invoking restorePartial when
   * confirmOverwrite is not set.
   */
  async describeExistingTarget(request: PartialRestoreRequest): Promise<{
    exists: boolean;
    mtime: string | null;
    size: number | null;
    targetPath: string;
  }> {
    const resolved = await resolvePartialTarget(request, {
      signalkDataPath: config.signalkDataPath,
    });
    const s = await safeStat(resolved.absoluteTarget);
    return {
      exists: s !== null,
      mtime: s?.mtime.toISOString() ?? null,
      size: s?.size ?? null,
      targetPath: resolved.absoluteTarget,
    };
  }

  getProgress(): PartialRestoreProgress | null {
    if (!this.actor) return null;
    const snapshot = this.actor.getSnapshot();
    const context = snapshot.context as PartialRestoreContext;
    return {
      state: snapshot.value as PartialRestoreStatus,
      progress: context.progress,
      statusMessage: context.statusMessage,
      error: context.error || undefined,
      backupId: context.backupId ?? undefined,
      sourcePath: context.sourcePath ?? undefined,
      targetPath: context.targetPath ?? undefined,
    };
  }

  getState(): PartialRestoreStatus {
    if (!this.actor) return 'idle';
    return this.actor.getSnapshot().value as PartialRestoreStatus;
  }

  isRestoring(): boolean {
    const state = this.getState();
    return (
      state !== 'idle' && state !== 'completed' && state !== 'failed' && state !== 'rolled_back'
    );
  }

  reset(): void {
    if (this.actor) {
      this.actor.send({ type: 'RESET' });
    }
  }
}

async function safeStat(p: string): Promise<{ mtime: Date; size: number } | null> {
  try {
    const s = await stat(p);
    return { mtime: s.mtime, size: s.size };
  } catch {
    return null;
  }
}

export const restorePartialService = new RestorePartialService();
registerRestoreActiveProbe(() => restorePartialService.isRestoring());
