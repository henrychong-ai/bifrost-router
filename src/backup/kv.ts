import { SUPPORTED_DOMAINS } from '../types';
import { kvListingPage, nextCursor } from '../utils/list-cursor';
import { gzipCompress } from './compress';
import { backupArchiveKey, MAX_REPORTED_SKIPPED_KEYS } from './constants';
import {
  archiveMetadata,
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
 * The fixed log text for a KV value that is not JSON (v1.38.0), followed by
 * the record's key and nothing else: never the value, which can carry a
 * credential.
 */
export const BACKUP_SKIPPED_NOT_JSON = 'Skipped a KV record that is not JSON';

/**
 * The fixed log text for a record over MAX_RECORD_LINE_BYTES (v1.40.0),
 * followed by the record's key and nothing else: never the value.
 */
export const BACKUP_SKIPPED_OVER_LINE_LIMIT =
  'Skipped a KV record over the record line limit (MAX_RECORD_LINE_BYTES)';

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
 * The size caps and duplicate keys are enforced while the records are read.
 * A single record whose line passes MAX_RECORD_LINE_BYTES is skipped
 * (v1.40.0; it used to fail the run): counted (`skippedOverLineLimit`), its
 * key kept (`skippedOverLineLimitKeys`, at most MAX_REPORTED_SKIPPED_KEYS) and
 * logged as one fixed line naming the key, never the value; the records after
 * it are backed up. The whole store passing `maxBytes` still FAILS the run,
 * as before: the serialised NDJSON is counted as it grows and the run stops
 * with BACKUP_ERRORS.sizeLimit as soon as it passes the cap, before any join
 * or gzip and without reading the rest, writing nothing. The skipped counts go
 * into the archive's own R2 metadata, written with the archive in its one
 * put, so health reads them from the archive even when the manifest write
 * fails or a same-day re-run leaves an older manifest; the manifest carries
 * them too, with the key names, under the same `runId`. A listing page that is
 * truncated but gives no cursor, or repeats one, stops the run with
 * BackupListingError rather than backing up a partial listing. Values are
 * read as text and parsed here (v1.37.1). A value that is not JSON is skipped
 * (v1.38.0): counted as `skippedNotJson` (the manifest carries it) and logged
 * as one fixed line naming its key, never its value. Every other record is
 * backed up. Such a value is not a route or QR code any reader can use (the
 * API lists it as an unreadable row, to be deleted and created again), and
 * the archive cannot hold it unchanged: its records are `{key, value}` lines
 * with a JSON value, restored as `JSON.stringify(value)`. It used to stop
 * every nightly backup until someone deleted it.
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
  // Bytes of the NDJSON so far, exactly as `lines.join('\n')` builds it: n
  // records carry n - 1 newlines, so backupKV and verifyArchiveBytes (which
  // caps the inflated bytes) agree on the cap to the byte (v1.40.0)
  let ndjsonBytes = 0;
  // Values that are not JSON, skipped (v1.38.0)
  let skippedNotJson = 0;
  // Records over the line limit, skipped (v1.40.0), and the first of their keys
  let skippedOverLineLimit = 0;
  const skippedOverLineLimitKeys: string[] = [];
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
          // Read as text and parsed here (v1.37.1): the runtime's JSON parse
          // error can quote the stored value, so its text goes nowhere.
          const texts = await kv.get(chunk, 'text');
          for (const name of chunk) {
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
              // Skipped and counted (v1.38.0). The SyntaxError quotes the
              // value, so it is dropped; the log names the key only.
              console.warn(`[Backup] ${BACKUP_SKIPPED_NOT_JSON}: ${name}`);
              skippedNotJson += 1;
              continue;
            }
            // A stored JSON `null` is skipped, as the 'json' read returned it
            if (value === null) continue;
            if (seenKeys.has(name)) throw new BackupIntegrityError(BACKUP_ERRORS.duplicateKey);
            seenKeys.add(name);
            const line = JSON.stringify({ key: name, value });
            const lineBytes = encoder.encode(line).byteLength;
            // One record verification would refuse is skipped and named
            if (lineBytes > MAX_RECORD_LINE_BYTES) {
              console.warn(`[Backup] ${BACKUP_SKIPPED_OVER_LINE_LIMIT}: ${name}`);
              skippedOverLineLimit += 1;
              if (skippedOverLineLimitKeys.length < MAX_REPORTED_SKIPPED_KEYS) {
                skippedOverLineLimitKeys.push(name);
              }
              continue;
            }
            const separatorBytes = lines.length > 0 ? 1 : 0;
            ndjsonBytes += separatorBytes + lineBytes;
            // The whole store past the cap fails the run, writing nothing
            if (ndjsonBytes > maxBytes) throw new BackupIntegrityError(BACKUP_ERRORS.sizeLimit);
            lines.push(line);
          }
        }

        // A truncated page must hand over a cursor not seen before
        cursor = nextCursor(kvListingPage(result), seenCursors, () => new BackupListingError());
      } while (cursor);
    }
  }

  // Convert to NDJSON (newline-delimited JSON). The collected lines are
  // released as soon as they are joined, and the joined text once it is
  // compressed (v1.40.0), so at the cap the job never holds the lines, the
  // NDJSON and its gzip at once.
  const recordCount = lines.length;
  let ndjson = lines.join('\n');
  lines.length = 0;
  const compressed = await gzipCompress(ndjson);
  ndjson = '';

  // Verify before any write (defence in depth for the gzip round trip): the
  // exact bytes about to be stored must inflate to exactly the records just
  // read, within the size caps.
  await verifyArchiveBytes(new Uint8Array(compressed), recordCount, maxBytes);

  const filename = backupArchiveKey(date);
  const sha256 = await crypto.subtle.digest('SHA-256', compressed);
  // One run id ties this archive to the manifest written after it
  const runId = crypto.randomUUID();
  await bucket.put(filename, compressed, {
    customMetadata: archiveMetadata({
      date,
      routeCount: recordCount,
      runId,
      skippedNotJson,
      skippedOverLineLimit,
    }),
    sha256,
  });

  return {
    domains: [...SUPPORTED_DOMAINS],
    totalRoutes: recordCount,
    file: filename,
    skippedNotJson,
    skippedOverLineLimit,
    skippedOverLineLimitKeys,
    runId,
  };
}
