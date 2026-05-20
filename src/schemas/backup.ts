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

// Min 1 keeps at least one of each tier for emergency rollback; max 365
// stops accidental keep-forever typos. Tiers optional so the UI can
// PUT a partial body without re-sending unchanged values.
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

/** Path inside a snapshot, relative to its root. Empty string = snapshot
 *  root. We let the path string itself be loose here — deeper validation
 *  (".." segments, NUL bytes, reject-list) lives in the wrapper layer so
 *  the same checks apply to non-HTTP callers. */
const snapshotPath = Type.String({
  maxLength: 4096,
  description: 'Path inside the snapshot, relative to its root. Empty = root.',
});

/**
 * Query schema for GET /api/backups/:id/tree and /:id/download-subtree.
 * `path` defaults to '' (snapshot root) when omitted.
 */
export const snapshotPathQuerySchema = Type.Object(
  {
    path: Type.Optional(snapshotPath),
  },
  {
    $id: 'SnapshotPathQuery',
    description: 'Path inside a snapshot, relative to its root.',
  }
);

/**
 * Schema for POST /api/backups/:id/restore-partial.
 */
export const partialRestoreSchema = Type.Object(
  {
    sourcePath: snapshotPath,
    targetMode: Type.Union([Type.Literal('original'), Type.Literal('custom')], {
      description:
        'original = signalkDataPath/<sourcePath>; custom = customPath under signalkDataPath.',
    }),
    customPath: Type.Optional(
      Type.String({
        maxLength: 4096,
        description: 'Required when targetMode is "custom". Must resolve under signalkDataPath.',
      })
    ),
    confirmOverwrite: Type.Optional(
      Type.Boolean({
        description:
          'Set to true to overwrite an existing target. Without it, the server returns 409 + existing-entry metadata so the UI can show a confirmation diff.',
      })
    ),
  },
  {
    $id: 'PartialRestoreRequest',
    description: 'Restore a single file or directory from a snapshot.',
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
export type SnapshotPathQuery = Static<typeof snapshotPathQuerySchema>;
export type PartialRestoreInput = Static<typeof partialRestoreSchema>;
