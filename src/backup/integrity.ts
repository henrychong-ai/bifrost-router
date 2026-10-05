/**
 * Backup integrity.
 *
 * backupKV verifies the archive in memory before anything reaches R2, then
 * writes it once, with its SHA-256 (so R2 refuses a body that arrives
 * corrupted) and its record count as object metadata. The archive is therefore
 * the source of truth for its own count; the health check re-verifies the
 * latest archive against it.
 *
 * Verification inflates the gzip with the runtime's DecompressionStream, which
 * checks the gzip trailer (CRC-32 and length) and fails a truncated stream;
 * the compressed bytes and the inflated bytes are both capped, and the
 * inflated cap is enforced while streaming, so a corrupt or hostile archive
 * cannot exhaust the Worker.
 */

import { z } from 'zod';
import { BACKUP_MANIFEST_VERSION, backupArchiveKey } from './constants';
import type { BackupManifest } from './types';

const ManifestSchema = z.object({
  version: z.literal(BACKUP_MANIFEST_VERSION),
  timestamp: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{8}$/),
  kv: z.object({
    domains: z.array(z.string()),
    totalRoutes: z.number().int().nonnegative(),
    file: z.string(),
  }),
});

const RecordSchema = z
  .object({ key: z.string().min(1).max(512), value: z.unknown() })
  .refine(record => record.value !== undefined && record.value !== null);

/**
 * The fixed messages a backup check fails with. None quotes a key or a
 * payload: records can carry credentials (Wi-Fi QR passwords, tokens in route
 * targets). Decoder, inflater and JSON errors, which could quote archive bytes,
 * all become `content`.
 */
export const BACKUP_ERRORS = {
  /** The archive object is absent or zero bytes. */
  missing: 'Backup archive is missing or empty',
  /** The records (inflated, or serialised by backupKV) pass MAX_BACKUP_BYTES. */
  sizeLimit: 'Backup exceeds the size limit (MAX_BACKUP_BYTES)',
  /** The compressed archive itself passes MAX_BACKUP_BYTES. */
  compressedSizeLimit: 'Backup exceeds the size limit (MAX_BACKUP_BYTES) while compressed',
  countMismatch: 'Backup record count does not match',
  duplicateKey: 'Backup contains a duplicate key',
  content: 'Backup content verification failed',
} as const;

/** A backup check failure with one of the fixed {@link BACKUP_ERRORS} messages. */
export class BackupIntegrityError extends Error {
  constructor(message: (typeof BACKUP_ERRORS)[keyof typeof BACKUP_ERRORS]) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

/** What a verified archive holds. */
export interface ArchiveScan {
  records: number;
  inflatedBytes: number;
}

/** A stored archive as verified, with where its expected count came from. */
export interface StoredArchiveScan extends ArchiveScan {
  /** The archive's own `routeCount` metadata, or the manifest's for a legacy archive. */
  countSource: 'archive' | 'manifest';
}

/**
 * Cap on the compressed archive AND on its inflated bytes: 16 MiB.
 *
 * Derivation, from the write schemas rather than any one deployment: a QR
 * record is bounded by its schema in shared/src/qr.ts, and its largest part is
 * the logo, at most QR_LOGO_MAX_BYTES (100 KiB) decoded, about 134 KiB as the
 * stored base64 data URI. With the payload (MAX_QR_PAYLOAD_LENGTH), the
 * description, the tags and the design, one record stays under 140 KiB, so 50
 * logo QR codes take about 7 MiB. A route record is typically a few hundred
 * bytes: 10,000 routes at 600 bytes add about 5.7 MiB, and both together still
 * fit. Route targets carry no length limit, so an unusually large route set
 * can reach the cap. backupKV then stops while it is still reading KV, as soon
 * as the serialised records pass the cap, and fails with
 * `Backup exceeds the size limit (MAX_BACKUP_BYTES)` (BACKUP_ERRORS.sizeLimit),
 * writing nothing for the day (earlier days stay intact). That message is the
 * signal to raise this constant.
 * Peak memory stays well inside the Worker's 128 MB: backupKV holds the NDJSON
 * text and its gzip, and verification keeps one line and the key set at a time.
 * The health check warns once an archive passes half the cap.
 *
 * The byte cap is not the only limit. KV allows 1,000 operations per Worker
 * invocation on every plan, and backupKV spends them separately from bytes:
 * one list call per prefix (two per supported domain, 18 with the example's
 * nine) plus one per further 1,000 keys, and one bulk read per
 * KV_BULK_GET_MAX_KEYS (100) keys. That is about 11 operations per 1,000
 * records, so the budget runs out near (1,000 - 18) / 11 x 1,000, about 89,000
 * records. 16 MiB over 89,000 records is about 190 bytes each: with records
 * larger than that, typical for routes, the byte cap is reached first (16 MiB
 * holds about 28,000 routes at 600 bytes); only a store of very small records
 * meets the operation budget first. Either way the backup fails loudly and
 * writes nothing: the byte cap with BACKUP_ERRORS.sizeLimit before any gzip,
 * the operation budget with the KV error for the operation over it.
 */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

/**
 * Validate a stored manifest for `date`. It must name that date and that
 * date's archive, so a manifest cannot point at another day's (or any other)
 * object.
 */
export function parseBackupManifest(value: unknown, date: string): BackupManifest {
  const parsed = ManifestSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.date !== date ||
    parsed.data.kv.file !== backupArchiveKey(date)
  ) {
    throw new Error('Invalid backup manifest');
  }
  return parsed.data;
}

/**
 * Check a gzip NDJSON stream of `size` compressed bytes: every line is a
 * `{key, value}` record with a non-null value, no key repeats, and the count
 * equals `expectedCount`. Only the current line and the key set are held.
 *
 * Fails with a {@link BackupIntegrityError}; its message names no key or
 * payload.
 */
async function scanArchiveStream(
  body: ReadableStream<Uint8Array>,
  size: number,
  expectedCount: number,
  maxBytes: number,
): Promise<ArchiveScan> {
  if (size === 0 || size > maxBytes) {
    await body.cancel();
    throw new BackupIntegrityError(
      size === 0 ? BACKUP_ERRORS.missing : BACKUP_ERRORS.compressedSizeLimit,
    );
  }

  const keys = new Set<string>();
  const consume = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new BackupIntegrityError(BACKUP_ERRORS.content);
    }
    const parsed = RecordSchema.safeParse(value);
    if (!parsed.success) throw new BackupIntegrityError(BACKUP_ERRORS.content);
    if (keys.has(parsed.data.key)) throw new BackupIntegrityError(BACKUP_ERRORS.duplicateKey);
    keys.add(parsed.data.key);
    if (keys.size > expectedCount) throw new BackupIntegrityError(BACKUP_ERRORS.countMismatch);
  };

  // The archive is pumped into the inflater by hand rather than piped, so an
  // early exit can cancel the source itself: a pipe would leave cancelling
  // the source to the runtime.
  const source = body.getReader();
  const inflater = new DecompressionStream('gzip');
  const writer = inflater.writable.getWriter();
  const reader = inflater.readable.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await source.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
    }
  })();

  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let inflatedBytes = 0;
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        inflatedBytes += value.byteLength;
        if (inflatedBytes > maxBytes) throw new BackupIntegrityError(BACKUP_ERRORS.sizeLimit);
        pending += decoder.decode(value, { stream: true });
        let end = pending.indexOf('\n');
        while (end !== -1) {
          consume(pending.slice(0, end));
          pending = pending.slice(end + 1);
          end = pending.indexOf('\n');
        }
      }
    } catch (error) {
      // Stop: an early exit must not keep reading a large archive.
      await reader.cancel().catch(() => undefined);
      await source.cancel().catch(() => undefined);
      throw error;
    } finally {
      await pump;
    }
    consume(pending + decoder.decode());
    if (keys.size !== expectedCount) throw new BackupIntegrityError(BACKUP_ERRORS.countMismatch);
    return { records: keys.size, inflatedBytes };
  } catch (error) {
    // Our own fixed messages pass through. Decoder and inflater errors can
    // quote archive bytes; report none of them.
    if (error instanceof BackupIntegrityError) throw error;
    throw new BackupIntegrityError(BACKUP_ERRORS.content);
  }
}

/**
 * Verify gzip archive bytes still in memory hold exactly `expectedCount` valid
 * records (backupKV, before anything is written to R2).
 */
export function verifyArchiveBytes(
  bytes: Uint8Array,
  expectedCount: number,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<ArchiveScan> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return scanArchiveStream(body, bytes.byteLength, expectedCount, maxBytes);
}

/** The archive's own record count from its `routeCount` metadata, if well-formed. */
function archiveRouteCount(object: R2Object): number | undefined {
  const raw = object.customMetadata?.['routeCount'];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Verify the stored archive at `key` without building its records (the health
 * check). The expected count is the archive's own `routeCount` metadata, which
 * every archive backupKV writes carries; `fallbackCount` (the manifest's) is used
 * only when that metadata is missing or malformed.
 */
export async function verifyBackupArchive(
  bucket: R2Bucket,
  key: string,
  fallbackCount: number,
  maxBytes = MAX_BACKUP_BYTES,
): Promise<StoredArchiveScan> {
  const object = await bucket.get(key);
  if (!object) throw new BackupIntegrityError(BACKUP_ERRORS.missing);
  const ownCount = archiveRouteCount(object);
  // R2ObjectBody types its body as an untyped ReadableStream; it carries bytes
  const body = object.body as ReadableStream<Uint8Array>;
  const scan = await scanArchiveStream(body, object.size, ownCount ?? fallbackCount, maxBytes);
  return { ...scan, countSource: ownCount === undefined ? 'manifest' : 'archive' };
}
