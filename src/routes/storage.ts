import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Bindings } from '../types';
import { ALL_BUCKET_BINDINGS } from '../types';
import { validateR2Key } from '../utils/path-validation';
import { purgeR2CacheForObject } from '../utils/cache';
import { recordAuditLog } from '../db/analytics';
import {
  getFileComment,
  listFileComments,
  setFileComment,
  deleteFileComment,
  carryFileComment,
  type FileCommentRecord,
} from '../db/file-comments';
import type { AuditAction } from '@bifrost/shared';
import type { R2ObjectInfo, AllR2BucketName } from '@bifrost/shared';
import { ALL_R2_BUCKETS, READ_ONLY_BUCKETS, CommentSchema, normalizeR2Key } from '@bifrost/shared';

const DEFAULT_R2_COPY_SIZE_LIMIT_MB = 100;

export function getR2CopySizeLimit(env?: Record<string, unknown>): number {
  const envLimit = env?.R2_COPY_SIZE_LIMIT_MB;
  if (typeof envLimit === 'string') {
    const mb = Number(envLimit);
    if (!Number.isNaN(mb) && mb > 0) return mb * 1024 * 1024;
  }
  return DEFAULT_R2_COPY_SIZE_LIMIT_MB * 1024 * 1024;
}

function getBucket(env: Bindings, bucketName: string): R2Bucket | null {
  const bindingName = ALL_BUCKET_BINDINGS[bucketName as AllR2BucketName];
  if (!bindingName) return null;
  return ((env as Record<string, unknown>)[bindingName] as R2Bucket | undefined) ?? null;
}

function toR2ObjectInfo(obj: R2Object): R2ObjectInfo {
  return {
    key: obj.key,
    size: obj.size,
    etag: obj.etag,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata: obj.httpMetadata
      ? {
          contentType: obj.httpMetadata.contentType,
          cacheControl: obj.httpMetadata.cacheControl,
          contentDisposition: obj.httpMetadata.contentDisposition,
          contentLanguage: obj.httpMetadata.contentLanguage,
          contentEncoding: obj.httpMetadata.contentEncoding,
        }
      : undefined,
    customMetadata: obj.customMetadata,
  };
}

function isReadOnlyBucket(name: string): boolean {
  return (READ_ONLY_BUCKETS as readonly string[]).includes(name);
}

/**
 * Attach a file comment record (if any) onto an R2ObjectInfo, in place.
 * Centralises the field-copy so the list + meta handlers stay in sync.
 */
function attachComment(info: R2ObjectInfo, fc: FileCommentRecord | null): R2ObjectInfo {
  if (fc) {
    info.comment = fc.comment;
    info.commentUpdatedBy = fc.updatedBy;
    info.commentUpdatedAt = fc.updatedAt;
  }
  return info;
}

function getActorInfo(c: { req: { header: (name: string) => string | undefined } }): {
  login: string;
  name: string | null;
} {
  const login = c.req.header('Tailscale-User-Login') || 'api-key';
  const name = c.req.header('Tailscale-User-Name') || null;
  return { login, name };
}

export const storageRoutes = new Hono<AppEnv>();

// GET /buckets - List all R2 buckets
storageRoutes.get('/buckets', async c => {
  return c.json({
    success: true,
    data: {
      buckets: ALL_R2_BUCKETS.map(name => ({
        name,
        access: isReadOnlyBucket(name) ? ('read-only' as const) : ('read-write' as const),
      })),
    },
  });
});

// GET /:bucket/objects - List objects
storageRoutes.get('/:bucket/objects', async c => {
  const bucketName = c.req.param('bucket');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const prefix = c.req.query('prefix') || undefined;
  const cursor = c.req.query('cursor') || undefined;
  const delimiter = c.req.query('delimiter') ?? '/';
  const limitParam = c.req.query('limit');
  const limit = Math.min(Math.max(Number(limitParam) || 100, 1), 1000);

  const listed = await bucket.list({
    prefix,
    cursor,
    limit,
    delimiter: delimiter || undefined,
    include: ['httpMetadata', 'customMetadata'],
  } as R2ListOptions & { include: string[] });

  const objects: R2ObjectInfo[] = listed.objects.map(toR2ObjectInfo);

  // Attach file comments (best-effort) so the listing can show an at-a-glance
  // indicator. One batched D1 query keyed by this page's object keys.
  const commentMap = await listFileComments(
    c.env.DB,
    bucketName,
    objects.map(o => o.key),
  );
  for (const obj of objects) {
    attachComment(obj, commentMap.get(obj.key) ?? null);
  }

  return c.json({
    success: true,
    data: {
      objects,
      truncated: listed.truncated,
      cursor: listed.truncated ? listed.cursor : undefined,
      delimitedPrefixes: listed.delimitedPrefixes,
    },
  });
});

// GET /:bucket/meta/:key{.+} - Get object metadata
storageRoutes.get('/:bucket/meta/:key{.+}', async c => {
  const bucketName = c.req.param('bucket');
  const key = c.req.param('key');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  const obj = await bucket.head(validation.sanitizedKey);
  if (!obj) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }

  // Attach the file comment (best-effort) for the detail panel.
  const info = attachComment(
    toR2ObjectInfo(obj),
    await getFileComment(c.env.DB, bucketName, validation.sanitizedKey),
  );

  return c.json({ success: true, data: info });
});

// GET /:bucket/objects/:key{.+} - Download object
storageRoutes.get('/:bucket/objects/:key{.+}', async c => {
  const bucketName = c.req.param('bucket');
  const key = c.req.param('key');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  const obj = await bucket.get(validation.sanitizedKey);
  if (!obj) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }

  const headers = new Headers();
  if (obj.httpMetadata?.contentType) {
    headers.set('Content-Type', obj.httpMetadata.contentType);
  }
  headers.set('Content-Length', obj.size.toString());
  headers.set('ETag', obj.etag);

  return new Response(obj.body, { headers });
});

// POST /:bucket/upload - Upload file
storageRoutes.post('/:bucket/upload', async c => {
  const bucketName = c.req.param('bucket');
  if (isReadOnlyBucket(bucketName)) {
    return c.json({ success: false, error: `Bucket is read-only: ${bucketName}` }, 403);
  }

  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  const key = body['key'];
  const overwrite = body['overwrite'] === 'true';
  // Optional free-text comment. Only touch the comment store when the field is
  // present, so an overwrite that omits it preserves the existing note.
  const commentsRaw = body['comments'];
  const commentProvided = typeof commentsRaw === 'string';

  if (!file || !(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }
  if (!key || typeof key !== 'string') {
    throw new HTTPException(400, { message: 'Key is required' });
  }

  // Key normalization (v1.27.0, flag-gated) — a NEW-key site. Normalize to
  // lowercase-kebab when R2_KEY_NORMALIZE === 'sanitize'.
  // Replace-keeps-existing-key: when OVERWRITING and the normalized key would
  // differ from an EXISTING object stored at the raw key, keep the raw key so
  // the overwrite hits that object instead of orphaning it under a new key.
  let normalizeKey = c.env.R2_KEY_NORMALIZE === 'sanitize'; // gitleaks:allow
  if (normalizeKey && overwrite) {
    const raw = validateR2Key(key);
    if (raw.valid && normalizeR2Key(raw.sanitizedKey) !== raw.sanitizedKey) {
      const existingAtRaw = await bucket.head(raw.sanitizedKey);
      if (existingAtRaw) normalizeKey = false;
    }
  }

  const validation = validateR2Key(key, { normalize: normalizeKey });
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  // Validate an over-length comment before any side effect (parity with the
  // dedicated comment endpoint — reject rather than silently truncate).
  if (commentProvided) {
    const parsedUploadComment = CommentSchema.safeParse(commentsRaw);
    if (!parsedUploadComment.success) {
      throw new HTTPException(400, {
        message: `Invalid comment: ${
          parsedUploadComment.error.issues[0]?.message ?? 'validation failed'
        }`,
      });
    }
  }

  const existing = await bucket.head(validation.sanitizedKey);
  if (existing && !overwrite) {
    return c.json(
      { success: false, error: `Object already exists: ${validation.sanitizedKey}` },
      409,
    );
  }

  const uploaded = await bucket.put(validation.sanitizedKey, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // Persist the file comment if one was supplied (best-effort — never fail the
  // upload over a note). An omitted field leaves any existing comment untouched.
  let commentValue: string | null = null;
  if (commentProvided) {
    try {
      const commentActor = getActorInfo(c);
      commentValue = await setFileComment(c.env.DB, {
        bucket: bucketName,
        key: validation.sanitizedKey,
        comment: commentsRaw,
        updatedBy: commentActor.login,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Failed to set file comment on upload',
          error: err instanceof Error ? err.message : String(err),
          bucket: bucketName,
          key: validation.sanitizedKey,
        }),
      );
    }
  }

  const auditAction: AuditAction = existing ? 'r2_replace' : 'r2_upload';

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: auditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${validation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          key: validation.sanitizedKey,
          size: uploaded?.size,
          contentType: file.type,
          overwrite,
          ...(existing && { replaced: { size: existing.size, etag: existing.etag } }),
          ...(commentProvided && { comment: commentValue }),
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json(
    {
      success: true,
      data: uploaded ? toR2ObjectInfo(uploaded) : { key: validation.sanitizedKey },
    },
    201,
  );
});

// DELETE /:bucket/objects/:key{.+} - Delete object
storageRoutes.delete('/:bucket/objects/:key{.+}', async c => {
  const bucketName = c.req.param('bucket');
  if (isReadOnlyBucket(bucketName)) {
    return c.json({ success: false, error: `Bucket is read-only: ${bucketName}` }, 403);
  }

  const key = c.req.param('key');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  const existing = await bucket.head(validation.sanitizedKey);
  if (!existing) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }

  await bucket.delete(validation.sanitizedKey);

  // Remove any comment row so it doesn't orphan / resurrect under a reused key.
  await deleteFileComment(c.env.DB, bucketName, validation.sanitizedKey);

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_delete' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${validation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          key: validation.sanitizedKey,
          size: existing.size,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({ success: true, message: `Deleted: ${validation.sanitizedKey}` });
});

// POST /:bucket/rename - Rename/move object
storageRoutes.post('/:bucket/rename', async c => {
  const bucketName = c.req.param('bucket');
  if (isReadOnlyBucket(bucketName)) {
    return c.json({ success: false, error: `Bucket is read-only: ${bucketName}` }, 403);
  }

  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const { oldKey, newKey } = await c.req.json<{ oldKey: string; newKey: string }>();

  if (!oldKey || !newKey) {
    throw new HTTPException(400, { message: 'Both oldKey and newKey are required' });
  }

  const oldValidation = validateR2Key(oldKey);
  if (!oldValidation.valid) {
    throw new HTTPException(400, { message: `Invalid oldKey: ${oldValidation.error}` });
  }

  // NEW-key site → normalize the destination (v1.27.0, flag-gated). The source
  // (oldKey) references an existing object and is NOT normalized.
  const newValidation = validateR2Key(newKey, {
    normalize: c.env.R2_KEY_NORMALIZE === 'sanitize',
  });
  if (!newValidation.valid) {
    throw new HTTPException(400, { message: `Invalid newKey: ${newValidation.error}` });
  }

  const copySizeLimit = getR2CopySizeLimit(c.env as Record<string, unknown>);
  const headResult = await bucket.head(oldValidation.sanitizedKey);
  if (!headResult) {
    throw new HTTPException(404, {
      message: `Object not found: ${oldValidation.sanitizedKey}`,
    });
  }
  if (headResult.size > copySizeLimit) {
    const sizeMB = (headResult.size / (1024 * 1024)).toFixed(1);
    const limitMB = (copySizeLimit / (1024 * 1024)).toFixed(0);
    throw new HTTPException(413, {
      message: `Object too large for rename (${sizeMB} MB). Copy operations are limited to ${limitMB} MB to avoid Worker CPU timeout.`,
    });
  }

  const original = await bucket.get(oldValidation.sanitizedKey);
  if (!original) {
    throw new HTTPException(404, {
      message: `Object not found: ${oldValidation.sanitizedKey}`,
    });
  }

  const existing = await bucket.head(newValidation.sanitizedKey);
  if (existing) {
    await original.body?.cancel();
    return c.json(
      { success: false, error: `Destination already exists: ${newValidation.sanitizedKey}` },
      409,
    );
  }

  const copied = await bucket.put(newValidation.sanitizedKey, original.body, {
    httpMetadata: original.httpMetadata,
    customMetadata: original.customMetadata,
  });

  await bucket.delete(oldValidation.sanitizedKey);

  // Carry the comment to the new key (best-effort).
  await carryFileComment(c.env.DB, {
    fromBucket: bucketName,
    fromKey: oldValidation.sanitizedKey,
    toBucket: bucketName,
    toKey: newValidation.sanitizedKey,
  });

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_rename' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${newValidation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          oldKey: oldValidation.sanitizedKey,
          newKey: newValidation.sanitizedKey,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({
    success: true,
    data: copied ? toR2ObjectInfo(copied) : { key: newValidation.sanitizedKey },
  });
});

// POST /:bucket/move - Move object to a different bucket
storageRoutes.post('/:bucket/move', async c => {
  const sourceBucketName = c.req.param('bucket');
  if (isReadOnlyBucket(sourceBucketName)) {
    return c.json(
      { success: false, error: `Source bucket is read-only: ${sourceBucketName}` },
      403,
    );
  }

  const sourceBucket = getBucket(c.env, sourceBucketName);
  if (!sourceBucket) {
    throw new HTTPException(404, { message: `Source bucket not found: ${sourceBucketName}` });
  }

  const {
    key,
    destinationBucket: destBucketName,
    destinationKey,
  } = await c.req.json<{
    key: string;
    destinationBucket: string;
    destinationKey?: string;
  }>();

  if (!key) {
    throw new HTTPException(400, { message: 'key is required' });
  }
  if (!destBucketName) {
    throw new HTTPException(400, { message: 'destinationBucket is required' });
  }

  if (isReadOnlyBucket(destBucketName)) {
    return c.json(
      { success: false, error: `Destination bucket is read-only: ${destBucketName}` },
      403,
    );
  }

  const destBucket = getBucket(c.env, destBucketName);
  if (!destBucket) {
    throw new HTTPException(404, { message: `Destination bucket not found: ${destBucketName}` });
  }

  const keyValidation = validateR2Key(key);
  if (!keyValidation.valid) {
    throw new HTTPException(400, { message: `Invalid key: ${keyValidation.error}` });
  }

  const finalDestKey = destinationKey ?? keyValidation.sanitizedKey;
  // NEW-key site → normalize the destination (v1.27.0, flag-gated). The source
  // key references an existing object and is NOT normalized; an absent
  // destinationKey keeps the existing key (move to another bucket, same key).
  const destKeyValidation = destinationKey
    ? validateR2Key(destinationKey, { normalize: c.env.R2_KEY_NORMALIZE === 'sanitize' })
    : { valid: true as const, sanitizedKey: finalDestKey };
  if (!destKeyValidation.valid) {
    throw new HTTPException(400, { message: `Invalid destinationKey: ${destKeyValidation.error}` });
  }

  const copySizeLimit = getR2CopySizeLimit(c.env as Record<string, unknown>);
  const headResult = await sourceBucket.head(keyValidation.sanitizedKey);
  if (!headResult) {
    throw new HTTPException(404, {
      message: `Object not found: ${keyValidation.sanitizedKey}`,
    });
  }
  if (headResult.size > copySizeLimit) {
    const sizeMB = (headResult.size / (1024 * 1024)).toFixed(1);
    const limitMB = (copySizeLimit / (1024 * 1024)).toFixed(0);
    throw new HTTPException(413, {
      message: `Object too large for move (${sizeMB} MB). Copy operations are limited to ${limitMB} MB to avoid Worker CPU timeout.`,
    });
  }

  const destExisting = await destBucket.head(destKeyValidation.sanitizedKey);
  if (destExisting) {
    return c.json(
      {
        success: false,
        error: `Destination already exists: ${destBucketName}/${destKeyValidation.sanitizedKey}`,
      },
      409,
    );
  }

  const original = await sourceBucket.get(keyValidation.sanitizedKey);
  if (!original) {
    throw new HTTPException(404, {
      message: `Object not found: ${keyValidation.sanitizedKey}`,
    });
  }

  const copied = await destBucket.put(destKeyValidation.sanitizedKey, original.body, {
    httpMetadata: original.httpMetadata,
    customMetadata: original.customMetadata,
  });

  await sourceBucket.delete(keyValidation.sanitizedKey);

  // Carry the comment to the destination bucket/key (best-effort).
  await carryFileComment(c.env.DB, {
    fromBucket: sourceBucketName,
    fromKey: keyValidation.sanitizedKey,
    toBucket: destBucketName,
    toKey: destKeyValidation.sanitizedKey,
  });

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_move' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${destBucketName}/${destKeyValidation.sanitizedKey}`,
        details: JSON.stringify({
          sourceBucket: sourceBucketName,
          destinationBucket: destBucketName,
          key: keyValidation.sanitizedKey,
          destinationKey: destKeyValidation.sanitizedKey,
          size: headResult.size,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({
    success: true,
    data: copied ? toR2ObjectInfo(copied) : { key: destKeyValidation.sanitizedKey },
  });
});

// PUT /:bucket/metadata/:key{.+} - Update metadata
storageRoutes.put('/:bucket/metadata/:key{.+}', async c => {
  const bucketName = c.req.param('bucket');
  if (isReadOnlyBucket(bucketName)) {
    return c.json({ success: false, error: `Bucket is read-only: ${bucketName}` }, 403);
  }

  const key = c.req.param('key');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  const { contentType, cacheControl, contentDisposition } = await c.req.json<{
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
  }>();

  const copySizeLimit = getR2CopySizeLimit(c.env as Record<string, unknown>);
  const headResult = await bucket.head(validation.sanitizedKey);
  if (!headResult) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }
  if (headResult.size > copySizeLimit) {
    const sizeMB = (headResult.size / (1024 * 1024)).toFixed(1);
    const limitMB = (copySizeLimit / (1024 * 1024)).toFixed(0);
    throw new HTTPException(413, {
      message: `Object too large for metadata update (${sizeMB} MB). Copy operations are limited to ${limitMB} MB to avoid Worker CPU timeout.`,
    });
  }

  const original = await bucket.get(validation.sanitizedKey);
  if (!original) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }

  const updatedMetadata: R2HTTPMetadata = {
    ...original.httpMetadata,
    ...(contentType !== undefined && { contentType }),
    ...(cacheControl !== undefined && { cacheControl }),
    ...(contentDisposition !== undefined && { contentDisposition }),
  };

  const updated = await bucket.put(validation.sanitizedKey, original.body, {
    httpMetadata: updatedMetadata,
    customMetadata: original.customMetadata,
  });

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_metadata_update' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${validation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          key: validation.sanitizedKey,
          contentType,
          cacheControl,
          contentDisposition,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({
    success: true,
    data: updated ? toR2ObjectInfo(updated) : { key: validation.sanitizedKey },
  });
});

// PUT /:bucket/comment/:key{.+} - Set or clear a file's free-text comment
//
// JSON body: { comment: string | null }
//
// The note is stored in the D1 `file_comments` sidecar — NOT in R2 metadata —
// so the edit is a single UPSERT with no object copy. Unlike the metadata
// endpoint, this works regardless of file size (no copy-size guard) and an
// empty/null comment clears the note.
storageRoutes.put('/:bucket/comment/:key{.+}', async c => {
  const bucketName = c.req.param('bucket');
  if (isReadOnlyBucket(bucketName)) {
    return c.json({ success: false, error: `Bucket is read-only: ${bucketName}` }, 403);
  }

  const key = c.req.param('key');
  const bucket = getBucket(c.env, bucketName);
  if (!bucket) {
    throw new HTTPException(404, { message: `Bucket not found: ${bucketName}` });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  const requestBody = await c.req.json<{ comment?: string | null }>();
  // The `comment` field is required (send null or '' to clear). A missing field
  // is rejected rather than silently clearing the note — that keeps this
  // explicit-set endpoint from contradicting the "absent = preserve" semantics
  // the upload path uses.
  const parsedComment = CommentSchema.nullable().safeParse(requestBody.comment);
  if (!parsedComment.success) {
    throw new HTTPException(400, {
      message: `Invalid comment (send a string, or null/'' to clear): ${
        parsedComment.error.issues[0]?.message ?? 'validation failed'
      }`,
    });
  }

  // The object must exist — don't create comment rows for non-existent keys.
  const head = await bucket.head(validation.sanitizedKey);
  if (!head) {
    throw new HTTPException(404, { message: `Object not found: ${validation.sanitizedKey}` });
  }

  const before = await getFileComment(c.env.DB, bucketName, validation.sanitizedKey);
  const actor = getActorInfo(c);
  const updatedBy = actor.login;
  // setFileComment throws on a D1 failure → surfaces as 500 so the caller knows
  // the note did not save (unlike the best-effort lifecycle helpers).
  const after = await setFileComment(c.env.DB, {
    bucket: bucketName,
    key: validation.sanitizedKey,
    comment: parsedComment.data ?? null,
    updatedBy,
  });

  try {
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_comment_update' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${validation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          key: validation.sanitizedKey,
          comment: { before: before?.comment ?? null, after },
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({
    success: true,
    data: {
      bucket: bucketName,
      key: validation.sanitizedKey,
      comment: after,
      commentUpdatedBy: after === null ? null : updatedBy,
      commentUpdatedAt: after === null ? null : Math.floor(Date.now() / 1000),
    },
  });
});

/**
 * POST /:bucket/purge-cache/:key - Purge CDN cache for an R2 object
 *
 * Uses the Cloudflare Zone Cache Purge API to globally invalidate cache
 * across all edge PoPs for all routes serving this R2 object.
 *
 * Requires CLOUDFLARE_API_TOKEN with Zone > Cache Purge permission.
 * Gracefully degrades without it (returns URLs but purged=0).
 */
storageRoutes.post('/:bucket/purge-cache/:key{.+}', async c => {
  const bucketName = c.req.param('bucket') as AllR2BucketName;
  const key = c.req.param('key');

  if (!ALL_R2_BUCKETS.includes(bucketName)) {
    return c.json({ success: false, error: `Unknown bucket: ${bucketName}` }, 400);
  }

  const result = await purgeR2CacheForObject(
    c.env.ROUTES,
    bucketName,
    key,
    c.env.CLOUDFLARE_API_TOKEN,
  );

  // Record audit log
  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        action: 'r2_cache_purge' as AuditAction,
        domain: 'bifrost.example.com',
        path: `/${bucketName}/${key}`,
        actorLogin: actor.login,
        actorName: actor.name,
        details: JSON.stringify({
          bucket: bucketName,
          key,
          purged: result.purged,
          failed: result.failed,
          urls: result.urls,
        }),
        ipAddress: c.req.header('CF-Connecting-IP') || null,
      }),
    );
  } catch {
    // executionCtx not available in tests
  }

  return c.json({ success: true, data: result });
});
