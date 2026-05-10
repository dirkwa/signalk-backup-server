/**
 * Version types
 *
 * In signalk-backup-server, version info is set by the plugin via the
 * SIGNALK_VERSION env var (see config.signalkVersion). We only keep the
 * shape that backup-service.ts needs to tag snapshots and restore them.
 */

/** Release channels for SignalK server (kept for ImageVersion compat) */
export type ReleaseChannel = 'stable' | 'beta' | 'master';

/** Parsed semantic version */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Image/version metadata that gets stored in backup snapshot tags.
 *
 * In keeper this was derived from the running container's image. Here it's
 * filled in by the version-service stub from config.signalkVersion (which is
 * set by the SignalK plugin host).
 */
export interface ImageVersion {
  /** Full image reference (best-effort, often "unknown" in this fork) */
  fullRef: string;
  /** Registry hostname (best-effort) */
  registry: string;
  /** Image owner/namespace (best-effort) */
  owner: string;
  /** Repository name (best-effort) */
  repository: string;
  /** Image tag (or SignalK version string in this fork) */
  tag: string;
  /** Image digest (SHA256) — usually unset in this fork */
  digest?: string;
  /** Detected release channel */
  channel: ReleaseChannel;
  /** Parsed semantic version (if applicable) */
  semver?: SemVer;
  /** Node.js major version (extracted from tag, usually undefined here) */
  nodeVersion?: string;
}
