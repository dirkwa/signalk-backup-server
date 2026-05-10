/**
 * Shared logger instance for Keeper services
 */

import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true },
        }
      : undefined,
});
