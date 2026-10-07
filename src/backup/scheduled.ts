import type { Bindings } from '../types';
import { errorName } from '../utils/error-name';
import { BACKUP_BUCKET_NOT_CONFIGURED, backupManifestKey } from './constants';
import { BACKUP_FAILED_GENERIC, fixedBackupFailure } from './integrity';
import { backupKV } from './kv';
import { writeManifest } from './manifest';
import type { BackupResult } from './types';

/**
 * Get current date in YYYYMMDD format (UTC)
 */
function getDateString(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Handle scheduled backup event
 *
 * Orchestrates the backup process:
 * 1. Backup KV routes (all domains): verify the archive in memory, then put it once
 * 2. Write manifest file
 *
 * D1 analytics are NOT backed up here — Cloudflare D1 Time Travel
 * provides automatic 30-day point-in-time recovery.
 *
 * KV backups are retained indefinitely (~8KB/day, negligible storage).
 *
 * @param env - Worker environment bindings
 * @returns Backup result with manifest or error
 */
export async function handleScheduled(env: Bindings): Promise<BackupResult> {
  const startTime = Date.now();
  const date = getDateString();

  try {
    // Verify BACKUP_BUCKET is configured
    if (!env.BACKUP_BUCKET) {
      return {
        success: false,
        error: BACKUP_BUCKET_NOT_CONFIGURED,
        duration: Date.now() - startTime,
      };
    }

    // Step 1: Backup KV routes. backupKV verifies the archive in memory, then
    // writes it once with its SHA-256 and record count. A failure throws
    // here having written nothing, so the previous backup stays in place.
    console.log(`[Backup] Starting KV backup for ${date}`);
    const kvResult = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);
    console.log(`[Backup] KV backup complete: ${kvResult.totalRoutes} routes`);

    // Step 2: Write the manifest that certifies the verified archive. If this
    // write fails, the stored archive is still verified and carries its own
    // count. On a same-day re-run the earlier manifest stays, no longer matches,
    // and health WARNS; on the day's first run there is no manifest for the
    // date and health is CRITICAL (manifest missing). Both are deliberate.
    // Such a failed run has stored (or replaced) the day's archive, so it is
    // not one that wrote nothing. A re-run is still safe: it verifies its own
    // archive before its single write, overwrites the archive, then writes the
    // manifest.
    const manifest = await writeManifest(env.BACKUP_BUCKET, date, kvResult);
    console.log(`[Backup] Manifest written: ${backupManifestKey(date)}`);

    return {
      success: true,
      manifest,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    // The result carries fixed text only (v1.37.1): it becomes the cron's
    // rejection and log line in src/index.ts, and a raw error can quote a
    // stored value. Any other error (a KV or R2 API failure, say) becomes
    // BACKUP_FAILED_GENERIC and is logged here, once, by its class only
    // (v1.39.0): a message can quote a key, a stored value or the text a
    // parser failed on.
    const failure = fixedBackupFailure(error);
    if (failure === BACKUP_FAILED_GENERIC) {
      console.error(`[Backup] Platform error: ${errorName(error)}`);
    }
    return {
      success: false,
      error: failure,
      duration: Date.now() - startTime,
    };
  }
}
