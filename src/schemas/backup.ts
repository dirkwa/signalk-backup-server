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

// Loose here on purpose — deeper validation (".." segments, NUL bytes,
// reject-list) lives in restore-partial-service so the same checks apply
// to non-HTTP callers too.
const snapshotPath = Type.String({
  maxLength: 4096,
  description: 'Path inside the snapshot, relative to its root. Empty = root.',
});

export const snapshotPathQuerySchema = Type.Object(
  {
    path: Type.Optional(snapshotPath),
  },
  {
    $id: 'SnapshotPathQuery',
    description: 'Path inside a snapshot, relative to its root. Empty / omitted = root.',
  }
);

const customPathString = Type.String({
  maxLength: 4096,
  description: 'Required when targetMode is "custom". Must resolve under signalkDataPath.',
});

const confirmOverwriteFlag = Type.Optional(
  Type.Boolean({
    description:
      'Set to true to overwrite an existing target. Without it, the server returns 409 + existing-entry metadata so the UI can show a confirmation diff.',
  })
);

// Discriminated union — customPath is required when targetMode is
// 'custom' and rejected otherwise, so TypeBox catches the invariant at
// the API boundary rather than letting it fail later inside the service.
export const partialRestoreSchema = Type.Union(
  [
    Type.Object(
      {
        sourcePath: snapshotPath,
        targetMode: Type.Literal('original'),
        confirmOverwrite: confirmOverwriteFlag,
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        sourcePath: snapshotPath,
        targetMode: Type.Literal('custom'),
        customPath: customPathString,
        confirmOverwrite: confirmOverwriteFlag,
      },
      { additionalProperties: false }
    ),
  ],
  {
    $id: 'PartialRestoreRequest',
    description: 'Restore a single file or directory from a snapshot.',
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
