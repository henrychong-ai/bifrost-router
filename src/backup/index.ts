/**
 * Bifrost Backup System
 *
 * Automated daily backups of KV routes to R2.
 * Triggered by Cloudflare Workers cron at 8 PM UTC (4 AM SGT).
 *
 * Backup structure:
 *   daily/YYYYMMDD/
 *     manifest.json      - Backup metadata and file listing
 *     kv-routes.ndjson.gz - All KV routes (compressed NDJSON)
 *
 * Retention: Indefinite (KV backups are ~8KB/day).
 *
 * D1 analytics are covered by Cloudflare D1 Time Travel (30-day PITR).
 */

export { handleScheduled } from './scheduled';
export { backupKV } from './kv';
export { writeManifest } from './manifest';
export { gzipCompress } from './compress';
export { checkBackupHealth } from './health';
export { sendBackupAlert } from './notifications';
export type { BackupManifest, BackupResult, KVBackupResult } from './types';
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
