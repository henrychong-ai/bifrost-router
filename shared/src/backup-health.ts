import { z } from 'zod';

/**
 * The backup health answer (`GET /api/backups/health`), defined once
 * (v1.38.0): the Worker builds it (`src/backup/health.ts`) and the dashboard
 * validates it (`admin/src/lib/api-client.ts`) with these same schemas, so
 * the two can no longer drift apart.
 */

/**
 * Status of a single backup file
 */
export const BackupFileStatusSchema = z.object({
  /** R2 object key */
  key: z.string(),
  /** File size in bytes */
  size: z.number(),
  /** Whether the file exists */
  exists: z.boolean(),
});

export type BackupFileStatus = z.infer<typeof BackupFileStatusSchema>;

/**
 * Health status levels
 */
export const HealthStatusSchema = z.enum(['healthy', 'warning', 'critical']);

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * Backup age status
 */
export const BackupAgeStatusSchema = z.enum(['ok', 'warning', 'critical']);

export type BackupAgeStatus = z.infer<typeof BackupAgeStatusSchema>;

/**
 * Issue severity
 */
export const IssueSeveritySchema = z.enum(['warning', 'critical']);

export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

/**
 * Health check issue
 */
export const HealthIssueSchema = z.object({
  /** Issue severity */
  severity: IssueSeveritySchema,
  /** Human-readable issue description */
  message: z.string(),
});

export type HealthIssue = z.infer<typeof HealthIssueSchema>;

/**
 * Manifest summary for health response
 */
export const ManifestSummarySchema = z.object({
  /** Manifest schema version */
  version: z.string(),
  /** KV backup summary */
  kv: z.object({
    /** Total routes backed up */
    totalRoutes: z.number(),
    /** Domains included in backup */
    domains: z.array(z.string()),
  }),
});

export type ManifestSummary = z.infer<typeof ManifestSummarySchema>;

/** The latest archive as verified. */
export const ArchiveInfoSchema = z.object({
  /** Records the archive holds (its own `routeCount`, or the manifest's for a legacy archive) */
  records: z.number(),
  /** Inflated NDJSON size in bytes */
  inflatedBytes: z.number(),
});

export type ArchiveInfo = z.infer<typeof ArchiveInfoSchema>;

/**
 * Last backup information
 */
export const LastBackupInfoSchema = z.object({
  /** Backup date in YYYYMMDD format */
  date: z.string(),
  /** Backup timestamp in ISO format */
  timestamp: z.string(),
  /** Hours since backup was created */
  ageHours: z.number(),
  /** Manifest summary (null if manifest couldn't be parsed) */
  manifest: ManifestSummarySchema.nullable(),
  /** Status of individual backup files */
  files: z.array(BackupFileStatusSchema),
  /**
   * The archive as read back and verified; null when it was not verified or
   * verification failed. Always sent (the dashboard's earlier copy also
   * accepted it absent; there is one definition now).
   */
  archive: ArchiveInfoSchema.nullable(),
});

export type LastBackupInfo = z.infer<typeof LastBackupInfoSchema>;

/**
 * Health check results
 */
export const HealthChecksSchema = z.object({
  /** Whether any backup exists */
  backupExists: z.boolean(),
  /** Backup age status */
  backupAge: BackupAgeStatusSchema,
  /** Whether manifest is valid JSON */
  manifestValid: z.boolean(),
  /** Whether all expected files exist */
  filesComplete: z.boolean(),
  /** Whether route count is within expected range */
  routeCountOk: z.boolean(),
});

export type HealthChecks = z.infer<typeof HealthChecksSchema>;

/**
 * Complete backup health response
 */
export const BackupHealthResponseSchema = z.object({
  /** Overall health status */
  status: HealthStatusSchema,
  /** Timestamp of this health check */
  timestamp: z.string(),
  /** Information about the latest backup (null if none found) */
  lastBackup: LastBackupInfoSchema.nullable(),
  /** List of issues found */
  issues: z.array(HealthIssueSchema),
  /** Individual check results */
  checks: HealthChecksSchema,
});

export type BackupHealthResponse = z.infer<typeof BackupHealthResponseSchema>;
