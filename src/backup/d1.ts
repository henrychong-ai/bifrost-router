import { gzipCompress } from './compress';
import type { D1BackupResult } from './types';

/**
 * D1 tables to backup
 * These match the schema defined in src/db/schema.ts
 */
const D1_TABLES = [
  'link_clicks',
  'page_views',
  'file_downloads',
  'proxy_requests',
  'audit_logs',
] as const;

/**
 * Backup D1 analytics tables to R2 as compressed NDJSON
 *
 * Exports recent data (last N days) from each table, converts to NDJSON,
 * compresses with gzip, and uploads to R2.
 *
 * @param db - D1 database instance
 * @param bucket - R2 bucket for backup storage
 * @param date - Backup date in YYYYMMDD format
 * @param daysToBackup - Number of days of data to include (default: 30)
 * @returns Backup result with row counts and file paths
 */
export async function backupD1(
  db: D1Database,
  bucket: R2Bucket,
  date: string,
  daysToBackup: number = 30,
): Promise<D1BackupResult> {
  // Calculate cutoff timestamp (Unix seconds)
  const cutoffTimestamp =
    Math.floor(Date.now() / 1000) - daysToBackup * 24 * 60 * 60;

  const files: Record<string, string> = {};
  let totalRows = 0;

  for (const table of D1_TABLES) {
    // Query recent data from each table
    // All analytics tables have created_at column (Unix timestamp)
    const result = await db
      .prepare(
        `SELECT * FROM ${table} WHERE created_at >= ? ORDER BY created_at ASC`,
      )
      .bind(cutoffTimestamp)
      .all();

    // Convert to NDJSON (empty string if no rows - still creates valid gzip file)
    const ndjson = result.results.map(row => JSON.stringify(row)).join('\n');
    const compressed = await gzipCompress(ndjson);

    const filename = `daily/${date}/d1-${table}.ndjson.gz`;
    await bucket.put(filename, compressed, {
      customMetadata: {
        date,
        type: `d1-${table}`,
        rowCount: String(result.results.length),
      },
    });

    files[table] = filename;
    totalRows += result.results.length;
  }

  return {
    tables: [...D1_TABLES],
    totalRows,
    files,
  };
}
