import { z } from 'zod';

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
 * D1 table info in manifest
 */
export const D1TableInfoSchema = z.object({
  /** Table name */
  name: z.string(),
  /** Number of rows in backup */
  rows: z.number(),
});

export type D1TableInfo = z.infer<typeof D1TableInfoSchema>;

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
  /** D1 backup summary */
  d1: z.object({
    /** Total rows across all tables */
    totalRows: z.number(),
    /** Per-table row counts */
    tables: z.array(D1TableInfoSchema),
  }),
});

export type ManifestSummary = z.infer<typeof ManifestSummarySchema>;

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

/**
 * Configuration for health check thresholds
 */
export interface HealthCheckConfig {
  /** Hours before backup is considered warning (default: 25) */
  warningAgeHours: number;
  /** Hours before backup is considered critical (default: 26) */
  criticalAgeHours: number;
  /** Minimum expected route count (default: 100) */
  minExpectedRoutes: number;
  /** Maximum allowed route count drop ratio (default: 0.5 = 50%) */
  routeDropThreshold: number;
}

/**
 * Default health check configuration
 */
export const DEFAULT_HEALTH_CONFIG: HealthCheckConfig = {
  warningAgeHours: 25,
  criticalAgeHours: 26,
  minExpectedRoutes: 100,
  routeDropThreshold: 0.5,
};
