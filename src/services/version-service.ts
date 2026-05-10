/**
 * Version Service (stub for signalk-backup-server)
 *
 * In keeper this service queried podman/registry to discover the running
 * SignalK container's image. In this backup-only fork there is no container
 * orchestration — the SignalK version is plumbed in via the SIGNALK_VERSION
 * env var by the host plugin (see config.signalkVersion).
 *
 * We expose a minimal `getCurrentVersion()` that returns an ImageVersion
 * shaped object with the version string as the `tag`. Other fields are
 * filled with safe defaults so backup snapshot tagging keeps working.
 */

import { config } from '../config/index.js';
import type { ImageVersion, ReleaseChannel } from '../types/version.js';

class VersionService {
  /**
   * Return the current SignalK version as an ImageVersion-shaped object.
   * Sourced from config.signalkVersion (env var set by the host plugin).
   * Returns null if the version is unset/unknown so callers can fall back.
   */
  async getCurrentVersion(): Promise<ImageVersion | null> {
    const tag = config.signalkVersion;
    if (!tag || tag === 'unknown') {
      return null;
    }

    return {
      fullRef: tag,
      registry: 'unknown',
      owner: 'signalk',
      repository: 'signalk-server',
      tag,
      channel: 'stable' as ReleaseChannel,
    };
  }
}

/** Singleton instance */
export const versionService = new VersionService();
