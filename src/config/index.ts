/**
 * signalk-backup-server configuration
 *
 * All paths default to a single DATA_DIR (mounted by the plugin via
 * signalkDataMount, then sub-pathed under plugin-config-data/signalk-backup/).
 * The plugin sets DATA_DIR to that sub-path; everything below derives from it.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { join } from 'path';

const LogLevel = Type.Union([
  Type.Literal('trace'),
  Type.Literal('debug'),
  Type.Literal('info'),
  Type.Literal('warn'),
  Type.Literal('error'),
  Type.Literal('fatal'),
]);

const NodeEnv = Type.Union([
  Type.Literal('development'),
  Type.Literal('production'),
  Type.Literal('test'),
]);

const configSchema = Type.Object({
  port: Type.Number({ default: 3010 }),

  /** Root for all persistent state: settings.json, kopia repo, rclone.conf, install-id. */
  dataDir: Type.String(),

  /** SignalK data dir on host, mounted read+write so we can read config and restore. */
  signalkDataPath: Type.String(),

  /** Kopia repository path (a subdir of dataDir). */
  kopiaRepoPath: Type.String(),

  /** Kopia binary path. */
  kopiaBinaryPath: Type.String({ default: '/usr/local/bin/kopia' }),

  /** Kopia config dir (small per-process state, subdir of dataDir). */
  kopiaConfigPath: Type.String(),

  /** rclone binary path. */
  rcloneBinaryPath: Type.String({ default: '/usr/local/bin/rclone' }),

  /** rclone config file path (subdir of dataDir, contains Drive OAuth token). */
  rcloneConfigPath: Type.String(),

  /** SignalK server version, set by the plugin via env (used to tag backups). */
  signalkVersion: Type.String({ default: 'unknown' }),

  /** Maximum upload file size in bytes (default 1GB). */
  maxUploadSize: Type.Number({ default: 1024 * 1024 * 1024 }),

  logLevel: LogLevel,
  nodeEnv: NodeEnv,
});

export type Config = Static<typeof configSchema>;

export function loadConfig(): Config {
  const dataDir = process.env['DATA_DIR'] ?? '/data';
  const signalkDataPath = process.env['SIGNALK_DATA_PATH'] ?? '/signalk-data';

  const rawConfig = {
    port: parseInt(process.env['PORT'] ?? '3010', 10),
    dataDir,
    signalkDataPath,
    kopiaRepoPath: process.env['KOPIA_REPO_PATH'] ?? join(dataDir, 'kopia-repo'),
    kopiaBinaryPath: process.env['KOPIA_BINARY_PATH'] ?? '/usr/local/bin/kopia',
    kopiaConfigPath: process.env['KOPIA_CONFIG_PATH'] ?? join(dataDir, 'kopia-config'),
    rcloneBinaryPath: process.env['RCLONE_BINARY_PATH'] ?? '/usr/local/bin/rclone',
    rcloneConfigPath: process.env['RCLONE_CONFIG_PATH'] ?? join(dataDir, 'rclone.conf'),
    signalkVersion: process.env['SIGNALK_VERSION'] ?? 'unknown',
    maxUploadSize: parseInt(process.env['MAX_UPLOAD_SIZE'] ?? String(1024 * 1024 * 1024), 10),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
  };

  if (!Value.Check(configSchema, rawConfig)) {
    const errors = [...Value.Errors(configSchema, rawConfig)];
    throw new Error(
      `Invalid configuration: ${errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`
    );
  }

  return Value.Default(configSchema, rawConfig) as Config;
}

export const config = loadConfig();
