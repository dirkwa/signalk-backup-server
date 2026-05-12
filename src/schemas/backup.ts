/**
 * Backup API Schemas
 *
 * TypeBox schemas for validating Backup API requests.
 */

import { Type, type Static } from '@sinclair/typebox';

/** Valid backup types */
const BackupType = Type.Union([
  Type.Literal('hourly'),
  Type.Literal('daily'),
  Type.Literal('weekly'),
  Type.Literal('startup'),
  Type.Literal('manual'),
  Type.Literal('pre-update'),
  Type.Literal('pre-restore'),
]);

/**
 * Schema for POST /api/backups (create backup)
 */
export const createBackupSchema = Type.Object(
  {
    /** Optional description for the backup */
    description: Type.Optional(
      Type.String({
        maxLength: 200,
        description: 'Human-readable description for the backup',
        examples: ['Before major config change'],
      })
    ),
    /** Backup type (defaults to 'manual') */
    type: Type.Optional(BackupType),
    /** Include plugins in backup */
    includePlugins: Type.Optional(
      Type.Boolean({
        description: 'Include installed plugins in backup',
      })
    ),
    /** Include plugin data directories */
    includePluginData: Type.Optional(
      Type.Boolean({
        description: 'Include plugin data directories in backup',
      })
    ),
    /** Include history data (InfluxDB + Grafana) */
    includeHistory: Type.Optional(
      Type.Boolean({
        description: 'Include history data (InfluxDB + Grafana) in backup',
      })
    ),
  },
  {
    $id: 'CreateBackupRequest',
    description: 'Request body for creating a new backup',
  }
);

/**
 * Schema for route params with backup ID
 * Used by: GET/DELETE /api/backups/:id, POST /api/backups/:id/restore, etc.
 */
export const backupIdParamSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      description: 'Unique backup identifier',
      examples: ['backup-2024-01-15-143022'],
    }),
  },
  {
    $id: 'BackupIdParam',
    description: 'Path parameter for backup ID',
  }
);

/**
 * Schema for POST /api/backups/upload query params
 */
export const uploadQuerySchema = Type.Object(
  {
    restoreImmediately: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')], {
        description: 'Restore the backup immediately after upload',
        examples: ['false'],
      })
    ),
  },
  {
    $id: 'UploadQuery',
    description: 'Query parameters for backup upload',
  }
);

/**
 * Schema for GET /api/backups/estimate query params
 */
export const estimateQuerySchema = Type.Object(
  {
    includePlugins: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')], {
        description: 'Include plugins in size estimate',
        examples: ['true'],
      })
    ),
    includePluginData: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')], {
        description: 'Include plugin data in size estimate',
        examples: ['false'],
      })
    ),
    includeHistory: Type.Optional(
      Type.Union([Type.Literal('true'), Type.Literal('false')], {
        description: 'Include history data in size estimate',
        examples: ['false'],
      })
    ),
  },
  {
    $id: 'EstimateQuery',
    description: 'Query parameters for backup size estimate',
  }
);

/**
 * Schema for PUT /api/backups/password (change backup password)
 * Requires password + confirmation to prevent typos.
 */
export const changePasswordSchema = Type.Object(
  {
    /** New backup password */
    password: Type.String({
      minLength: 8,
      maxLength: 128,
      description: 'New backup password (minimum 8 characters)',
    }),
    /** Password confirmation (must match password) */
    confirmPassword: Type.String({
      minLength: 8,
      maxLength: 128,
      description: 'Password confirmation (must match password)',
    }),
  },
  {
    $id: 'ChangePasswordRequest',
    description: 'Request body for changing the backup password',
  }
);

/**
 * Schema for PUT /api/backups/retention.
 *
 * Each tier is optional so the UI can do partial updates (e.g. just
 * change `daily` without re-sending the others). Sane bounds: at least
 * 1 per tier (0 would auto-delete every backup of that type immediately
 * — keep at least one for emergency rollback). Upper bound 365 to stop
 * accidental keep-forever typos.
 */
const retentionCount = Type.Integer({ minimum: 1, maximum: 365 });
export const retentionSchema = Type.Object(
  {
    hourly: Type.Optional(retentionCount),
    daily: Type.Optional(retentionCount),
    weekly: Type.Optional(retentionCount),
    startup: Type.Optional(retentionCount),
  },
  {
    $id: 'RetentionRequest',
    description:
      'How many of each tier to keep. Manual backups are intentionally not in here — they are never auto-pruned.',
    additionalProperties: false,
  }
);

/** Inferred types for use in route handlers */
export type CreateBackupInput = Static<typeof createBackupSchema>;
export type BackupIdParam = Static<typeof backupIdParamSchema>;
export type UploadQuery = Static<typeof uploadQuerySchema>;
export type EstimateQuery = Static<typeof estimateQuerySchema>;
export type ChangePasswordInput = Static<typeof changePasswordSchema>;
export type RetentionInput = Static<typeof retentionSchema>;
