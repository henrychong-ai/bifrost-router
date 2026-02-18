import type { Bindings } from '../types';
import type { BackupResult } from './types';
import { backupKV } from './kv';
import { backupD1 } from './d1';
import { writeManifest } from './manifest';
import { cleanupOldBackups } from './retention';

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
 * Orchestrates the full backup process:
 * 1. Backup KV routes (all domains)
 * 2. Backup D1 analytics tables (last 30 days)
 * 3. Write manifest file
 * 4. Cleanup old backups per retention policy
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

    // Step 1: Backup KV routes
    console.log(`[Backup] Starting KV backup for ${date}`);
    const kvResult = await backupKV(env.ROUTES, env.BACKUP_BUCKET, date);
    console.log(`[Backup] KV backup complete: ${kvResult.totalRoutes} routes`);

    // Step 2: Backup D1 tables
    console.log(`[Backup] Starting D1 backup for ${date}`);
    const d1Result = await backupD1(env.DB, env.BACKUP_BUCKET, date);
    console.log(`[Backup] D1 backup complete: ${d1Result.totalRows} rows`);

    // Step 3: Write manifest
    const manifest = await writeManifest(
      env.BACKUP_BUCKET,
      date,
      kvResult,
      d1Result,
    );
    console.log(`[Backup] Manifest written: daily/${date}/manifest.json`);

    // Step 4: Cleanup old backups
    const cleanup = await cleanupOldBackups(env.BACKUP_BUCKET);
    if (cleanup.deleted.length > 0) {
      console.log(`[Backup] Cleaned up ${cleanup.deleted.length} old files`);
    }

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
