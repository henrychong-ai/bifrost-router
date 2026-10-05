import type { Bindings } from '../types';
import { backupManifestKey } from './constants';
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
        error: 'BACKUP_BUCKET not configured',
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
    const manifest = await writeManifest(env.BACKUP_BUCKET, date, kvResult);
    console.log(`[Backup] Manifest written: ${backupManifestKey(date)}`);

    return {
      success: true,
      manifest,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    console.error('[Backup] Failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}
