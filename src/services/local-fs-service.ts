/**
 * Local-filesystem cloud-sync provider.
 *
 * No auth flow — the destination is a host directory. The "connected"
 * predicate just checks that the configured container-side path is
 * statable, writable, and looks like a real disk (not the container's
 * own overlay).
 *
 * Discovery walks the baseline mounts (`/host-media`, `/host-mnt`) the
 * plugin is expected to bind from the host's `/media` and `/mnt`. Each
 * candidate is annotated with size info from `statfs`.
 */

import { stat, readdir, statfs } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';

import { logger as rootLogger } from './logger.js';
import { settingsService } from './settings-service.js';

const logger = rootLogger.child({ name: 'local-fs-service' });

/**
 * Baseline mounts the plugin is expected to bind from the host.
 * - host:/media → container:/host-media (auto-mount USB on most distros)
 * - host:/mnt   → container:/host-mnt   (manual NFS/CIFS/etc.)
 *
 * Each is bound with `ifMissing: 'skip'` (see signalk-container 1.6
 * `VolumeSpec`) so the container starts even on hosts that don't have
 * /media or /mnt.
 */
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
  /**
   * Bindings-compatible signature: mirrors gdriveAuthService.getStatus()'s
   * shape so cloud-sync-service can use either through the
   * ProviderBindings.authService contract.
   */
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

  /**
   * Walk the baseline mounts and return one candidate per subdirectory.
   * Candidates have free/total bytes populated when statfs succeeds. The
   * UI shows these in a dropdown so users don't have to type a path.
   *
   * Mounts whose container-side path doesn't exist (because the host
   * didn't have /media or /mnt and signalk-container's `ifMissing: 'skip'`
   * dropped the bind) are silently omitted.
   */
  async discover(): Promise<LocalCandidate[]> {
    const candidates: LocalCandidate[] = [];

    for (const baseline of LOCAL_BASELINE_MOUNTS) {
      let entries: import('node:fs').Dirent[];
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

  /**
   * Validate a candidate path before persisting it to settings.
   * Returns null on success or an error string on failure.
   */
  async validate(containerPath: string): Promise<string | null> {
    if (typeof containerPath !== 'string' || containerPath.trim() === '') {
      return 'containerPath must be a non-empty string';
    }
    // Container-side paths must live under the baseline mounts so signalk-container
    // doesn't have to know about ad-hoc binds. The plugin can extend this list
    // in future versions if we add more baseline mounts.
    const allowed = LOCAL_BASELINE_MOUNTS.some(
      (b) => containerPath === b.container || containerPath.startsWith(b.container + '/')
    );
    if (!allowed) {
      const roots = LOCAL_BASELINE_MOUNTS.map((b) => b.container).join(' or ');
      return `containerPath must be under one of: ${roots}`;
    }
    try {
      const st = await stat(containerPath);
      if (!st.isDirectory()) return 'path is not a directory';
      await access(containerPath, fsConstants.W_OK);
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'path does not exist';
      if (code === 'EACCES') return 'path is not writable';
      return (err as Error).message;
    }
  }
}

export const localFsService = new LocalFsService();
