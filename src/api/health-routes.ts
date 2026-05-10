/**
 * Health check API routes
 *
 * keeper used podmanService here to check the SignalK container's status.
 * signalk-backup-server runs as a SignalK plugin and has no container
 * access — the only health signal we expose is "the backup-server itself
 * is up and responding". The plugin host already monitors SignalK directly.
 */

import { type Request, type Response } from 'express';
import { createRequire } from 'module';
import { createApiRouter } from './openapi-registry.js';
import type { ApiResponse } from '../types/index.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const api = createApiRouter('Health');

interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
}

/**
 * GET /api/health
 * signalk-backup-server health check
 */
api.get(
  '/',
  {
    summary: 'Health check',
    description: 'Simple health check endpoint for load balancers',
    responses: {
      200: {
        description: 'Service is healthy',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string', examples: ['ok'] },
                timestamp: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  },
  async (_req: Request, res: Response) => {
    const healthCheck: HealthCheck = {
      status: 'healthy',
      version: packageJson.version || '0.0.1',
      uptime: process.uptime(),
    };

    const response: ApiResponse<HealthCheck> = {
      success: true,
      data: healthCheck,
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }
);

export const healthRouter = api.router;
