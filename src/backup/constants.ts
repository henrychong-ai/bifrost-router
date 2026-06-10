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
