/**
 * Install Identity Service
 *
 * Manages the identity of this SignalK installation for cloud backup purposes.
 * Each installation gets a unique folder name on Google Drive based on:
 * - Vessel name (from SignalK settings.json)
 * - Hardware model (from /proc/device-tree/model or OS info)
 * - A short hex ID derived from the server UUID
 *
 * Identity is stored in the existing KeeperSettings and computed on first
 * cloud backup configuration.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { hostname } from 'os';

import { config } from '../config/index.js';
import { settingsService, type KeeperSettings } from './settings-service.js';
import { logger } from './logger.js';

export interface InstallIdentity {
  /** Human-readable installation name (e.g., "SV-Wanderlust-RPi4") */
  installName: string;
  /** 4-char hex ID derived from server UUID */
  installId: string;
  /** SignalK server UUID */
  serverUUID: string;
  /** Cloud backup folder name: "{installName}-{installId}" */
  folderId: string;
  /** Vessel name from SignalK settings */
  vesselName: string;
  /** Hardware description (e.g., "Raspberry Pi 4 Model B") */
  hardware: string;
}

/**
 * Read the SignalK server UUID from settings.json or defaults.json
 */
async function readServerUUID(): Promise<string> {
  const settingsPath = join(config.signalkDataPath, 'settings.json');
  const defaultsPath = join(config.signalkDataPath, 'defaults.json');

  for (const filePath of [settingsPath, defaultsPath]) {
    try {
      if (!existsSync(filePath)) continue;
      const data = JSON.parse(await readFile(filePath, 'utf-8'));
      // SignalK stores UUID at vessel.uuid or as top-level uuid
      const uuid = data?.vessel?.uuid ?? data?.uuid;
      if (uuid && typeof uuid === 'string') {
        return uuid;
      }
    } catch {
      // Continue to next file
    }
  }

  // Fallback: generate a stable ID from hostname
  return `urn:mrn:signalk:uuid:${createHash('sha256').update(hostname()).digest('hex').slice(0, 32)}`;
}

/**
 * Read the vessel name from SignalK configuration.
 * Checks baseDeltas.json first (where the admin UI stores it),
 * then falls back to settings.json / defaults.json.
 */
async function readVesselName(): Promise<string> {
  // Primary: baseDeltas.json — the admin UI stores vessel name here
  const baseDeltasPath = join(config.signalkDataPath, 'baseDeltas.json');
  try {
    if (existsSync(baseDeltasPath)) {
      const deltas = JSON.parse(await readFile(baseDeltasPath, 'utf-8'));
      if (Array.isArray(deltas)) {
        for (const delta of deltas) {
          if (delta?.context === 'vessels.self' && Array.isArray(delta?.updates)) {
            for (const update of delta.updates) {
              if (Array.isArray(update?.values)) {
                for (const kp of update.values) {
                  // Simple path: { path: "", value: { name: "My Vessel" } }
                  if (kp.path === '' && kp.value?.name && typeof kp.value.name === 'string') {
                    return kp.value.name;
                  }
                  // Dotted path: { path: "name", value: "My Vessel" }
                  if (kp.path === 'name' && typeof kp.value === 'string') {
                    return kp.value;
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Continue to fallback
  }

  // Fallback: settings.json / defaults.json
  const settingsPath = join(config.signalkDataPath, 'settings.json');
  const defaultsPath = join(config.signalkDataPath, 'defaults.json');

  for (const filePath of [settingsPath, defaultsPath]) {
    try {
      if (!existsSync(filePath)) continue;
      const data = JSON.parse(await readFile(filePath, 'utf-8'));
      const name = data?.vessel?.name;
      if (name && typeof name === 'string') {
        return name;
      }
    } catch {
      // Continue to next file
    }
  }

  return hostname();
}

/**
 * Detect hardware model
 */
async function detectHardware(): Promise<string> {
  // Linux: Raspberry Pi and other ARM SBCs expose model in device tree
  if (process.platform === 'linux') {
    try {
      const model = (await readFile('/proc/device-tree/model', 'utf-8')).replace(/\0/g, '').trim();
      if (model) return model;
    } catch {
      // Not an ARM device or no device tree
    }

    // Try DMI product name (x86 systems)
    try {
      const product = (await readFile('/sys/class/dmi/id/product_name', 'utf-8')).trim();
      if (product && product !== 'System Product Name') return product;
    } catch {
      // No DMI info
    }
  }

  // Fallback: platform + arch
  return `${process.platform}-${process.arch}`;
}

/**
 * Generate a 4-char hex ID from a server UUID
 */
function shortIdFromUUID(uuid: string): string {
  return createHash('sha256').update(uuid).digest('hex').slice(0, 4);
}

/**
 * Sanitize a string for use in a folder name
 * Replaces spaces and special chars with hyphens, removes consecutive hyphens
 */
function sanitizeForFolder(name: string): string {
  return name
    .replace(/[^\w\s-]/g, '') // Remove special chars except word chars, spaces, hyphens
    .replace(/\s+/g, '-') // Spaces → hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
    .slice(0, 50); // Limit length
}

/**
 * Shorten hardware model for folder name
 * e.g., "Raspberry Pi 4 Model B Rev 1.5" → "RPi4"
 */
function shortenHardware(hardware: string): string {
  // Raspberry Pi
  const rpiMatch = hardware.match(/Raspberry Pi (\d+)/i);
  if (rpiMatch) return `RPi${rpiMatch[1]}`;

  // Generic: take first word + architecture
  if (hardware.includes('linux')) return 'Linux';
  if (hardware.includes('darwin')) return 'Mac';
  if (hardware.includes('win32')) return 'Win';

  return hardware.split(/[\s-]/)[0]?.slice(0, 10) ?? 'Unknown';
}

class InstallIdentityService {
  /**
   * Get or create the installation identity.
   * If identity is already stored in settings, returns it.
   * Otherwise computes it from SignalK data and hardware info.
   */
  async getOrCreateIdentity(): Promise<InstallIdentity> {
    const settings = await settingsService.get();

    if (settings.identity) {
      return settings.identity;
    }

    return this.createIdentity();
  }

  /**
   * Create a new identity from current system state and persist it
   */
  async createIdentity(): Promise<InstallIdentity> {
    const [serverUUID, vesselName, hardware] = await Promise.all([
      readServerUUID(),
      readVesselName(),
      detectHardware(),
    ]);

    const installId = shortIdFromUUID(serverUUID);
    const shortHw = shortenHardware(hardware);
    const installName = sanitizeForFolder(`${vesselName}-${shortHw}`);
    const folderId = `${installName}-${installId}`;

    const identity: InstallIdentity = {
      installName,
      installId,
      serverUUID,
      folderId,
      vesselName,
      hardware,
    };

    await settingsService.update({ identity } as Partial<KeeperSettings>);
    logger.info({ identity }, 'Installation identity created');

    return identity;
  }

  /**
   * Get just the folder ID (for cloud sync paths)
   */
  async getFolderId(): Promise<string> {
    const identity = await this.getOrCreateIdentity();
    return identity.folderId;
  }

  /**
   * Get the install-info.json content that gets written alongside cloud backups
   * for human identification of what this backup folder belongs to.
   * Refreshes vesselName/hardware from current system state so the info
   * stays accurate even if the user renames the vessel after initial setup.
   */
  async getInstallInfo(): Promise<Record<string, unknown>> {
    const identity = await this.refreshIdentityMetadata();
    return {
      installName: identity.installName,
      installId: identity.installId,
      vesselName: identity.vesselName,
      hardware: identity.hardware,
      serverUUID: identity.serverUUID,
      platform: process.platform,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Refresh display-only fields (vesselName, hardware) from current system state.
   * The folderId is NOT changed — it's the stable sync target on Google Drive.
   */
  async refreshIdentityMetadata(): Promise<InstallIdentity> {
    const identity = await this.getOrCreateIdentity();

    const [vesselName, hardware] = await Promise.all([readVesselName(), detectHardware()]);

    if (vesselName !== identity.vesselName || hardware !== identity.hardware) {
      identity.vesselName = vesselName;
      identity.hardware = hardware;
      await settingsService.update({ identity } as Partial<KeeperSettings>);
      logger.info({ vesselName, hardware }, 'Identity metadata refreshed');
    }

    return identity;
  }

  /**
   * Reset identity (e.g., after a clone restore that generates a new UUID)
   */
  async resetIdentity(): Promise<InstallIdentity> {
    const settings = await settingsService.get();
    delete settings.identity;
    await settingsService.update(settings);
    return this.createIdentity();
  }

  /**
   * Clone identity: reset identity + clear security tokens.
   * Used after a cloud restore in "clone" mode so the new device
   * has its own identity and doesn't conflict with the source device.
   */
  async cloneIdentity(): Promise<InstallIdentity> {
    const newIdentity = await this.resetIdentity();
    await this.clearSecurityTokens();
    logger.info({ newIdentity }, 'Clone identity created');
    return newIdentity;
  }

  /**
   * Clear device-specific security tokens from SignalK settings.
   * After a clone restore, tokens from the source device should not persist.
   */
  private async clearSecurityTokens(): Promise<void> {
    const securityPath = join(config.signalkDataPath, 'security.json');
    try {
      if (!existsSync(securityPath)) return;

      const data = JSON.parse(await readFile(securityPath, 'utf-8'));
      delete data.secretKey;
      await writeFile(securityPath, JSON.stringify(data, null, 2), 'utf-8');
      logger.info('Security tokens cleared for clone');
    } catch (error) {
      logger.warn({ error }, 'Failed to clear security tokens (non-fatal)');
    }
  }
}

export const installIdentityService = new InstallIdentityService();
