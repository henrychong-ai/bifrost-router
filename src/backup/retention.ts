import type { CleanupResult } from './types';

/**
 * Cleanup old backups based on retention policy
 *
 * - Daily backups: Kept for `dailyRetentionDays` (default: 30)
 * - Weekly backups (Sundays): Kept for `weeklyRetentionDays` (default: 90)
 *
 * @param bucket - R2 bucket containing backups
 * @param dailyRetentionDays - Days to keep daily backups
 * @param weeklyRetentionDays - Days to keep weekly (Sunday) backups
 * @returns List of deleted object keys
 */
export async function cleanupOldBackups(
  bucket: R2Bucket,
  dailyRetentionDays: number = 30,
  weeklyRetentionDays: number = 90,
): Promise<CleanupResult> {
  const deleted: string[] = [];
  const now = Date.now();
  const dailyCutoff = now - dailyRetentionDays * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - weeklyRetentionDays * 24 * 60 * 60 * 1000;

  // Collect keys to delete
  const toDelete: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await bucket.list({ prefix: 'daily/', cursor, limit: 1000 });

    for (const obj of result.objects) {
      // Extract date from path: daily/YYYYMMDD/...
      const match = obj.key.match(/^daily\/(\d{8})\//);
      if (!match) continue;

      const dateStr = match[1];
      const year = parseInt(dateStr.slice(0, 4));
      const month = parseInt(dateStr.slice(4, 6)) - 1; // JS months are 0-indexed
      const day = parseInt(dateStr.slice(6, 8));
      const backupDate = new Date(year, month, day).getTime();

      // Check if this is a Sunday backup (day of week 0 = Sunday)
      const dayOfWeek = new Date(year, month, day).getDay();
      const isSunday = dayOfWeek === 0;

      // Apply retention policy
      if (isSunday) {
        // Sunday backups: keep for weekly retention period
        if (backupDate < weeklyCutoff) {
          toDelete.push(obj.key);
        }
      } else {
        // Non-Sunday backups: keep for daily retention period
        if (backupDate < dailyCutoff) {
          toDelete.push(obj.key);
        }
      }
    }

    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  // Delete old backups
  for (const key of toDelete) {
    await bucket.delete(key);
    deleted.push(key);
  }

  return { deleted };
}
