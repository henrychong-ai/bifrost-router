import type { Context } from 'hono';
import { getContentTypeFromKey, redactSensitive } from '@bifrost/shared';
import type { AppEnv, Bindings, KVRouteConfig, R2BucketName } from '../types';
import { BUCKET_BINDINGS, isValidR2Bucket } from '../types';
import { validateR2Key } from '../utils/path-validation';

/**
 * Cache status header name
 * Used to communicate cache hit/miss status to analytics
 */
export const CACHE_STATUS_HEADER = 'X-Cache-Status';

/**
 * Request headers that make a GET conditional. Their presence routes the
 * request past the edge cache so R2 can evaluate the precondition itself.
 *
 * `If-Range` is deliberately NOT in this list: this list drives the cache
 * bypass, and If-Range alone changes nothing (RFC 9110 §13.1.5 — an If-Range
 * without a Range is ignored), while If-Range WITH a Range already bypasses
 * the cache via `rangeRequested`. Adding it would bypass the cache for a
 * request that is served as a plain full 200.
 */
const PRECONDITION_HEADERS = [
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
] as const;

/** Compare one entity-tag against an If-Match / If-None-Match list value. */
function etagListMatches(
  headerValue: string,
  etag: string,
  comparison: 'strong' | 'weak',
): boolean {
  const normalize = (raw: string) => raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const targetIsWeak = etag.trim().startsWith('W/');
  const target = normalize(etag);
  return headerValue.split(',').some(raw => {
    const candidate = raw.trim();
    if (candidate === '*') return true;
    // RFC 9110 §13.1.1: If-Match uses STRONG comparison — a weak tag on either
    // side never matches. If-None-Match (§13.1.2) uses the weak function.
    if (comparison === 'strong' && (candidate.startsWith('W/') || targetIsWeak)) return false;
    return normalize(candidate) === target;
  });
}

/**
 * Evaluate `If-Range` against the stored object (RFC 9110 §13.1.5).
 *
 * R2's Headers-shaped `range` option parses only the `Range` header — If-Range
 * is not part of R2's conditional model, so the handler evaluates it itself.
 *
 * Three outcomes, not two:
 *  - `match`    — the validator still describes this representation; serve the
 *                 partial response.
 *  - `mismatch` — the client's cached copy is stale, so its byte offsets are
 *                 meaningless: the `Range` MUST be ignored and the full
 *                 representation served instead.
 *  - `ignore`   — the value is neither entity-tag form nor a parseable
 *                 HTTP-date. §13.1.5 says a recipient MUST ignore an If-Range
 *                 it cannot evaluate, so the `Range` proceeds untouched.
 *                 Treating an unusable value as a mismatch would silently
 *                 downgrade a valid Range request to a full 200 — the exact
 *                 denial-of-seek an attacker would want.
 */
function evaluateIfRange(ifRange: string, object: R2Object): 'match' | 'mismatch' | 'ignore' {
  const value = ifRange.trim();
  // Entity-tag form starts with `"` or `W/`; anything else must be an HTTP-date.
  if (value.startsWith('"') || value.startsWith('W/')) {
    return etagListMatches(value, object.httpEtag, 'strong') ? 'match' : 'mismatch';
  }
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return 'ignore';
  // Date form is an EXACT match, not a before/after comparison; HTTP-dates
  // carry no milliseconds, so compare at second granularity.
  return Math.floor(object.uploaded.getTime() / 1000) === Math.floor(asDate / 1000)
    ? 'match'
    : 'mismatch';
}

/**
 * Decide whether a failed `onlyIf` is a 412 or a 304.
 *
 * R2 signals both the same way — an R2Object with no body — so re-evaluate the
 * request's own preconditions against the returned metadata. RFC 9110 §13.2.2
 * evaluates If-Match / If-Unmodified-Since first, and a failure there is a
 * 412 Precondition Failed; a failed If-None-Match / If-Modified-Since on a GET
 * is the 304 Not Modified cache-revalidation case.
 */
function isStrongPreconditionFailure(requestHeaders: Headers, object: R2Object): boolean {
  const ifMatch = requestHeaders.get('if-match');
  if (ifMatch) {
    // RFC 9110 §13.2.2 step 1: when If-Match is present its verdict is final
    // — If-Unmodified-Since applies only when If-Match is ABSENT (step 2).
    return !etagListMatches(ifMatch, object.httpEtag, 'strong');
  }

  const ifUnmodifiedSince = requestHeaders.get('if-unmodified-since');
  if (ifUnmodifiedSince) {
    const threshold = Date.parse(ifUnmodifiedSince);
    // Second-granularity comparison: HTTP-dates carry no milliseconds.
    if (
      !Number.isNaN(threshold) &&
      Math.floor(object.uploaded.getTime() / 1000) > threshold / 1000
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Build the `Headers` handed to R2 as the `onlyIf` option.
 *
 * RFC 9110 §13.2.2 evaluates If-Match first and applies If-Unmodified-Since
 * ONLY when If-Match is absent. R2 is given a raw Headers object and its
 * precedence between the two is undocumented, so the subordinate validator is
 * dropped here rather than trusted. Only this copy is filtered — the raw
 * request headers still drive `range`, If-Range, and the 412-vs-304 decision.
 */
function buildOnlyIfHeaders(requestHeaders: Headers): Headers {
  if (!requestHeaders.has('if-match') || !requestHeaders.has('if-unmodified-since')) {
    return requestHeaders;
  }
  const filtered = new Headers(requestHeaders);
  filtered.delete('if-unmodified-since');
  return filtered;
}

/**
 * Validator headers carried by every bodiless response built from object
 * metadata (304 / 412), so a client can revalidate again without a full read.
 */
function buildValidatorHeaders(object: R2Object, cacheControl?: string): Headers {
  return new Headers({
    // httpEtag, NOT etag: R2's `etag` is the raw unquoted hash, which is an
    // invalid HTTP entity-tag. Emitting it made a conforming client echo an
    // unquoted tag back in If-None-Match, and R2 rejects that outright
    // ("Invalid ETag in if-none-match header") — a 500 on every revalidation.
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': cacheControl || 'public, max-age=3600',
  });
}

/**
 * Resolve R2's satisfied range into an absolute offset + length.
 *
 * R2Range is a union — `{offset, length}`, `{offset}`, `{length}`, `{suffix}` —
 * and `size` is always the FULL object size, so a suffix range has to be
 * converted into an absolute offset before it can be put in a Content-Range.
 */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } {
  const parts = range as { offset?: number; length?: number; suffix?: number };

  if (parts.suffix !== undefined) {
    const length = Math.min(parts.suffix, size);
    return { offset: size - length, length };
  }

  const offset = parts.offset ?? 0;
  // Clamp to the bytes that actually remain: never let an over-long reported
  // length reach Content-Length/Content-Range arithmetic (a Content-Length
  // larger than the body hangs conforming clients on a truncated response).
  const remaining = Math.max(size - offset, 0);
  const length = Math.min(parts.length ?? remaining, remaining);
  return { offset, length };
}

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
 * - Range + conditional requests (206 / 304 / 412) served straight from R2
 */
export async function handleR2(c: Context<AppEnv>, route: KVRouteConfig): Promise<Response> {
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

  // Expose the served key so the analytics recorder logs the actual object
  // served instead of the route target. Set BEFORE the cache lookup: a cache
  // HIT returns early, and leaving this below it would make every HIT fall
  // back to `route.target`. `validateR2Key` strict-rejects any key whose
  // sanitized form differs, so today sanitizedKey ≡ route.target byte-for-byte
  // — the hoist keeps the attribution correct if a composed-key serve mode is
  // ever ported.
  c.set('servedR2Key', validation.sanitizedKey);

  const requestHeaders = c.req.raw.headers;
  const method = c.req.method;
  // Range is defined for GET only (RFC 9110 §14.2), so the `range` option is
  // withheld on every other method; the conditional headers still apply to
  // HEAD. A Range header on a non-GET is ignored, but it still bypasses the
  // edge cache — the response it would be served from was cached for a GET.
  const isGet = method === 'GET';
  const hasRangeHeader = requestHeaders.has('range');
  const rangeRequested = isGet && hasRangeHeader;
  const conditionalRequested = PRECONDITION_HEADERS.some(header => requestHeaders.has(header));
  const onlyIfHeaders = buildOnlyIfHeaders(requestHeaders);

  // Try the shared edge cache.
  //
  // The key is built from the URL ALONE. Cloudflare's Cache API keys on URL,
  // so the request headers the previous key carried were inert — dropping them
  // removes a hazard (a future Cache API change, or a reader assuming they
  // fragmented the cache) rather than fixing a live miss rate. The corollary of
  // a URL-only key is that range and conditional requests must bypass the cache
  // entirely: a URL-keyed entry holds the full 200 body, so serving it would
  // ignore Range and never produce a 304.
  const cache = caches.default;
  let cacheKey: Request | null = null;
  if (!hasRangeHeader && !conditionalRequested) {
    cacheKey = new Request(c.req.url, { method: 'GET' });

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
          key: validation.sanitizedKey,
          bucket: bucketName,
        }),
      );

      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }
  }

  // Cache MISS (or range/conditional bypass) - fetch from R2.
  // Use sanitized key to prevent path traversal. The request's own headers are
  // handed to R2 so it evaluates `Range` and the precondition headers itself.
  let object: R2Object | null;
  // Set when a degraded read discarded `onlyIf` entirely, so the strong
  // preconditions can be re-evaluated in the handler afterwards.
  let onlyIfDropped = false;
  try {
    object = await bucket.get(
      validation.sanitizedKey,
      isGet ? { onlyIf: onlyIfHeaders, range: requestHeaders } : { onlyIf: onlyIfHeaders },
    );
  } catch (error) {
    // R2 throws on request options it cannot parse — a malformed or
    // unsatisfiable Range, OR an invalid precondition validator. The latter is
    // guaranteed real traffic on deploy day: earlier releases served the RAW
    // unquoted etag, so every returning client echoes it back
    // as `If-None-Match: <unquoted>` and R2 rejects it outright. RFC 9110
    // §13.1/§14.2 let a recipient ignore a validator or Range it cannot use —
    // degrade stepwise, never 500.
    //
    // The error is NOT inspected: R2 does not expose a stable machine-readable
    // discriminator, so a transient fault reaching this branch is retried as a
    // plainer read and only then surfaces. Limitation: with a MIXED validator
    // set (one usable, one not) the ladder drops all of them together, which is
    // why the strong preconditions are re-evaluated below.
    if (!rangeRequested && !conditionalRequested) throw error;
    console.warn(
      JSON.stringify({
        level: 'warn',
        message:
          'R2 read failed with request options present (malformed options or transient fault) — degrading to a plainer read',
        path: route.path,
        key: validation.sanitizedKey,
        bucket: bucketName,
        // Both values are attacker-supplied or attacker-influenced: the Range
        // is echoed straight from the request, and an R2 error message can
        // quote the rejected header back. Clamp the one and redact the other.
        range: requestHeaders.get('range')?.slice(0, 256),
        error: redactSensitive(error instanceof Error ? error.message : String(error)),
      }),
    );
    try {
      if (conditionalRequested && !rangeRequested) {
        // No Range was sent, so the precondition set is the only thing R2 can
        // have choked on — drop it.
        onlyIfDropped = true;
        object = await bucket.get(validation.sanitizedKey);
      } else {
        // Drop the Range first and keep the preconditions: they may be fine.
        object = await bucket.get(validation.sanitizedKey, { onlyIf: onlyIfHeaders });
      }
    } catch {
      // The precondition validator was (also) the unusable option — ignore it
      // and serve the full object. A genuine R2 outage still surfaces: this
      // final unconditional read is deliberately left unwrapped.
      onlyIfDropped = true;
      object = await bucket.get(validation.sanitizedKey);
    }
  }

  if (!object) {
    // RFC 9110 §13.1.1: If-Match against a representation that does not exist
    // is a precondition FAILURE, not a miss — including `If-Match: *`. A 404
    // here would tell a conditional writer "no such object" when the honest
    // answer is "your precondition does not hold".
    if (requestHeaders.has('if-match')) {
      return new Response(null, { status: 412 });
    }
    return c.json({ error: 'File not found', key: route.target }, 404);
  }

  // A bodiless R2Object means `onlyIf` was not satisfied: R2 declined to read
  // the body. Which status that maps to depends on WHICH precondition failed.
  let objectBody = (object as R2ObjectBody).body as ReadableStream | undefined;
  if (!objectBody) {
    // RFC 9110 §15.4.5: 304 is a cache-revalidation answer, defined for GET and
    // HEAD only. On any other method an unsatisfied precondition is a 412 —
    // returning 304 would tell a conditional writer its request succeeded
    // against an unchanged resource when nothing was evaluated for it.
    const isSafeMethod = isGet || method === 'HEAD';
    const status = !isSafeMethod || isStrongPreconditionFailure(requestHeaders, object) ? 412 : 304;
    return new Response(null, {
      status,
      headers: buildValidatorHeaders(object, route.cacheControl),
    });
  }

  // Precondition restoration after a degraded read — deliberately strict; the
  // obvious implementation fails open here.
  //
  // The ladder above may have discarded `onlyIf` because ONE validator in the
  // set was unusable. That silently converts a failing `If-Match` into a full
  // 200: the caller believes it read the representation it pinned, when it read
  // whatever is there now. Re-evaluate the STRONG preconditions against the
  // metadata we did get back and fail closed. The weak validators
  // (If-None-Match / If-Modified-Since) are deliberately not restored — losing
  // them only costs a 304 optimisation, and a 200 is always a correct answer to
  // a conditional GET.
  if (
    onlyIfDropped &&
    (requestHeaders.has('if-match') || requestHeaders.has('if-unmodified-since')) &&
    isStrongPreconditionFailure(requestHeaders, object)
  ) {
    await objectBody.cancel().catch(() => {});
    return new Response(null, {
      status: 412,
      headers: buildValidatorHeaders(object, route.cacheControl),
    });
  }

  // If-Range (RFC 9110 §13.1.5): a validator that no longer matches means the
  // client's cached copy is stale, so its byte offsets are meaningless — the
  // Range MUST be ignored and the whole representation served. R2's
  // Headers-shaped `range` option parses only `Range`, so If-Range is not part
  // of R2's conditional model and the sliced read has to be discarded and the
  // object re-read in full. An UNUSABLE If-Range value is ignored outright and
  // the Range proceeds (see evaluateIfRange).
  //
  // The re-read KEEPS `onlyIf`: a concurrent overwrite between the two reads
  // would otherwise let this serve a representation that the caller's passing
  // If-Match never validated. A bodiless result therefore falls through to the
  // vanished-object branch and 404s — deliberate fail-closed. Losing the race
  // costs one retry; serving the wrong bytes to a conditional reader does not
  // announce itself.
  const ifRange = requestHeaders.get('if-range');
  if (ifRange && object.range && evaluateIfRange(ifRange, object) === 'mismatch') {
    const fullObject = await bucket.get(validation.sanitizedKey, { onlyIf: onlyIfHeaders });
    const fullBody = (fullObject as R2ObjectBody | null)?.body as ReadableStream | undefined;
    if (fullObject && fullBody) {
      await objectBody.cancel().catch(() => {});
      object = fullObject;
      objectBody = fullBody;
    } else {
      // The object vanished, or was overwritten into something the caller's
      // preconditions no longer match, between the two reads. The client's
      // validator is known-stale, so a 206 built from the old slice would be
      // spliced into a stale local copy — silent file corruption. RFC 9110
      // §13.1.5 says the Range must be ignored on a validator mismatch; with
      // nothing left to serve in full, fail closed as not-found.
      await objectBody.cancel().catch(() => {});
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'R2 If-Range full re-read missed — object vanished, returning 404',
          path: route.path,
          key: validation.sanitizedKey,
          bucket: bucketName,
        }),
      );
      return c.json({ error: 'File not found', key: route.target }, 404);
    }
  }

  // Determine content type
  const contentType =
    object.httpMetadata?.contentType ||
    getContentTypeFromKey(validation.sanitizedKey) ||
    'application/octet-stream';

  // A satisfied range makes this a 206. `object.size` stays the FULL object
  // size — only the body and Content-Length shrink to the served slice.
  const servedRange =
    rangeRequested && object.range ? resolveRange(object.range, object.size) : null;

  // A zero-length satisfied range would render as `bytes N-(N-1)/N`, which is
  // not a valid Content-Range and which some clients read as a negative length.
  // R2 normally throws on an unsatisfiable range long before this (that path
  // degrades to a full 200 above), so this is a guard against a shape R2 is not
  // expected to produce rather than an observed case — but the invalid header
  // is worse than an honest 416.
  if (servedRange && servedRange.length === 0) {
    await objectBody.cancel().catch(() => {});
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${object.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  // Build headers
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Length': String(servedRange ? servedRange.length : object.size),
    // httpEtag is the quoted, RFC-valid form; `object.etag` is the raw hash.
    ETag: object.httpEtag,
    // Enables date-based validators (If-Modified-Since / If-Range date form).
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': route.cacheControl || 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
    [CACHE_STATUS_HEADER]: 'MISS',
  });
  if (servedRange) {
    const last = servedRange.offset + servedRange.length - 1;
    headers.set('Content-Range', `bytes ${servedRange.offset}-${last}/${object.size}`);
  }

  // Add Content-Disposition for downloadable files
  // Use route.forceDownload if explicitly set, otherwise fall back to content-type based logic
  const shouldDownload = route.forceDownload ?? shouldForceDownload(contentType);
  if (shouldDownload) {
    const filename = validation.sanitizedKey.split('/').pop() || 'download';
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  }

  // Streamed straight to the client with no cache write: any partial response.
  // A 206 must never enter caches.default — the entry is keyed on URL alone,
  // so one client's byte range would be replayed to every subsequent requester
  // as if it were the whole object.
  if (!cacheKey || servedRange) {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'R2 uncached serve',
        path: route.path,
        key: validation.sanitizedKey,
        bucket: bucketName,
        status: servedRange ? 206 : 200,
      }),
    );
    return new Response(objectBody, { headers, status: servedRange ? 206 : 200 });
  }

  // Stream the body using tee() to avoid buffering entire file in memory
  const [clientStream, cacheStream] = objectBody.tee();
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
      key: validation.sanitizedKey,
      bucket: bucketName,
    }),
  );

  return response;
}

// getContentTypeFromKey imported from @bifrost/shared

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
