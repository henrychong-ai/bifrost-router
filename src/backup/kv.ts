import { SUPPORTED_DOMAINS } from '../types';
import { gzipCompress } from './compress';
import type { KVBackupResult } from './types';

/**
 * Backup all KV routes to R2 as compressed NDJSON
 *
 * Iterates through all supported domains, fetches all routes from KV,
 * converts to NDJSON format, compresses with gzip, and uploads to R2.
 *
 * @param kv - KV namespace containing routes
 * @param bucket - R2 bucket for backup storage
 * @param date - Backup date in YYYYMMDD format
 * @returns Backup result with route count and file path
 */
export async function backupKV(
  kv: KVNamespace,
  bucket: R2Bucket,
  date: string
): Promise<KVBackupResult> {
  const allRoutes: Array<{ key: string; value: unknown }> = [];

  // Iterate through all supported domains
  for (const domain of SUPPORTED_DOMAINS) {
    const prefix = `${domain}:`;
    let cursor: string | undefined;

    do {
      const result = await kv.list({ prefix, cursor, limit: 1000 });

      for (const key of result.keys) {
        const value = await kv.get(key.name, 'json');
        if (value) {
          allRoutes.push({ key: key.name, value });
        }
      }

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
  }

  // Convert to NDJSON (newline-delimited JSON)
  const ndjson = allRoutes.map((r) => JSON.stringify(r)).join('\n');
  const compressed = await gzipCompress(ndjson);

  const filename = `daily/${date}/kv-routes.ndjson.gz`;
  await bucket.put(filename, compressed, {
    customMetadata: {
      date,
      type: 'kv-routes',
      routeCount: String(allRoutes.length),
    },
  });

  return {
    domains: [...SUPPORTED_DOMAINS],
    totalRoutes: allRoutes.length,
    file: filename,
  };
}
