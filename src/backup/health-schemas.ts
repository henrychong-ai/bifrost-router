/**
 * The backup health answer's schemas live in `@bifrost/shared`
 * (`backup-health.ts`, v1.38.0), shared with the dashboard; the Worker's
 * thresholds stay here.
 */
export {
  type ArchiveInfo,
  ArchiveInfoSchema,
  type BackupAgeStatus,
  BackupAgeStatusSchema,
  type BackupFileStatus,
  BackupFileStatusSchema,
  type BackupHealthResponse,
  BackupHealthResponseSchema,
  type HealthChecks,
  HealthChecksSchema,
  type HealthIssue,
  HealthIssueSchema,
  type HealthStatus,
  HealthStatusSchema,
  type IssueSeverity,
  IssueSeveritySchema,
  type LastBackupInfo,
  LastBackupInfoSchema,
  type ManifestSummary,
  ManifestSummarySchema,
} from '@bifrost/shared';

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
