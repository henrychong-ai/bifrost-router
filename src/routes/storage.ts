import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Bindings } from '../types';
import { ALL_BUCKET_BINDINGS } from '../types';
import { validateR2Key } from '../utils/path-validation';
import { recordAuditLog } from '../db/analytics';
import type { AuditAction } from '@bifrost/shared';
import type { R2ObjectInfo, AllR2BucketName } from '@bifrost/shared';
import { ALL_R2_BUCKETS, READ_ONLY_BUCKETS } from '@bifrost/shared';

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
  });

  const objects: R2ObjectInfo[] = listed.objects.map(toR2ObjectInfo);

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

  return c.json({ success: true, data: toR2ObjectInfo(obj) });
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

  if (!file || !(file instanceof File)) {
    throw new HTTPException(400, { message: 'File is required' });
  }
  if (!key || typeof key !== 'string') {
    throw new HTTPException(400, { message: 'Key is required' });
  }

  const validation = validateR2Key(key);
  if (!validation.valid) {
    throw new HTTPException(400, { message: validation.error ?? 'Invalid R2 key' });
  }

  if (!overwrite) {
    const existing = await bucket.head(validation.sanitizedKey);
    if (existing) {
      return c.json(
        { success: false, error: `Object already exists: ${validation.sanitizedKey}` },
        409,
      );
    }
  }

  const uploaded = await bucket.put(validation.sanitizedKey, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  try {
    const actor = getActorInfo(c);
    c.executionCtx.waitUntil(
      recordAuditLog(c.env.DB, {
        domain: 'storage',
        action: 'r2_upload' as AuditAction,
        actorLogin: actor.login,
        actorName: actor.name,
        path: `${bucketName}/${validation.sanitizedKey}`,
        details: JSON.stringify({
          bucket: bucketName,
          key: validation.sanitizedKey,
          size: uploaded?.size,
          contentType: file.type,
          overwrite,
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

  const newValidation = validateR2Key(newKey);
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
