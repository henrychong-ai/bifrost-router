/**
 * File comment persistence.
 *
 * A free-text note per R2 file, stored in the D1 `file_comments` sidecar keyed
 * by (bucket, key). Comment edits are a single UPSERT — no object copy, so they
 * work regardless of file size (unlike R2 custom metadata, which is copy-only
 * and capped at 8 KB).
 *
 * Error policy:
 * - Reads (`getFileComment`, `listFileComments`) swallow errors and return
 *   null / an empty map so a D1 hiccup never breaks object listing or detail.
 * - `setFileComment` THROWS so the dedicated comment endpoint can report a save
 *   failure to the caller. Lifecycle callers use the best-effort variants below.
 * - Lifecycle helpers (`deleteFileComment`, `carryFileComment`) are best-effort
 *   (swallow + log) because the primary object operation has already happened.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { sanitizeComment } from '@bifrost/shared';
import { createDb } from './index';
import { fileComments } from './schema';

/**
 * A file comment as surfaced to API responses.
 */
export interface FileCommentRecord {
  comment: string;
  updatedBy: string | null;
  updatedAt: number;
}

function logCommentError(message: string, error: unknown, bucket: string, key?: string): void {
  console.error(
    JSON.stringify({
      level: 'error',
      message,
      error: error instanceof Error ? error.message : String(error),
      bucket,
      key,
    }),
  );
}

/**
 * Fetch the comment for a single (bucket, key). Returns null if none / on error.
 */
export async function getFileComment(
  db: D1Database,
  bucket: string,
  key: string,
): Promise<FileCommentRecord | null> {
  try {
    const rows = await createDb(db)
      .select()
      .from(fileComments)
      .where(and(eq(fileComments.bucket, bucket), eq(fileComments.key, key)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { comment: row.comment, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
  } catch (error) {
    logCommentError('Failed to read file comment', error, bucket, key);
    return null;
  }
}

/**
 * Cloudflare D1 caps a single query at 100 bound parameters. listFileComments
 * binds one parameter per key plus the bucket, so we chunk the key set well
 * under that ceiling and merge the per-chunk results.
 */
const D1_KEY_CHUNK = 90;

/**
 * Batch-fetch comments for many keys in one bucket. Returns a Map keyed by the
 * object key. Used to attach indicators to a listing without N round-trips.
 * Chunks the IN clause to stay under D1's 100-bound-parameter limit.
 */
export async function listFileComments(
  db: D1Database,
  bucket: string,
  keys: string[],
): Promise<Map<string, FileCommentRecord>> {
  const map = new Map<string, FileCommentRecord>();
  if (keys.length === 0) return map;
  try {
    const drizzleDb = createDb(db);
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += D1_KEY_CHUNK) {
      chunks.push(keys.slice(i, i + D1_KEY_CHUNK));
    }
    const results = await Promise.all(
      chunks.map(chunk =>
        drizzleDb
          .select()
          .from(fileComments)
          .where(and(eq(fileComments.bucket, bucket), inArray(fileComments.key, chunk))),
      ),
    );
    for (const rows of results) {
      for (const row of rows) {
        map.set(row.key, {
          comment: row.comment,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        });
      }
    }
  } catch (error) {
    logCommentError('Failed to list file comments', error, bucket);
  }
  return map;
}

/**
 * UPSERT a comment row keyed on (bucket, key). When `updatedAt` is omitted the
 * insert uses the column default and an update bumps it to now; pass an explicit
 * `updatedAt` to preserve the original edit time (used when carrying a comment).
 */
async function upsertComment(
  db: D1Database,
  row: {
    bucket: string;
    key: string;
    comment: string;
    updatedBy: string | null;
    updatedAt?: number;
  },
): Promise<void> {
  await createDb(db)
    .insert(fileComments)
    .values({
      bucket: row.bucket,
      key: row.key,
      comment: row.comment,
      updatedBy: row.updatedBy,
      ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
    })
    .onConflictDoUpdate({
      target: [fileComments.bucket, fileComments.key],
      set: {
        comment: row.comment,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt !== undefined ? row.updatedAt : sql`(unixepoch())`,
      },
    });
}

/**
 * Set (or clear) the comment for a file. An empty / whitespace-only / null
 * comment deletes the row. THROWS on failure — callers that must report success
 * (the comment endpoint) let it propagate; best-effort callers catch it.
 */
export async function setFileComment(
  db: D1Database,
  params: {
    bucket: string;
    key: string;
    comment: string | null | undefined;
    updatedBy?: string | null;
  },
): Promise<string | null> {
  const sanitized = sanitizeComment(params.comment);

  if (sanitized === null) {
    await createDb(db)
      .delete(fileComments)
      .where(and(eq(fileComments.bucket, params.bucket), eq(fileComments.key, params.key)));
    return null;
  }

  await upsertComment(db, {
    bucket: params.bucket,
    key: params.key,
    comment: sanitized,
    updatedBy: params.updatedBy ?? null,
  });
  return sanitized;
}

/**
 * Delete the comment row for a file (best-effort). Called after an object is
 * deleted so the note doesn't orphan / resurrect under a reused key.
 */
export async function deleteFileComment(
  db: D1Database,
  bucket: string,
  key: string,
): Promise<void> {
  try {
    await createDb(db)
      .delete(fileComments)
      .where(and(eq(fileComments.bucket, bucket), eq(fileComments.key, key)));
  } catch (error) {
    logCommentError('Failed to delete file comment', error, bucket, key);
  }
}

/**
 * Carry a comment from one (bucket, key) to another (best-effort). Called after
 * a rename (same bucket) or move (across buckets) so the note follows the file.
 * No-op when source == destination or when the source has no comment.
 */
export async function carryFileComment(
  db: D1Database,
  params: { fromBucket: string; fromKey: string; toBucket: string; toKey: string },
): Promise<void> {
  if (params.fromBucket === params.toBucket && params.fromKey === params.toKey) return;
  try {
    const existing = await getFileComment(db, params.fromBucket, params.fromKey);
    if (!existing) return;
    // Preserve the original edit time/attribution at the destination.
    await upsertComment(db, {
      bucket: params.toBucket,
      key: params.toKey,
      comment: existing.comment,
      updatedBy: existing.updatedBy,
      updatedAt: existing.updatedAt,
    });
    await createDb(db)
      .delete(fileComments)
      .where(and(eq(fileComments.bucket, params.fromBucket), eq(fileComments.key, params.fromKey)));
  } catch (error) {
    logCommentError('Failed to carry file comment', error, params.fromBucket, params.fromKey);
  }
}
