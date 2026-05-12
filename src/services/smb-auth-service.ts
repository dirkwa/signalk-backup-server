// WHY: rclone-obscure makes passwords reversible; UI surfaces trade-off; user/password may be empty for guest shares

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

const OBSCURE_TIMEOUT_MS = 2000;

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
      email: user ? `${user}@${host}/${share}` : `${host}/${share}`,
    };
  }

  // Validate the inputs by writing the [smb] block, listing the share,
  // and persisting only on success. On failure the in-progress block is
  // removed so we never leave a partially-saved state.
  async connect(input: SmbConnectInput): Promise<void> {
    const { host, share, user, password, domain } = input;
    // user/password optional: SMB shares can allow guest/anonymous access.
    if (!host || !share) {
      throw new Error('host and share are required');
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
    // INI-injection guard — newline in any field could open a fake
    // section and inject arbitrary rclone config; `[` / `]` could open
    // a fresh section header on the same line. Reject these eagerly.
    // user/password are optional (guest/anonymous shares) so only
    // validate them when provided.
    assertIniSafe('host', opts.host, 'no-whitespace');
    if (opts.user) {
      assertIniSafe('user', opts.user, 'no-newline-or-bracket');
    }
    if (opts.password) {
      assertIniSafe('password', opts.password, 'no-newline-or-bracket');
    }
    if (opts.domain !== undefined && opts.domain !== '') {
      assertIniSafe('domain', opts.domain, 'no-whitespace');
    }

    // rclone refuses plaintext `pass = …` ("input too short when revealing
    // password"). Run it through `rclone obscure` so it matches what
    // `rclone config` would have written. Password is passed via execFile
    // argv (no shell parsing) — briefly visible in `ps` but the container
    // is single-tenant (only our server runs in it).
    let obscured = '';
    if (opts.password) {
      const { stdout } = await execFile(config.rcloneBinaryPath, ['obscure', opts.password], {
        timeout: OBSCURE_TIMEOUT_MS,
      });
      obscured = stdout.trim();
    }

    const existing = (await this.readRcloneConfigSafely()) ?? '';
    const stripped = stripSection(existing, RCLONE_SMB_REMOTE_NAME);
    const block = [
      `[${RCLONE_SMB_REMOTE_NAME}]`,
      'type = smb',
      `host = ${opts.host}`,
      ...(opts.user ? [`user = ${opts.user}`] : []),
      ...(obscured ? [`pass = ${obscured}`] : []),
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

type IniRule = 'no-whitespace' | 'no-newline-or-bracket';

// Distinct rules let host/domain be stricter than user/password
// (where punctuation is legitimate).
function assertIniSafe(field: string, value: string, rule: IniRule): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  // No newlines or C0/DEL control chars in any field could close
  // the current line and open a fake INI section, injecting
  // arbitrary rclone remote config.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} contains control characters or newlines`);
  }
  if (rule === 'no-whitespace') {
    // Hostnames and SMB domains have no legitimate whitespace.
    if (/\s/.test(value)) {
      throw new Error(`${field} must not contain whitespace`);
    }
    if (/[[\]=]/.test(value)) {
      throw new Error(`${field} contains characters reserved for INI syntax`);
    }
  } else {
    // Usernames / passwords can legitimately contain `=` or whitespace
    // (corporate password policies do strange things), but `[` `]` at
    // the line start would still open a section header. We've already
    // banned newlines so a literal bracket mid-value is harmless to
    // rclone's parser; reject only the leading bracket case.
    if (/^\s*\[/.test(value)) {
      throw new Error(`${field} must not start with '['`);
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
