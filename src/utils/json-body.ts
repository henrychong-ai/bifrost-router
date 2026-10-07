import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { CodedHTTPException } from './coded-http-exception';

/** The code and fixed messages of a body sent as a media type its endpoint does not take. */
export const UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE';
export const UNSUPPORTED_MEDIA_TYPE_MESSAGE =
  'The request body must be JSON, sent with Content-Type: application/json.';
export const MULTIPART_REQUIRED_MESSAGE = 'The request body must be a multipart/form-data upload.';

/** Whether a Content-Type names JSON (`application/json`, any parameters). */
export function isJsonContentType(value: string | undefined): boolean {
  return value !== undefined && /^\s*application\/json\s*(?:;|$)/i.test(value);
}

/** Whether a Content-Type names a multipart form (`multipart/form-data`, any parameters). */
export function isMultipartContentType(value: string | undefined): boolean {
  return value !== undefined && /^\s*multipart\/form-data\s*(?:;|$)/i.test(value);
}

/** The methods whose requests can carry a body the admin API reads. */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The admin endpoints that take a multipart upload, and only those (POST,
 * matched on the request path): a storage upload and a feedback submission.
 */
const MULTIPART_ENDPOINTS: readonly RegExp[] = [
  /^\/api\/storage\/[^/]+\/upload$/,
  /^\/api\/feedback$/,
];

/** Whether a POST to `path` is one of the multipart uploads. */
export function isMultipartEndpoint(method: string, path: string): boolean {
  return method === 'POST' && MULTIPART_ENDPOINTS.some(pattern => pattern.test(path));
}

/**
 * Whether `request` may carry a body: one with no body stream, or a declared
 * `Content-Length: 0`, does not. A body of unknown length may (see
 * {@link bodyHasBytes}).
 */
function hasBody(request: Request): boolean {
  if (request.body === null) return false;
  return request.headers.get('Content-Length')?.trim() !== '0';
}

/** How long the guard waits for a typeless body's first byte (v1.39.0). */
export const BODY_PEEK_TIMEOUT_MS = 5_000;

/**
 * Whether a body of unknown length holds at least one byte (v1.39.0): reads a
 * clone of the request up to its first non-empty chunk, then cancels the
 * clone, so the handler still reads the whole body. The runtime hands an
 * HTTP/2 POST or DELETE sent with neither `Content-Length` nor
 * `Content-Type` (a plain `curl -X POST` over HTTPS) a body stream that
 * holds nothing; that request has no body. A chunk of zero bytes proves
 * nothing, so reading goes on to the first byte or the end. A read that
 * fails, or a stream that neither yields a byte nor ends within
 * `timeoutMs`, counts as a body, so the guard refuses rather than waits or
 * passes it.
 */
export async function bodyHasBytes(
  request: Request,
  timeoutMs: number = BODY_PEEK_TIMEOUT_MS,
): Promise<boolean> {
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const peek = (async (): Promise<boolean> => {
    try {
      for (;;) {
        const chunk: ReadableStreamReadResult<unknown> = await reader.read();
        if (chunk.done) return false;
        // Anything but an empty byte view is a body
        if (!ArrayBuffer.isView(chunk.value) || chunk.value.byteLength > 0) return true;
      }
    } catch {
      return true;
    }
  })();
  try {
    return await Promise.race([peek, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Ends a read still pending at the deadline
    reader.cancel().catch(() => undefined);
  }
}

/**
 * The admin API's one body guard (v1.39.0), registered after authentication
 * and before every route, so no handler reads a body it has not passed: on
 * POST, PUT, PATCH and DELETE, a multipart upload endpoint (storage upload,
 * feedback submission) takes `multipart/form-data` only, and every other
 * endpoint takes `application/json` or no body at all (no body stream, a
 * `Content-Length: 0`, or, with no Content-Type, a stream that holds no
 * byte). Anything else answers 415
 * `{ success: false, error: 'UNSUPPORTED_MEDIA_TYPE', message }`.
 *
 * Defence in depth against cross-site requests: a page on another site can
 * make a browser send a `text/plain`, form or multipart POST without a CORS
 * preflight, but not an `application/json` one, and a form-encoded upload is
 * refused like any other non-multipart body. The admin key already stops
 * such a request at this Worker, and the dashboard's nginx refuses it before
 * adding the key; this makes the admin API refuse its shape too.
 */
export function requestBodyGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (BODY_METHODS.has(c.req.method)) {
      const contentType = c.req.header('Content-Type');
      if (isMultipartEndpoint(c.req.method, c.req.path)) {
        if (!isMultipartContentType(contentType)) {
          throw new CodedHTTPException(415, UNSUPPORTED_MEDIA_TYPE, MULTIPART_REQUIRED_MESSAGE);
        }
      } else if (
        hasBody(c.req.raw) &&
        !isJsonContentType(contentType) &&
        // With no Content-Type, an empty stream is no body (HTTP/2, above)
        (contentType !== undefined || (await bodyHasBytes(c.req.raw)))
      ) {
        throw new CodedHTTPException(415, UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_MEDIA_TYPE_MESSAGE);
      }
    }
    await next();
  };
}
