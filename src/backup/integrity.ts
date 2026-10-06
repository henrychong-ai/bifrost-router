/**
 * Backup integrity.
 *
 * backupKV verifies the archive in memory before anything reaches R2, then
 * writes it once, with its SHA-256 (so R2 refuses a body that arrives
 * corrupted) and its record count as object metadata. The archive is therefore
 * the source of truth for its own count; the health check re-verifies the
 * latest archive against it.
 *
 * Verification inflates the gzip with pako, a JS inflater pinned to an exact
 * version, chunk by chunk as the body arrives. It checks the gzip trailer
 * (CRC-32 and length) and fails a truncated stream, and the scanner refuses
 * any byte after the one gzip member backupKV writes (junk, or a second
 * member, wherever the chunks split), so an archive is exactly that member
 * (test/backup/integrity.test.ts pins all three). The compressed bytes, the
 * inflated bytes and each record line are capped while streaming. The
 * inflated cap is enforced in the inflater's own output callback, which pako
 * calls for every 16 KiB of output and which throws mid-chunk, so a
 * high-ratio archive (a decompression bomb) stops within one output chunk of
 * the cap, however its input was chunked. Lines are split by searching only
 * the newly inflated output, a line that crosses output chunks is held in
 * one contiguous buffer, and a line longer than MAX_RECORD_LINE_BYTES fails,
 * so neither a newline-free archive nor finely fragmented input costs
 * quadratic time or unbounded memory. pako costs more CPU than the runtime's
 * native inflater, so a very large archive may pass the CPU limit of the
 * free Workers plan on a health call.
 */

import { Inflate, Z_SYNC_FLUSH } from 'pako';
import { z } from 'zod';
import {
  BACKUP_LISTING_CURSOR_INVALID,
  BACKUP_MANIFEST_VERSION,
  backupArchiveKey,
} from './constants';
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
  /**
   * The pinned pako no longer exposes the compressed-byte count the
   * trailing-data check reads (an upgrade changed its internals), so the
   * archive cannot be shown to be exactly one gzip member.
   */
  inflaterUnsupported: 'Backup verification cannot count compressed bytes (pako internals changed)',
  /**
   * A value backupKV read from KV does not parse as JSON (v1.37.1). The parse
   * error would quote the stored value, so only this text is reported, thrown
   * or logged, and the parse error is not kept as a cause.
   */
  kvRecordNotJson: 'KV record is not valid JSON',
  /**
   * A record backupKV read serialises to a line longer than
   * MAX_RECORD_LINE_BYTES (v1.37.2), which verification would refuse. Raised
   * before any gzip, naming no key; the log locates it by prefix and listing
   * index. Every API write is now checked as stored far below the line limit
   * (a route record at 64 KiB, a QR record at 192 KiB, both v1.37.2), so this
   * means a record written before those caps or straight to KV.
   */
  recordTooLarge: 'Backup record exceeds the line limit (MAX_RECORD_LINE_BYTES)',
} as const;

/** A backup check failure with one of the fixed {@link BACKUP_ERRORS} messages. */
export class BackupIntegrityError extends Error {
  constructor(message: (typeof BACKUP_ERRORS)[keyof typeof BACKUP_ERRORS]) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

/**
 * R2 failed while the stored archive was fetched or streamed (v1.37.1): a
 * storage fault, not a fault in the archive, so it is never reported as
 * BACKUP_ERRORS.content. The message is fixed; the R2 error is the `cause`,
 * for logs only.
 */
export class BackupReadError extends Error {
  constructor(cause: unknown) {
    // The one source of this text; health reports it as is
    super('Backup archive could not be read', { cause });
    this.name = 'BackupReadError';
  }
}

/**
 * A backup listing (R2 for health, KV for backupKV) whose truncated page gives
 * no cursor or repeats one: never a silent stop on a partial listing. Callers
 * detect it by class, not by message (v1.37.1), so an unrelated error that
 * happens to carry the same text is not mistaken for it.
 */
export class BackupListingError extends Error {
  constructor() {
    super(BACKUP_LISTING_CURSOR_INVALID);
    this.name = 'BackupListingError';
  }
}

/**
 * The text any other backup failure is reported with (a KV or R2 API error,
 * say). The cron reports `Backup failed: <text>`.
 */
export const BACKUP_FAILED_GENERIC = 'Storage or platform error';

/**
 * A failure as fixed text (v1.37.1), decided by class: the message of a
 * BackupIntegrityError, BackupListingError or BackupReadError, each fixed text
 * that quotes no key, payload or stored value; anything else is
 * {@link BACKUP_FAILED_GENERIC}, since a raw error can quote a stored value.
 */
export function fixedBackupFailure(error: unknown): string {
  return error instanceof BackupIntegrityError ||
    error instanceof BackupListingError ||
    error instanceof BackupReadError
    ? error.message
    : BACKUP_FAILED_GENERIC;
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
 * fit. Each route record is capped at 64 KiB on write (v1.37.2), but the
 * number of routes is not, so an unusually large route set can reach the cap. backupKV then stops while it is still reading KV, as soon
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
 * Longest single record line, in UTF-8 bytes, the scanner accepts: 1 MiB. A
 * record is one line, and the largest a write schema allows (a QR code with
 * its logo) stays under 140 KiB, so a longer line is not a record backupKV
 * wrote. In an archive it fails as BACKUP_ERRORS.content, and it bounds the
 * line buffer: without it, an archive with no newline would be held whole, up
 * to the inflated cap. backupKV refuses such a record before writing, with
 * BACKUP_ERRORS.recordTooLarge. Every API write is bounded far below it (a
 * route record at 64 KiB as stored, v1.37.2), so only a record written before
 * those caps or straight to KV can reach it.
 */
export const MAX_RECORD_LINE_BYTES = 1024 * 1024;

/** Output chunk size of the inflater: the most it inflates past a cap. */
const INFLATE_CHUNK_BYTES = 16 * 1024;

/**
 * The bytes of the record line being read, in ONE contiguous buffer that
 * grows geometrically up to MAX_RECORD_LINE_BYTES, whatever the chunking of
 * the inflated output: a line delivered a byte at a time costs at most a
 * dozen growth steps, never one retained piece per chunk. The buffer is kept
 * between lines, so it holds at most MAX_RECORD_LINE_BYTES. Exported for
 * tests.
 */
export class RecordLineBuffer {
  private bytes = new Uint8Array(1024);
  private used = 0;
  /** How many times the buffer has been reallocated. */
  growths = 0;

  /** Add `chunk` to the line; a line past MAX_RECORD_LINE_BYTES is a content failure. */
  append(chunk: Uint8Array): void {
    const needed = this.used + chunk.byteLength;
    if (needed > MAX_RECORD_LINE_BYTES) throw new BackupIntegrityError(BACKUP_ERRORS.content);
    if (needed > this.bytes.byteLength) this.grow(needed);
    this.bytes.set(chunk, this.used);
    this.used = needed;
  }

  /** The line's bytes, valid until the next append; the line starts again empty. */
  take(): Uint8Array {
    const line = this.bytes.subarray(0, this.used);
    this.used = 0;
    return line;
  }

  private grow(needed: number): void {
    let size = this.bytes.byteLength * 2;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(Math.min(size, MAX_RECORD_LINE_BYTES));
    grown.set(this.bytes.subarray(0, this.used));
    this.bytes = grown;
    this.growths += 1;
  }
}

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
 * Compressed bytes the inflater consumed for the current gzip member. pako
 * keeps its zlib stream private, and its `total_in` restarts at 0 when it
 * moves on to another member. pako is pinned to an exact version in
 * package.json for this read; if an upgrade drops or renames the field,
 * verification fails with BACKUP_ERRORS.inflaterUnsupported instead of
 * passing unchecked. Exported for tests.
 */
export function inflatedInputBytes(inflator: Inflate): number {
  const total = (inflator as unknown as { strm?: { total_in?: unknown } }).strm?.total_in;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new BackupIntegrityError(BACKUP_ERRORS.inflaterUnsupported);
  }
  return total;
}

/**
 * Check a gzip NDJSON stream of `size` compressed bytes: every line is a
 * `{key, value}` record with a non-null value, no key repeats, and the count
 * equals `expectedCount`. Only the current line and the key set are held.
 *
 * Fails with a {@link BackupIntegrityError}; its message names no key or
 * payload. A failure to read the body itself is a {@link BackupReadError}, a
 * storage fault rather than a content one. Any early exit cancels the body.
 */
async function scanArchiveStream(
  body: ReadableStream<Uint8Array>,
  size: number,
  expectedCount: number,
  maxBytes: number,
): Promise<ArchiveScan> {
  if (size === 0 || size > maxBytes) {
    // A cancel that rejects must not replace the fixed message (v1.37.1)
    await body.cancel().catch(() => undefined);
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

  // No pipe: the scanner reads the body itself, so an early exit cancels the
  // source rather than leaving that to the runtime
  const reader = body.getReader();
  let sourceDone = false;
  try {
    // Strict UTF-8. A byte-order mark is dropped only at the start of the
    // archive, as a streaming decoder would; anywhere else it stays, and the
    // JSON parse refuses it.
    const firstLineDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    const lineDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let firstLine = true;
    const decodeLine = (bytes: Uint8Array): string => {
      const decoder = firstLine ? firstLineDecoder : lineDecoder;
      firstLine = false;
      return decoder.decode(bytes);
    };
    const inflator = new Inflate({ windowBits: 31, chunkSize: INFLATE_CHUNK_BYTES });
    let inflatedBytes = 0;
    let compressedBytes = 0;
    // The line that crosses output chunks, as bytes
    const line = new RecordLineBuffer();
    // Called by pako for each piece of output (at most INFLATE_CHUNK_BYTES),
    // INSIDE push: a throw here stops the inflater mid-chunk, so neither cap
    // waits for the rest of a high-ratio input chunk to inflate.
    inflator.onData = (chunk: Uint8Array) => {
      inflatedBytes += chunk.byteLength;
      if (inflatedBytes > maxBytes) throw new BackupIntegrityError(BACKUP_ERRORS.sizeLimit);
      // A newline byte never occurs inside a multi-byte UTF-8 sequence, so
      // each newline is a character boundary. Only this chunk is searched;
      // the open line is never rescanned.
      const first = chunk.indexOf(0x0a);
      if (first === -1) {
        line.append(chunk);
        return;
      }
      line.append(chunk.subarray(0, first));
      consume(decodeLine(line.take()));
      // The whole lines inside this chunk, decoded at once (each is shorter
      // than one output chunk, so under the line cap)
      const last = chunk.lastIndexOf(0x0a);
      if (last > first) {
        const text = lineDecoder.decode(chunk.subarray(first + 1, last));
        let start = 0;
        let end = text.indexOf('\n');
        while (end !== -1) {
          consume(text.slice(start, end));
          start = end + 1;
          end = text.indexOf('\n', start);
        }
        consume(text.slice(start));
      }
      line.append(chunk.subarray(last + 1));
    };
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        // R2 failing to deliver the archive (v1.37.1); the reader is not
        // cancelled until the finally below, so this is never our own stop
        throw new BackupReadError(error);
      }
      if (next.done) {
        sourceDone = true;
        break;
      }
      const chunk = next.value;
      if (chunk.byteLength === 0) continue;
      compressedBytes += chunk.byteLength;
      if (compressedBytes > maxBytes) {
        throw new BackupIntegrityError(BACKUP_ERRORS.compressedSizeLimit);
      }
      // backupKV writes exactly one gzip member: once it has ended, any
      // further byte (junk or a second member) is refused, wherever the chunk
      // boundaries fall
      if (inflator.ended && !inflator.err) throw new BackupIntegrityError(BACKUP_ERRORS.content);
      // A sync flush hands every byte this chunk inflates to onData now,
      // rather than holding up to 16 KiB until more input arrives, so the
      // records in a chunk are checked before the next read is awaited
      inflator.push(chunk, Z_SYNC_FLUSH);
      // A corrupt stream: read no further
      if (inflator.ended && inflator.err) break;
    }
    inflator.push(new Uint8Array(0), true);
    if (inflator.err || !inflator.ended) throw new BackupIntegrityError(BACKUP_ERRORS.content);
    // Within one chunk pako inflates a following gzip member as a
    // continuation (restarting its input count) and leaves other trailing
    // bytes unread; either way the member consumed fewer bytes than arrived
    if (inflatedInputBytes(inflator) !== compressedBytes) {
      throw new BackupIntegrityError(BACKUP_ERRORS.content);
    }
    consume(decodeLine(line.take()));
    if (keys.size !== expectedCount) throw new BackupIntegrityError(BACKUP_ERRORS.countMismatch);
    return { records: keys.size, inflatedBytes };
  } catch (error) {
    // Our own fixed messages and body read failures pass through. Decoder and
    // inflater errors can quote archive bytes; report none of them.
    if (error instanceof BackupIntegrityError || error instanceof BackupReadError) throw error;
    throw new BackupIntegrityError(BACKUP_ERRORS.content);
  } finally {
    // An early exit must not keep a large archive streaming. A cancel that
    // rejects must not replace the error being thrown (v1.37.1).
    if (!sourceDone) await reader.cancel().catch(() => undefined);
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
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(key);
  } catch (error) {
    throw new BackupReadError(error);
  }
  if (!object) throw new BackupIntegrityError(BACKUP_ERRORS.missing);
  const ownCount = archiveRouteCount(object);
  // R2ObjectBody types its body as an untyped ReadableStream; it carries bytes
  const body = object.body as ReadableStream<Uint8Array>;
  const scan = await scanArchiveStream(body, object.size, ownCount ?? fallbackCount, maxBytes);
  return { ...scan, countSource: ownCount === undefined ? 'manifest' : 'archive' };
}
