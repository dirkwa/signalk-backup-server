/**
 * Google Drive Authentication Service
 *
 * Handles Google Drive authorization using rclone's built-in OAuth credentials.
 * rclone ships with Google-verified client credentials, so no user configuration
 * is needed — users just sign in with their Google account.
 *
 * Authorization flow:
 * 1. User clicks "Connect Google Drive" in UI
 * 2. Keeper spawns `rclone authorize "drive" --auth-no-open-browser`
 * 3. rclone starts HTTP server on port 53682 and prints auth URL
 * 4. Keeper fetches the rclone URL server-side, extracts Google OAuth URL
 * 5. UI opens the Google URL directly in a new browser tab
 * 6. User signs in to Google and clicks "Allow"
 * 7. Google redirects to http://127.0.0.1:53682 → rclone in container
 *    - Local access: redirect reaches rclone directly → token captured
 *    - Remote access: redirect fails, user pastes the URL → Keeper forwards
 *      it to rclone server-side
 * 8. Keeper captures token from rclone stdout, writes rclone.conf
 *
 * Port 53682 is mapped from the container to the host (localhost only)
 * via the Quadlet configuration.
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFile, writeFile, unlink, chmod } from 'fs/promises';
import { existsSync } from 'fs';

import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Name of the `[gdrive]` section in rclone.conf. Used by both this
 * service (when reading/writing the OAuth token) and by cloud-sync-service
 * (when building rclone paths like `gdrive:SignalK-Backups/{folderId}`).
 */
export const RCLONE_GDRIVE_REMOTE_NAME = 'gdrive';

/**
 * @deprecated Use `RCLONE_GDRIVE_REMOTE_NAME` directly, or — preferably —
 * read it from `getProviderBindings(provider).syncTarget` so the call site
 * doesn't have to know which provider it's talking to.
 */
export const RCLONE_REMOTE_NAME = RCLONE_GDRIVE_REMOTE_NAME;

const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

type AuthState = 'idle' | 'waiting' | 'completed' | 'failed';

interface AuthProgress {
  state: AuthState;
  authUrl: string | null;
  error: string | null;
}

interface GoogleDriveStatus {
  connected: boolean;
  email?: string;
  configured: boolean;
}

const RCLONE_AUTH_PORT = 53682;

class GDriveAuthService {
  private authorizeProcess: ChildProcess | null = null;
  private authUrl: string | null = null;
  private authState: AuthState = 'idle';
  private authError: string | null = null;
  private authTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the rclone authorize flow.
   *
   * Spawns rclone authorize as a child process, captures the auth URL
   * from its output, and returns it. The UI opens this URL for the user.
   * When the user completes authorization, rclone outputs the token
   * and we write it to rclone.conf.
   */
  async startAuthorize(): Promise<{ authUrl: string }> {
    this.cancelAuthorize();

    this.authState = 'waiting';
    this.authUrl = null;
    this.authError = null;

    return new Promise<{ authUrl: string }>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let urlResolved = false;
      let tokenCaptured = false;

      const proc = spawn(
        config.rcloneBinaryPath,
        ['authorize', 'drive', '--drive-scope', 'drive.file', '--auth-no-open-browser'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      this.authorizeProcess = proc;

      this.authTimeout = setTimeout(() => {
        if (!tokenCaptured) {
          logger.warn('rclone authorize timed out after 5 minutes');
          this.authState = 'failed';
          this.authError = 'Authorization timed out. Please try again.';
          proc.kill();
          this.authorizeProcess = null;
          if (!urlResolved) {
            reject(new Error('Authorization timed out'));
          }
        }
      }, AUTH_TIMEOUT_MS);

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;

        // rclone prints the auth URL as a NOTICE to stderr
        // Format: "NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=..."
        const urlMatch = text.match(/go to the following link:\s*(http\S+)/);
        if (urlMatch?.[1] && !urlResolved) {
          const rcloneUrl = urlMatch[1];
          urlResolved = true;
          logger.info({ rcloneUrl }, 'rclone authorize URL captured');

          // Fetch the rclone URL server-side to extract Google's OAuth URL.
          // rclone responds with a 302 redirect to accounts.google.com.
          // By returning the Google URL directly, the browser can open it
          // regardless of whether 127.0.0.1:53682 is reachable (remote access).
          this.extractGoogleAuthUrl(rcloneUrl).then(
            (googleUrl) => {
              this.authUrl = googleUrl;
              resolve({ authUrl: googleUrl });
            },
            (err) => {
              // Fallback: return the rclone URL if extraction fails
              logger.warn({ error: err }, 'Failed to extract Google URL, using rclone URL');
              this.authUrl = rcloneUrl;
              resolve({ authUrl: rcloneUrl });
            }
          );
        }
      });

      proc.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();

        // rclone outputs the token between ---> and <--- markers
        const tokenMatch = stdoutBuffer.match(
          /Paste the following into your remote machine --->\s*(\{[\s\S]*?\})\s*<---End paste/
        );
        if (tokenMatch?.[1] && !tokenCaptured) {
          tokenCaptured = true;
          const tokenJson = tokenMatch[1].trim();
          logger.info('rclone authorize token captured');

          this.handleTokenCaptured(tokenJson).catch((err) => {
            logger.error({ error: err }, 'Failed to process rclone token');
            this.authState = 'failed';
            this.authError = err instanceof Error ? err.message : 'Failed to save token';
          });
        }
      });

      proc.on('close', (code) => {
        // Ignore close events from a stale process (a new auth attempt replaced us)
        if (this.authorizeProcess !== proc) return;

        if (this.authTimeout) {
          clearTimeout(this.authTimeout);
          this.authTimeout = null;
        }
        this.authorizeProcess = null;

        if (!tokenCaptured && this.authState === 'waiting') {
          // rclone exited without producing a token
          this.authState = 'failed';
          this.authError = `rclone authorize exited with code ${code}`;
          logger.error(
            { code, stderr: stderrBuffer.slice(-500) },
            'rclone authorize exited without token'
          );
        }

        if (!urlResolved) {
          reject(new Error(stderrBuffer || `rclone authorize exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        // Ignore errors from a stale process (a new auth attempt replaced us)
        if (this.authorizeProcess !== proc) return;

        if (this.authTimeout) {
          clearTimeout(this.authTimeout);
          this.authTimeout = null;
        }
        this.authorizeProcess = null;
        this.authState = 'failed';
        this.authError = err.message;
        logger.error({ error: err }, 'rclone authorize process error');

        if (!urlResolved) {
          reject(err);
        }
      });
    });
  }

  /**
   * Get the current authorization state. UI polls this to know when auth is complete.
   */
  getAuthState(): AuthProgress {
    return {
      state: this.authState,
      authUrl: this.authUrl,
      error: this.authError,
    };
  }

  cancelAuthorize(): void {
    if (this.authorizeProcess) {
      this.authorizeProcess.kill();
      this.authorizeProcess = null;
    }
    if (this.authTimeout) {
      clearTimeout(this.authTimeout);
      this.authTimeout = null;
    }
    this.authState = 'idle';
    this.authUrl = null;
    this.authError = null;
  }

  /**
   * Check if Google Drive is connected (rclone.conf exists with valid token)
   */
  async getStatus(): Promise<GoogleDriveStatus> {
    const configPath = config.rcloneConfigPath;

    if (!existsSync(configPath)) {
      return { connected: false, configured: true };
    }

    try {
      const configContent = await readFile(configPath, 'utf-8');
      if (!configContent.includes(`[${RCLONE_GDRIVE_REMOTE_NAME}]`)) {
        return { connected: false, configured: true };
      }

      // Try to get user email from token
      const token = this.extractTokenFromConfig(configContent);
      if (token?.access_token) {
        try {
          const email = await this.getUserEmail(token.access_token);
          return { connected: true, email, configured: true };
        } catch {
          // Token might be expired, but rclone will refresh it
          return { connected: true, configured: true };
        }
      }

      return { connected: true, configured: true };
    } catch {
      return { connected: false, configured: true };
    }
  }

  async disconnect(): Promise<void> {
    this.cancelAuthorize();

    const configPath = config.rcloneConfigPath;
    if (existsSync(configPath)) {
      await unlink(configPath);
      logger.info('Google Drive disconnected, rclone config removed');
    }
  }

  /**
   * Check if Google Drive authorization is available.
   * Always returns true — rclone has built-in OAuth credentials.
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Forward a Google OAuth callback URL to rclone.
   *
   * When users access SignalK remotely, Google's redirect to
   * http://127.0.0.1:53682/?code=...&state=... fails because the browser
   * is on a different machine. The user can paste that failed URL, and
   * Keeper forwards it server-side to rclone (which IS listening on
   * localhost:53682 inside the container).
   */
  async forwardCallback(callbackUrl: string): Promise<void> {
    if (this.authState !== 'waiting') {
      throw new Error('No authorization in progress');
    }

    const parsed = new URL(callbackUrl);
    const localUrl = `http://127.0.0.1:${RCLONE_AUTH_PORT}${parsed.pathname}${parsed.search}`;

    logger.info('Forwarding OAuth callback to rclone');
    const response = await fetch(localUrl);

    if (!response.ok) {
      throw new Error(`rclone callback returned ${response.status}`);
    }
    // rclone will now output the token to stdout, which our existing
    // stdout handler will capture and call handleTokenCaptured()
  }

  /**
   * Fetch the rclone auth URL server-side and extract Google's OAuth URL.
   * rclone responds with a 302 redirect to accounts.google.com.
   */
  private async extractGoogleAuthUrl(rcloneUrl: string): Promise<string> {
    const response = await fetch(rcloneUrl, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('rclone did not redirect to Google OAuth');
    }
    logger.info('Extracted Google OAuth URL from rclone redirect');
    return location;
  }

  /**
   * Process the token JSON from rclone authorize output.
   * Writes rclone.conf and fetches user email.
   */
  private async handleTokenCaptured(tokenJson: string): Promise<void> {
    try {
      // Validate the token JSON
      const token = JSON.parse(tokenJson) as {
        access_token: string;
        token_type: string;
        refresh_token: string;
        expiry: string;
      };

      if (!token.access_token || !token.refresh_token) {
        throw new Error('Invalid token: missing access_token or refresh_token');
      }

      // Write rclone config (no client_id/client_secret — rclone uses its built-in ones)
      await this.writeRcloneConfig(tokenJson);

      this.authState = 'completed';
      this.authError = null;
      logger.info('Google Drive connected successfully via rclone authorize');
    } catch (err) {
      this.authState = 'failed';
      this.authError = err instanceof Error ? err.message : 'Failed to process token';
      throw err;
    }
  }

  /**
   * Write rclone config file with Google Drive remote.
   * Uses rclone's built-in OAuth credentials (no client_id/client_secret needed).
   */
  private async writeRcloneConfig(tokenJson: string): Promise<void> {
    const iniContent = [
      `[${RCLONE_GDRIVE_REMOTE_NAME}]`,
      'type = drive',
      'scope = drive.file',
      `token = ${tokenJson}`,
      '',
    ].join('\n');

    await writeFile(config.rcloneConfigPath, iniContent, 'utf-8');
    await chmod(config.rcloneConfigPath, 0o600);

    logger.debug('rclone config written');
  }

  private extractTokenFromConfig(
    configContent: string
  ): { access_token: string; refresh_token?: string } | null {
    const tokenMatch = configContent.match(/^token\s*=\s*(.+)$/m);
    if (!tokenMatch?.[1]) return null;

    try {
      return JSON.parse(tokenMatch[1]) as { access_token: string; refresh_token?: string };
    } catch {
      return null;
    }
  }

  private async getUserEmail(accessToken: string): Promise<string> {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.status}`);
    }

    const data = (await response.json()) as { email: string };
    return data.email;
  }
}

export const gdriveAuthService = new GDriveAuthService();
