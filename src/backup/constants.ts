/**
 * Backup storage constants (v1.28.0) — single source for the backup bucket
 * name and the daily-backup key prefix. The R2 event-notification audit
 * consumer (src/queue/r2-events.ts) imports these to system-attribute the
 * backup cron's writes; a rename that only touched the backup module would
 * otherwise silently misattribute every nightly backup as
 * "External (unattributed)".
 */

/** Actual R2 bucket name the daily backup writes to (BACKUP_BUCKET binding) */
export const BACKUP_BUCKET_NAME = 'bifrost-backups';

/** Key prefix for daily backup artifacts: daily/{YYYYMMDD}/... */
export const BACKUP_DAILY_PREFIX = 'daily/';

/**
 * Manifest schema version (v2.0.0: KV-only backup; D1 is covered by Cloudflare
 * Time Travel). The one spelling the writer and the validator share.
 */
export const BACKUP_MANIFEST_VERSION = '2.0.0';

/**
 * Error a backup listing (R2 for health, KV for backupKV) fails with when a
 * page says it is truncated but gives no cursor, or repeats one: never a
 * silent stop on a partial listing. Health reports it; the backup writes
 * nothing.
 */
export const BACKUP_LISTING_CURSOR_INVALID = 'Backup listing cursor invalid';

/** The archive key for a backup date: daily/{YYYYMMDD}/kv-routes.ndjson.gz */
export function backupArchiveKey(date: string): string {
  return `${BACKUP_DAILY_PREFIX}${date}/kv-routes.ndjson.gz`;
}

/** The manifest key for a backup date: daily/{YYYYMMDD}/manifest.json */
export function backupManifestKey(date: string): string {
  return `${BACKUP_DAILY_PREFIX}${date}/manifest.json`;
}
