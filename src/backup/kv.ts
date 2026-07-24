import { SUPPORTED_DOMAINS } from '../types';
import { gzipCompress } from './compress';
import { BACKUP_DAILY_PREFIX } from './constants';
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
  date: string,
): Promise<KVBackupResult> {
  const allRoutes: Array<{ key: string; value: unknown }> = [];

  // Iterate through all supported domains. Route keys are `{domain}:{path}`;
  // QR records (v1.30.0) live under `qr:{domain}:{id}` in the SAME namespace,
  // so each domain is backed up under BOTH prefixes — without the second
  // prefix every QR code (incl. Wi-Fi payloads) would be silently absent from
  // the backup and unrecoverable after a namespace loss. Restore routing is
  // key-shape based: `qr:`-prefixed entries are QR records, everything else
  // is a route.
  for (const domain of SUPPORTED_DOMAINS) {
    for (const prefix of [`${domain}:`, `qr:${domain}:`]) {
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
  }

  // Convert to NDJSON (newline-delimited JSON)
  const ndjson = allRoutes.map(r => JSON.stringify(r)).join('\n');
  const compressed = await gzipCompress(ndjson);

  const filename = `${BACKUP_DAILY_PREFIX}${date}/kv-routes.ndjson.gz`;
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
