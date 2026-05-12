// SMB cloud-sync provider — wraps rclone's `smb` backend.
//
// The destination is an SMB share. We talk to it via rclone, which
// stores the credentials in rclone.conf in clear text (matching what
// `rclone config` writes by default). The plugin/UI flags this to the
// user so they can decide if it's an acceptable threat model on their
// host.

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';

import { config } from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import { settingsService } from './settings-service.js';

const execFile = promisify(execFileCb);

const logger = rootLogger.child({ name: 'smb-auth-service' });

// rclone uses [smb] as the section name in its config file. Distinct
// from RCLONE_GDRIVE_REMOTE_NAME so both can coexist in rclone.conf
// without colliding.
export const RCLONE_SMB_REMOTE_NAME = 'smb';

// Validate the connection by listing the share root. 5s is enough for
// a healthy LAN-local NAS; anything slower probably indicates a wrong
// host or unreachable network and we want to fail loudly rather than
// hang the connect form.
const TEST_TIMEOUT_MS = 5000;

export interface SmbConnectInput {
  host: string;
  share: string;
  user: string;
  password: string;
  domain?: string;
}

export interface SmbStatus {
  connected: boolean;
  configured: boolean;
  /** Human-readable label shown in the UI when connected. */
  email?: string;
  host?: string;
  share?: string;
  user?: string;
}

class SmbAuthService {
  // Same shape as gdriveAuthService.getStatus() so cloud-sync-service can
  // use either through ProviderBindings.authService.
  async getStatus(): Promise<SmbStatus> {
    const settings = await settingsService.get();
    if (settings.cloudSync?.provider !== 'smb') {
      return { connected: false, configured: false };
    }
    const { host, share, user } = settings.cloudSync;
    const conf = await this.readRcloneConfigSafely();
    if (!conf || !conf.includes(`[${RCLONE_SMB_REMOTE_NAME}]`)) {
      return { connected: false, configured: false, host, share, user };
    }
    return {
      connected: true,
      configured: true,
      host,
      share,
      user,
      email: `${user}@${host}/${share}`,
    };
  }

  // Validate the inputs by writing the [smb] block, listing the share,
  // and persisting only on success. On failure the in-progress block is
  // removed so we never leave a partially-saved state.
  async connect(input: SmbConnectInput): Promise<void> {
    const { host, share, user, password, domain } = input;
    if (!host || !share || !user) {
      throw new Error('host, share, and user are required');
    }

    await this.writeRcloneSmbBlock({ host, user, password, domain });

    try {
      await execFile(
        config.rcloneBinaryPath,
        ['lsd', '--config', config.rcloneConfigPath, `${RCLONE_SMB_REMOTE_NAME}:${share}`],
        { timeout: TEST_TIMEOUT_MS }
      );
    } catch (err) {
      // Roll back the partial write so the next connect attempt starts
      // from a clean state.
      await this.removeRcloneSmbBlock();
      const stderr = (err as { stderr?: string }).stderr ?? '';
      throw new Error(`SMB connection test failed: ${stderr.trim() || (err as Error).message}`, {
        cause: err,
      });
    }

    // Persist non-secret fields to settings.json. The password lives only
    // in rclone.conf.
    const current = (await settingsService.get()).cloudSync;
    await settingsService.update({
      cloudSync: {
        provider: 'smb',
        host,
        share,
        user,
        ...(domain && domain !== '' ? { domain } : {}),
        syncMode: current?.syncMode ?? 'manual',
        syncFrequency: current?.syncFrequency ?? 'daily',
        lastSync: null,
        lastSyncError: null,
      },
    });
    logger.info({ host, share, user }, 'SMB share connected');
  }

  async disconnect(): Promise<void> {
    await this.removeRcloneSmbBlock();
    // Caller is responsible for resetting settings.cloudSync.provider —
    // /api/cloud/smb/disconnect does that and reverts to gdrive.
  }

  private async readRcloneConfigSafely(): Promise<string | null> {
    if (!existsSync(config.rcloneConfigPath)) return null;
    try {
      return await readFile(config.rcloneConfigPath, 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to read rclone.conf');
      return null;
    }
  }

  private async writeRcloneSmbBlock(opts: {
    host: string;
    user: string;
    password: string;
    domain?: string;
  }): Promise<void> {
    const existing = (await this.readRcloneConfigSafely()) ?? '';
    const stripped = stripSection(existing, RCLONE_SMB_REMOTE_NAME);
    const block = [
      `[${RCLONE_SMB_REMOTE_NAME}]`,
      'type = smb',
      `host = ${opts.host}`,
      `user = ${opts.user}`,
      `pass = ${opts.password}`,
      ...(opts.domain ? [`domain = ${opts.domain}`] : []),
      '',
    ].join('\n');
    const next = stripped.trim().length > 0 ? `${stripped.trim()}\n\n${block}` : block;
    await writeFile(config.rcloneConfigPath, next, { mode: 0o600 });
    // chmod is needed when the file already existed (writeFile's mode
    // only applies on create). Keep parity with gdrive-auth-service.
    try {
      await chmod(config.rcloneConfigPath, 0o600);
    } catch (err) {
      logger.warn({ err }, 'Could not chmod rclone.conf to 0o600');
    }
  }

  private async removeRcloneSmbBlock(): Promise<void> {
    const existing = await this.readRcloneConfigSafely();
    if (!existing) return;
    const next = stripSection(existing, RCLONE_SMB_REMOTE_NAME);
    await writeFile(config.rcloneConfigPath, next, { mode: 0o600 });
    try {
      await chmod(config.rcloneConfigPath, 0o600);
    } catch {
      // best-effort
    }
  }
}

// Remove the named [section] and all of its lines (up to the next
// [section] header or end-of-file). Idempotent — returns the input
// unchanged if the section isn't present.
function stripSection(conf: string, sectionName: string): string {
  const lines = conf.split('\n');
  const out: string[] = [];
  let inTarget = false;
  for (const line of lines) {
    const isHeader = /^\s*\[[^\]]+\]\s*$/.test(line);
    if (isHeader) {
      inTarget = line.trim() === `[${sectionName}]`;
      if (inTarget) continue;
    }
    if (!inTarget) out.push(line);
  }
  return out.join('\n');
}

export const smbAuthService = new SmbAuthService();
