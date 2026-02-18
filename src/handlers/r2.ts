import type { Context } from 'hono';
import type { AppEnv, Bindings, KVRouteConfig, R2BucketName } from '../types';
import { BUCKET_BINDINGS, isValidR2Bucket } from '../types';
import { validateR2Key } from '../utils/path-validation';

/**
 * Cache status header name
 * Used to communicate cache hit/miss status to analytics
 */
export const CACHE_STATUS_HEADER = 'X-Cache-Status';

/**
 * Handle R2 file serving routes with Cloudflare Cache
 *
 * Features:
 * - Stream files from R2 bucket
 * - Automatic content-type detection
 * - Configurable cache control
 * - Content-Disposition for downloads
 * - Path traversal protection
 * - Cloudflare Cache API integration for edge caching
 */
export async function handleR2(
  c: Context<AppEnv>,
  route: KVRouteConfig,
): Promise<Response> {
  // Get bucket name from route config, default to "files"
  const bucketName: R2BucketName = route.bucket ?? 'files';

  // Validate bucket name
  if (!isValidR2Bucket(bucketName)) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Invalid R2 bucket name',
        path: route.path,
        bucket: bucketName,
      }),
    );
    return c.json({ error: `Invalid bucket: ${bucketName}` }, 400);
  }

  // Get the binding name and access the bucket
  const bindingName = BUCKET_BINDINGS[bucketName] as keyof Bindings;
  const bucket = c.env[bindingName] as R2Bucket | undefined;

  if (!bucket) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'R2 bucket not configured',
        path: route.path,
        bucket: bucketName,
        binding: bindingName,
      }),
    );
    return c.json({ error: `R2 bucket not configured: ${bucketName}` }, 500);
  }

  // Validate and sanitize R2 key for path traversal protection
  const validation = validateR2Key(route.target);
  if (!validation.valid) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Invalid R2 key',
        path: route.path,
        target: route.target,
        error: validation.error,
      }),
    );
    return c.json(
      {
        error: 'Invalid file path',
        message: 'The requested file path is not allowed.',
      },
      400,
    );
  }

  // Use request URL as cache key
  const cacheKey = new Request(c.req.url, {
    method: 'GET',
    headers: c.req.raw.headers,
  });

  // Try to get from cache first
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    // Cache HIT - clone response and add cache status header
    const headers = new Headers(cachedResponse.headers);
    headers.set(CACHE_STATUS_HEADER, 'HIT');

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'R2 cache HIT',
        path: route.path,
        key: route.target,
        bucket: bucketName,
      }),
    );

    return new Response(cachedResponse.body, {
      status: cachedResponse.status,
      headers,
    });
  }

  // Cache MISS - fetch from R2
  // Use sanitized key to prevent path traversal
  const object = await bucket.get(validation.sanitizedKey);

  if (!object) {
    return c.json({ error: 'File not found', key: route.target }, 404);
  }

  // Determine content type
  const contentType =
    object.httpMetadata?.contentType ||
    getContentTypeFromKey(route.target) ||
    'application/octet-stream';

  // Build headers
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Length': String(object.size),
    ETag: object.etag,
    'Cache-Control': route.cacheControl || 'public, max-age=3600',
    [CACHE_STATUS_HEADER]: 'MISS',
  });

  // Add Content-Disposition for downloadable files
  // Use route.forceDownload if explicitly set, otherwise fall back to content-type based logic
  const shouldDownload =
    route.forceDownload ?? shouldForceDownload(contentType);
  if (shouldDownload) {
    const filename = route.target.split('/').pop() || 'download';
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  }

  // Stream the body using tee() to avoid buffering entire file in memory
  const [clientStream, cacheStream] = object.body.tee();
  const response = new Response(clientStream, { headers });

  // Store in cache (don't await - let it happen in background)
  // Create a new response for caching (without the cache status header)
  const cacheHeaders = new Headers(headers);
  cacheHeaders.delete(CACHE_STATUS_HEADER);
  const responseToCache = new Response(cacheStream, { headers: cacheHeaders });

  // Use waitUntil to cache in background
  try {
    c.executionCtx.waitUntil(cache.put(cacheKey, responseToCache));
  } catch {
    // executionCtx may not be available in tests
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'R2 cache MISS',
      path: route.path,
      key: route.target,
      bucket: bucketName,
    }),
  );

  return response;
}

/**
 * Infer content type from file extension
 */
function getContentTypeFromKey(key: string): string | null {
  const ext = key.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Documents
    pdf: 'application/pdf',
    zip: 'application/zip',
    json: 'application/json',

    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',

    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',

    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',

    // Text
    txt: 'text/plain',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
  };

  return ext ? mimeTypes[ext] || null : null;
}

/**
 * Determine if content should trigger download
 */
function shouldForceDownload(contentType: string): boolean {
  const downloadTypes = [
    'application/zip',
    'application/x-tar',
    'application/x-gzip',
    'application/pdf',
    'application/octet-stream',
  ];

  return downloadTypes.includes(contentType);
}
