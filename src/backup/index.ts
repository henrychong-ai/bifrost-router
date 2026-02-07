/**
 * Bifrost Backup System
 *
 * Automated daily backups of KV routes and D1 analytics to R2.
 * Triggered by Cloudflare Workers cron at 8 PM UTC (4 AM SGT).
 *
 * Backup structure:
 *   daily/YYYYMMDD/
 *     manifest.json      - Backup metadata and file listing
 *     kv-routes.ndjson.gz - All KV routes (compressed NDJSON)
 *     d1-{table}.ndjson.gz - D1 table data (compressed NDJSON)
 *
 * Retention policy:
 *   - Daily backups: 30 days
 *   - Weekly (Sunday) backups: 90 days
 */

export { handleScheduled } from './scheduled';
export { backupKV } from './kv';
export { backupD1 } from './d1';
export { writeManifest } from './manifest';
export { cleanupOldBackups } from './retention';
export { gzipCompress } from './compress';
export { checkBackupHealth } from './health';
export { sendBackupAlert } from './notifications';
export type {
  BackupManifest,
  BackupResult,
  KVBackupResult,
  D1BackupResult,
  CleanupResult,
} from './types';
export type {
  BackupHealthResponse,
  BackupFileStatus,
  HealthStatus,
  BackupAgeStatus,
  HealthIssue,
  ManifestSummary,
  HealthCheckConfig,
  HealthChecks,
  LastBackupInfo,
} from './health-schemas';
export { DEFAULT_HEALTH_CONFIG } from './health-schemas';
