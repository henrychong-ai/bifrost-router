import { SUPPORTED_DOMAINS } from '../types';
import { gzipCompress } from './compress';
import { BACKUP_LISTING_CURSOR_INVALID, backupArchiveKey } from './constants';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  MAX_BACKUP_BYTES,
  verifyArchiveBytes,
} from './integrity';
import type { KVBackupResult } from './types';

/**
 * Keys per KV bulk read: the platform's maximum. Each bulk read is ONE of the
 * 1,000 KV operations an invocation may make (a list page is another), so a
 * backup of N records spends about ceil(N / 100) reads plus one list call per
 * 1,000 keys and per prefix (two prefixes for each supported domain).
 */
export const KV_BULK_GET_MAX_KEYS = 100;

/**
 * Backup all KV routes to R2 as compressed NDJSON
 *
 * Iterates through all supported domains, fetches all routes from KV,
 * converts to NDJSON format, compresses with gzip, and uploads to R2.
 *
 * The archive is verified in memory before anything reaches R2, then
 * written once to `daily/{date}/kv-routes.ndjson.gz` with its SHA-256,
 * so R2 refuses a body that arrives corrupted, and its record count as
 * `routeCount` metadata, which makes the archive the source of truth for its
 * own count. A run that fails verification, or whose write R2 refuses, writes
 * nothing: an earlier archive for the day (and its manifest) is untouched.
 *
 * The size cap and duplicate keys are enforced while the records are read:
 * the serialised NDJSON is counted as it grows, and the run stops with
 * BACKUP_ERRORS.sizeLimit as soon as it passes `maxBytes`, before any join or
 * gzip and without reading the rest of the namespace. A listing page that is
 * truncated but gives no cursor, or repeats one, stops the run with
 * BACKUP_LISTING_CURSOR_INVALID rather than backing up a partial listing.
 *
 * @param kv - KV namespace containing routes
 * @param bucket - R2 bucket for backup storage
 * @param date - Backup date in YYYYMMDD format
 * @param maxBytes - Size cap for the serialised records (tests lower it)
 * @returns Backup result with route count and file path
 */
export async function backupKV(
  kv: KVNamespace,
  bucket: R2Bucket,
  date: string,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<KVBackupResult> {
  // One serialised NDJSON line per record, in listing order
  const lines: string[] = [];
  const seenKeys = new Set<string>();
  const encoder = new TextEncoder();
  // Bytes of the NDJSON so far, each line counted with its newline
  let ndjsonBytes = 0;

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
      const seenCursors = new Set<string>();

      do {
        const result = await kv.list({
          prefix,
          ...(cursor !== undefined && { cursor }),
          limit: 1000,
        });

        // Read the page's values in bulk: KV allows 1,000 operations per
        // invocation and counts a bulk read as one, so one get per key failed
        // the job above about 1,000 records. Records keep the listing order.
        const names = result.keys.map(key => key.name);
        for (let start = 0; start < names.length; start += KV_BULK_GET_MAX_KEYS) {
          const chunk = names.slice(start, start + KV_BULK_GET_MAX_KEYS);
          const values = await kv.get(chunk, 'json');
          for (const name of chunk) {
            // `null` (or absent) means the key vanished between list and get.
            // Any other value is kept, falsy ones included (`false`, `0`,
            // `""`): a truthiness check dropped them and the restore lost the
            // record.
            const value = values.get(name) ?? null;
            if (value === null) continue;
            if (seenKeys.has(name)) throw new BackupIntegrityError(BACKUP_ERRORS.duplicateKey);
            seenKeys.add(name);
            const line = JSON.stringify({ key: name, value });
            ndjsonBytes += encoder.encode(line).byteLength + 1;
            if (ndjsonBytes > maxBytes) throw new BackupIntegrityError(BACKUP_ERRORS.sizeLimit);
            lines.push(line);
          }
        }

        if (result.list_complete) {
          cursor = undefined;
        } else {
          // A truncated page must hand over a cursor not seen before
          if (!result.cursor || seenCursors.has(result.cursor)) {
            throw new Error(BACKUP_LISTING_CURSOR_INVALID);
          }
          seenCursors.add(result.cursor);
          cursor = result.cursor;
        }
      } while (cursor);
    }
  }

  // Convert to NDJSON (newline-delimited JSON)
  const ndjson = lines.join('\n');
  const compressed = await gzipCompress(ndjson);

  // Verify before any write (defence in depth for the gzip round trip): the
  // exact bytes about to be stored must inflate to exactly the records just
  // read, within the size caps.
  await verifyArchiveBytes(new Uint8Array(compressed), lines.length, maxBytes);

  const filename = backupArchiveKey(date);
  const sha256 = await crypto.subtle.digest('SHA-256', compressed);
  await bucket.put(filename, compressed, {
    customMetadata: {
      date,
      type: 'kv-routes',
      routeCount: String(lines.length),
    },
    sha256,
  });

  return {
    domains: [...SUPPORTED_DOMAINS],
    totalRoutes: lines.length,
    file: filename,
  };
}
