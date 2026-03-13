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
 * Number of rows to fetch per D1 query.
 * Keeps each query well within D1's response size limits.
 */
const PAGE_SIZE = 5000;

/**
 * Backup D1 analytics tables to R2 as compressed NDJSON
 *
 * Exports recent data (last N days) from each table using paginated queries,
 * streams rows through gzip compression directly to R2.
 *
 * Each table is backed up independently — a single table failure does not
 * prevent other tables from being backed up.
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
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - daysToBackup * 24 * 60 * 60;

  const files: Record<string, string> = {};
  let totalRows = 0;
  const failedTables: string[] = [];

  for (const table of D1_TABLES) {
    try {
      const result = await backupTable(db, bucket, date, table, cutoffTimestamp);
      files[table] = result.file;
      totalRows += result.rowCount;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: `D1 backup failed for table: ${table}`,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      failedTables.push(table);
    }
  }

  return {
    tables: [...D1_TABLES].filter(t => !failedTables.includes(t)),
    totalRows,
    files,
    failedTables: failedTables.length > 0 ? failedTables : undefined,
  };
}

/**
 * Backup a single D1 table to R2 using paginated queries and streaming compression.
 *
 * Queries rows in pages of PAGE_SIZE, streams each page through a TextEncoder
 * and CompressionStream (gzip) directly into R2 — avoids loading the entire
 * table into memory.
 */
async function backupTable(
  db: D1Database,
  bucket: R2Bucket,
  date: string,
  table: string,
  cutoffTimestamp: number,
): Promise<{ file: string; rowCount: number }> {
  let queryOffset = 0;
  let rowCount = 0;
  const encoder = new TextEncoder();

  const ndjsonStream = new ReadableStream({
    async pull(controller) {
      const result = await db
        .prepare(
          `SELECT * FROM ${table} WHERE created_at >= ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
        )
        .bind(cutoffTimestamp, PAGE_SIZE, queryOffset)
        .all();

      for (const row of result.results) {
        controller.enqueue(encoder.encode(JSON.stringify(row) + '\n'));
      }
      rowCount += result.results.length;
      queryOffset += PAGE_SIZE;

      if (result.results.length < PAGE_SIZE) {
        controller.close();
      }
    },
  });

  // Collect compressed output to ArrayBuffer — compressed data is small (~10:1 ratio).
  // The key memory savings come from paginated D1 queries + streaming serialization,
  // not from streaming the compressed output to R2.
  const compressed = await new Response(
    ndjsonStream.pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  const filename = `daily/${date}/d1-${table}.ndjson.gz`;
  await bucket.put(filename, compressed, {
    customMetadata: {
      date,
      type: `d1-${table}`,
    },
  });

  return { file: filename, rowCount };
}
