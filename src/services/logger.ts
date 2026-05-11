/**
 * Shared logger instance for Keeper services
 */

import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  // Mask the kopia repository password anywhere it appears in a logged
  // object. Belt-and-braces: the password used to be logged whole-
  // settings-object at info-level; even though we've removed those call
  // sites' explicit settings dumps, declaring it here means any future
  // log line that accidentally serialises the settings can't leak it.
  redact: {
    paths: [
      'backupPassword',
      'settings.backupPassword',
      '*.backupPassword',
      'password',
      'confirmPassword',
      '*.password',
      '*.confirmPassword',
    ],
    censor: '[Redacted]',
  },
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
