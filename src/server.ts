/**
 * signalk-backup-server — Express entry point
 *
 * The container is launched and managed by the signalk-backup plugin via
 * signalk-container's `ensureRunning()`. The plugin sets DATA_DIR (where
 * settings.json + kopia repo live), SIGNALK_DATA_PATH (where ~/.signalk is
 * mounted), and SIGNALK_VERSION (used to tag backups).
 *
 * Headless: no UI is served from this process. The user-facing UI lives in
 * the signalk-backup plugin's webapp (mounted by SignalK at /signalk-backup/),
 * which reaches us via the plugin's reverse-proxy at /plugins/signalk-backup/api/.
 *
 * Network: bound to all interfaces inside the container, but the plugin's
 * `signalkAccessiblePorts` config limits the host-side binding to 127.0.0.1.
 * CORS is restricted to loopback only — no browser ever talks to us directly.
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { mkdir } from 'fs/promises';
import { createRequire } from 'module';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import { config } from './config/index.js';
import { logger } from './services/logger.js';

import { healthRouter } from './api/health-routes.js';
import { backupRouter } from './api/backup-routes.js';
import { cloudRouter } from './api/cloud-routes.js';
import { settingsRouter } from './api/settings-routes.js';
import { operationRouter } from './api/operation-routes.js';

import { backupScheduler } from './services/backup-scheduler.js';
import { cloudSyncService } from './services/cloud-sync-service.js';
import { settingsService } from './services/settings-service.js';

import { setRoutePrefixByTag, generateOpenApiDocument } from './api/openapi-registry.js';
import { asyncApiDocument } from './api/asyncapi.js';

const require = createRequire(import.meta.url);
const pinoHttp = require('pino-http') as (opts?: {
  logger?: unknown;
  autoLogging?: boolean | { ignore?: (req: { url?: string }) => boolean };
}) => (req: unknown, res: unknown, next?: () => void) => void;

// __filename / __dirname are not defined in ESM. Resolve them from
// import.meta.url for any future use (currently nothing in this file
// needs them, but exposing them is cheap and unsurprising).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __filename;
void __dirname;

const app = express();

// Loopback-only CORS. The plugin reaches us via host loopback (127.0.0.1)
// after signalk-container publishes the port; nothing else should ever talk
// to this process directly. External-mode users (curl/CLI) don't need
// CORS at all — they don't run in a browser. Tightening from the older
// loopback+RFC1918+sk-* allowlist closes a class of misconfigurations
// where a user accidentally exposed the port to their LAN.
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  })
);

app.use('/api/health', healthRouter);
app.use('/api/backups', backupRouter);
app.use('/api/cloud', cloudRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/operations', operationRouter);

setRoutePrefixByTag('Health', '/api/health');
setRoutePrefixByTag('Backups', '/api/backups');
setRoutePrefixByTag('Cloud', '/api/cloud');
setRoutePrefixByTag('Settings', '/api/settings');
setRoutePrefixByTag('Operations', '/api/operations');

// OpenAPI / AsyncAPI surface — kept for direct API consumers (curl,
// Postman, third-party scripts). The plugin doesn't use Swagger UI.
const openApiDocument = generateOpenApiDocument();
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});
app.get('/api/asyncapi.json', (_req, res) => {
  res.json(asyncApiDocument);
});

const server = createServer(app);

// Bind IPv4 explicitly. Node's default with no host argument is `::`
// (IPv6 wildcard), which on rootless-podman + pasta topologies leaves
// /proc/net/tcp empty and only /proc/net/tcp6 listening. The Dockerfile
// healthcheck then times out because undici fetch hangs trying ::1 first
// inside the container namespace. Pasta only bridges IPv4 host-side
// (127.0.0.1:3010->3010/tcp), so IPv4 is the only family any consumer
// reaches us on anyway.
server.listen(config.port, '0.0.0.0', async () => {
  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      signalkDataPath: config.signalkDataPath,
      signalkVersion: config.signalkVersion,
    },
    'signalk-backup-server listening (headless)'
  );

  try {
    await mkdir(config.dataDir, { recursive: true });
  } catch (err) {
    logger.error({ err }, 'Failed to ensure dataDir');
  }

  // Restore the persisted scheduler state. backupsEnabled defaults to
  // true on a fresh install (DEFAULT_SETTINGS in settings-service);
  // explicit-disable is preserved across restarts. cloudSyncService
  // reads its own schedule mode from settings.cloudSync.
  try {
    const settings = await settingsService.get();
    if (settings.backupsEnabled !== false) {
      await backupScheduler.start();
      try {
        await backupScheduler.triggerStartup();
      } catch (err) {
        logger.error({ err }, 'Failed to trigger startup backup');
      }
    } else {
      logger.info('Backup scheduler not started — backupsEnabled=false in settings');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to restore backup scheduler state on startup');
  }

  // Cloud sync schedule is independent — a failure to read settings or
  // start its interval shouldn't suppress the backup scheduler error
  // above (or vice versa). Separate try/catch so each failure is
  // logged distinctly.
  try {
    await cloudSyncService.startSchedule();
  } catch (err) {
    logger.error({ err }, 'Failed to start cloud sync schedule on startup');
  }
});

const shutdown = (): void => {
  logger.info('Shutting down...');
  backupScheduler.stop();
  cloudSyncService.stopSchedule();

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server };
