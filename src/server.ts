/**
 * signalk-backup-server — Express entry point
 *
 * The container is launched and managed by the signalk-backup plugin via
 * signalk-container's `ensureRunning()`. The plugin sets DATA_DIR (where
 * settings.json + kopia repo live), SIGNALK_DATA_PATH (where ~/.signalk is
 * mounted), GUI_PUBLIC_URL (used by /api/gui-url for the redirect HTML),
 * and SIGNALK_VERSION (used to tag backups).
 *
 * Network: bound to all interfaces, but only reachable via signalk-container's
 * loopback binding (or shared container network). No JWT — protection is at
 * the network layer.
 */

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
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
import { guiRouter } from './api/gui-routes.js';

import { backupScheduler } from './services/backup-scheduler.js';
import { cloudSyncService } from './services/cloud-sync-service.js';

import { setRoutePrefixByTag, generateOpenApiDocument } from './api/openapi-registry.js';
import { asyncApiDocument } from './api/asyncapi.js';

const require = createRequire(import.meta.url);
const pinoHttp = require('pino-http') as (opts?: {
  logger?: unknown;
  autoLogging?: boolean | { ignore?: (req: { url?: string }) => boolean };
}) => (req: unknown, res: unknown, next?: () => void) => void;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (
      !origin ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(origin) ||
      /^https?:\/\/sk-/i.test(origin)
    ) {
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
app.use('/api/gui-url', guiRouter);

setRoutePrefixByTag('Health', '/api/health');
setRoutePrefixByTag('Backups', '/api/backups');
setRoutePrefixByTag('Cloud', '/api/cloud');
setRoutePrefixByTag('Settings', '/api/settings');
setRoutePrefixByTag('Operations', '/api/operations');

const openApiDocument = generateOpenApiDocument();
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});
app.get('/api/asyncapi.json', (_req, res) => {
  res.json(asyncApiDocument);
});

const uiDist = path.resolve(__dirname, '../src/ui/dist');
if (existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(uiDist, 'index.html'));
  });
} else {
  logger.warn({ uiDist }, 'UI dist not found — GET / will 404 until UI is built');
}

const server = createServer(app);

server.listen(config.port, async () => {
  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      signalkDataPath: config.signalkDataPath,
      signalkVersion: config.signalkVersion,
    },
    'signalk-backup-server listening'
  );

  try {
    await mkdir(config.dataDir, { recursive: true });
  } catch (err) {
    logger.error({ err }, 'Failed to ensure dataDir');
  }

  try {
    if (backupScheduler.isEnabled()) {
      await backupScheduler.triggerStartup();
    }
  } catch (err) {
    logger.error({ err }, 'Failed to trigger startup backup');
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
