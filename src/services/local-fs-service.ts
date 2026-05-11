// Cloud-sync provider for paths the plugin has bind-mounted from the host
// — no rclone, kopia writes to the path directly.

import { access, readdir, realpath, stat, statfs } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { relative, resolve } from 'path';

import { logger as rootLogger } from './logger.js';
import { settingsService } from './settings-service.js';

const logger = rootLogger.child({ name: 'local-fs-service' });

// Mirrors the buildContainerConfig volumes in signalk-backup. Both binds
// declare `ifMissing: 'skip'` so the container starts on hosts without
// /media or /mnt — the discovery list is just empty in that case.
export const LOCAL_BASELINE_MOUNTS: ReadonlyArray<{ container: string; host: string }> = [
  { container: '/host-media', host: '/media' },
  { container: '/host-mnt', host: '/mnt' },
];

export interface LocalCandidate {
  /** Container-side absolute path (what gets persisted in settings.cloudSync). */
  containerPath: string;
  /** Human-readable host-side path for display in the UI. */
  hostPath: string;
  /** Free bytes on the filesystem the path lives on, or null if unknown. */
  freeBytes: number | null;
  /** Total bytes on the filesystem the path lives on, or null if unknown. */
  totalBytes: number | null;
}

export interface LocalStatus {
  /** True when a local destination is configured and the path is reachable + writable. */
  connected: boolean;
  /** Always true for local — no auth to configure separately. */
  configured: boolean;
  /** Configured container-side path, if any. */
  containerPath?: string;
  /** Configured host-side path, if any. */
  hostPath?: string;
  /** Bytes free on the destination's filesystem, when reachable. */
  freeBytes?: number;
  /** Bytes total on the destination's filesystem, when reachable. */
  totalBytes?: number;
  /** Why connected is false, if it is. */
  error?: string;
}

class LocalFsService {
  // Shape mirrors gdriveAuthService.getStatus() so both fit the
  // ProviderBindings.authService contract in cloud-sync-service.
  async getStatus(): Promise<LocalStatus> {
    const settings = await settingsService.get();
    if (settings.cloudSync?.provider !== 'local') {
      return { connected: false, configured: true };
    }
    const { containerPath, hostPath } = settings.cloudSync;
    try {
      const st = await stat(containerPath);
      if (!st.isDirectory()) {
        return {
          connected: false,
          configured: true,
          containerPath,
          hostPath,
          error: 'configured path is not a directory',
        };
      }
      await access(containerPath, fsConstants.W_OK);

      let freeBytes: number | undefined;
      let totalBytes: number | undefined;
      try {
        const fs = await statfs(containerPath);
        freeBytes = Number(fs.bavail) * Number(fs.bsize);
        totalBytes = Number(fs.blocks) * Number(fs.bsize);
      } catch {
        // statfs not critical for connectivity
      }

      return {
        connected: true,
        configured: true,
        containerPath,
        hostPath,
        freeBytes,
        totalBytes,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const error =
        code === 'ENOENT'
          ? 'path does not exist (drive unplugged or unmounted?)'
          : code === 'EACCES'
            ? 'path is not writable'
            : (err as Error).message;
      return { connected: false, configured: true, containerPath, hostPath, error };
    }
  }

  async discover(): Promise<LocalCandidate[]> {
    const candidates: LocalCandidate[] = [];

    for (const baseline of LOCAL_BASELINE_MOUNTS) {
      let entries: import('fs').Dirent[];
      try {
        entries = await readdir(baseline.container, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          logger.debug({ baseline }, 'baseline mount not present — skipping');
        } else {
          logger.debug({ baseline, err }, 'failed to scan baseline mount');
        }
        continue;
      }

      for (const entry of entries) {
        // Skip non-dir entries (devices, symlinks to nowhere, lost+found).
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name === 'lost+found') continue;

        const containerPath = `${baseline.container}/${entry.name}`;
        const hostPath = `${baseline.host}/${entry.name}`;
        // For symlinks, prove the target is reachable + a directory.
        try {
          const st = await stat(containerPath);
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }

        let freeBytes: number | null = null;
        let totalBytes: number | null = null;
        try {
          const fs = await statfs(containerPath);
          freeBytes = Number(fs.bavail) * Number(fs.bsize);
          totalBytes = Number(fs.blocks) * Number(fs.bsize);
        } catch {
          // statfs is non-critical; surface the candidate without sizes.
        }

        candidates.push({ containerPath, hostPath, freeBytes, totalBytes });
      }
    }

    return candidates;
  }

  // Returns null on success or an error string on failure. Containment
  // is checked on the realpath-resolved forms because a symlink under a
  // baseline mount could otherwise smuggle the destination anywhere on
  // the container's filesystem (e.g. `ln -s /etc /host-media/sneaky`).
  async validate(containerPath: string): Promise<string | null> {
    if (typeof containerPath !== 'string' || containerPath.trim() === '') {
      return 'containerPath must be a non-empty string';
    }

    let resolvedPath: string;
    try {
      resolvedPath = await realpath(resolve(containerPath));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'path does not exist';
      return (err as Error).message;
    }

    let containedUnder: string | null = null;
    for (const b of LOCAL_BASELINE_MOUNTS) {
      let resolvedBase: string;
      try {
        resolvedBase = await realpath(b.container);
      } catch {
        // Baseline missing on this host — skip; ifMissing:'skip' on the
        // bind means it's a normal case, just no candidate root here.
        continue;
      }
      const rel = relative(resolvedBase, resolvedPath);
      if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) {
        containedUnder = resolvedBase;
        break;
      }
    }
    if (!containedUnder) {
      const roots = LOCAL_BASELINE_MOUNTS.map((b) => b.container).join(' or ');
      return `containerPath must resolve under one of: ${roots}`;
    }

    try {
      const st = await stat(resolvedPath);
      if (!st.isDirectory()) return 'path is not a directory';
      await access(resolvedPath, fsConstants.W_OK);
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') return 'path is not writable';
      return (err as Error).message;
    }
  }
}

export const localFsService = new LocalFsService();
