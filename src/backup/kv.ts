import { SUPPORTED_DOMAINS } from '../types';
import { gzipCompress } from './compress';
import { backupArchiveKey } from './constants';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  BackupListingError,
  MAX_BACKUP_BYTES,
  MAX_RECORD_LINE_BYTES,
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
 * BackupListingError rather than backing up a partial listing. Values are
 * read as text and parsed here, so a value that is not JSON stops the run with
 * the fixed BACKUP_ERRORS.kvRecordNotJson, quoting nothing (v1.37.1).
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
      // Records listed so far under this prefix: locates a malformed value
      // in the log without naming its key
      let listed = 0;

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
          // Read as text and parsed here (v1.37.1): the runtime's JSON parse
          // error can quote the stored value, so a malformed record fails with
          // the fixed BACKUP_ERRORS.kvRecordNotJson and its text goes nowhere.
          const texts = await kv.get(chunk, 'text');
          for (const name of chunk) {
            const index = listed;
            listed += 1;
            // `null` (or absent) means the key vanished between list and get.
            // Any other value is kept, falsy ones included (`false`, `0`,
            // `""`): a truthiness check dropped them and the restore lost the
            // record.
            const text = texts.get(name) ?? null;
            if (text === null) continue;
            let value: unknown;
            try {
              value = JSON.parse(text);
            } catch {
              // No cause: the SyntaxError quotes the value. Log where it is,
              // as the prefix and its position in that listing, never the key
              // or the value.
              console.error(
                `[Backup] ${BACKUP_ERRORS.kvRecordNotJson}: prefix ${prefix}, listing index ${index}`,
              );
              throw new BackupIntegrityError(BACKUP_ERRORS.kvRecordNotJson);
            }
            // A stored JSON `null` is skipped, as the 'json' read returned it
            if (value === null) continue;
            if (seenKeys.has(name)) throw new BackupIntegrityError(BACKUP_ERRORS.duplicateKey);
            seenKeys.add(name);
            const line = JSON.stringify({ key: name, value });
            const lineBytes = encoder.encode(line).byteLength;
            // A line verification would refuse fails here, explicitly and
            // before any gzip (v1.37.2), located like a malformed value
            if (lineBytes > MAX_RECORD_LINE_BYTES) {
              console.error(
                `[Backup] ${BACKUP_ERRORS.recordTooLarge}: prefix ${prefix}, listing index ${index}`,
              );
              throw new BackupIntegrityError(BACKUP_ERRORS.recordTooLarge);
            }
            ndjsonBytes += lineBytes + 1;
            if (ndjsonBytes > maxBytes) throw new BackupIntegrityError(BACKUP_ERRORS.sizeLimit);
            lines.push(line);
          }
        }

        if (result.list_complete) {
          cursor = undefined;
        } else {
          // A truncated page must hand over a cursor not seen before
          if (!result.cursor || seenCursors.has(result.cursor)) {
            throw new BackupListingError();
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
