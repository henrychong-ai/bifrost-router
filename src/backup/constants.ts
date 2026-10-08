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
 * Message of BackupListingError (src/backup/integrity.ts), which a backup
 * listing (R2 for health, KV for backupKV) throws when a page says it is
 * truncated but gives no cursor, or repeats one: never a silent stop on a
 * partial listing. Health reports it; the backup writes nothing. Callers match
 * the class, never this text.
 */
export const BACKUP_LISTING_CURSOR_INVALID = 'Backup listing cursor invalid';

/** handleScheduled's failure when the BACKUP_BUCKET binding is missing. */
export const BACKUP_BUCKET_NOT_CONFIGURED = 'BACKUP_BUCKET not configured';

/** The archive key for a backup date: daily/{YYYYMMDD}/kv-routes.ndjson.gz */
export function backupArchiveKey(date: string): string {
  return `${BACKUP_DAILY_PREFIX}${date}/kv-routes.ndjson.gz`;
}

/** The manifest key for a backup date: daily/{YYYYMMDD}/manifest.json */
export function backupManifestKey(date: string): string {
  return `${BACKUP_DAILY_PREFIX}${date}/manifest.json`;
}

/**
 * Most keys of skipped oversized records a manifest names (v1.40.0). The
 * count is always exact; the key list stops here, so a store full of
 * oversized records cannot grow the manifest without bound (512-byte keys
 * keep it under 26 KiB).
 */
export const MAX_REPORTED_SKIPPED_KEYS = 50;
