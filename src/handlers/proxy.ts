import type { Context } from 'hono';
import { rawWildcardRemainder } from '../kv/lookup';
import type { AppEnv, KVRouteConfig } from '../types';
import { redactRouteTarget } from '../utils/credential-redaction';
import { validateProxyTarget } from '../utils/url-validation';

/**
 * Default proxy timeout in milliseconds (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Proxy error types for categorization
 */
export type ProxyErrorType = 'validation_error' | 'timeout' | 'network_error' | 'upstream_error';

/**
 * Create an error response for proxy failures
 */
function createProxyErrorResponse(
  c: Context<AppEnv>,
  type: ProxyErrorType,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>,
): Response {
  console.error(
    JSON.stringify({
      level: 'error',
      message: `Proxy ${type}`,
      details: message,
      ...details,
    }),
  );

  return c.json(
    {
      error: type === 'timeout' ? 'Gateway Timeout' : 'Bad Gateway',
      message,
      type,
    },
    statusCode as 502 | 504,
  );
}

/**
 * A path separator: ASCII, fullwidth (after NFKC), or a look-alike some
 * upstreams map to one (U+2215, U+2044, U+29F8, U+2216).
 */
const SEPARATOR = /[/\\\u2215\u2044\u29f8\u2216]/;
/** A C0 control, DEL or a C1 control (U+0085 NEL among them). */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A percent-escape a second decode would act on (`%hh` or `%u`). */
const RESIDUAL_ESCAPE = /%(?:[0-9a-f]{2}|u)/i;
/**
 * A segment core (before any `;`, `?` or `#`) that is empty or only dots,
 * spaces, `+`, Unicode whitespace, combining marks or ignorable code points:
 * something an upstream may trim, strip or collapse into `.` or `..`.
 */
const COLLAPSIBLE_CORE =
  /^[.+\s\p{White_Space}\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}\u1806]*$/u;
/**
 * Format and default-ignorable code points, which some upstreams drop, and
 * U+1806 (MONGOLIAN TODO SOFT HYPHEN), which StringPrep maps to nothing
 * though it is neither.
 */
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u1806]/gu;
/** Combining marks, which an upstream that strips accents drops after NFD. */
const COMBINING_MARK = /\p{M}/gu;

/**
 * The decoded text and every variant an upstream may derive from it by NFKC
 * normalisation, by dropping ignorable code points and by stripping combining
 * marks (NFD, then remove \p{M}), in any order: the closure of the text under
 * all three. An escape split by an ignorable code point or a mark
 * (`%\u200B2e`, `%\u03012e`) is only visible once it is dropped.
 */
function textVariants(decoded: string): string[] {
  const seen = new Set([decoded]);
  const queue = [decoded];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const variant of [
      next.normalize('NFKC'),
      next.replace(IGNORABLE, ''),
      next.normalize('NFD').replace(COMBINING_MARK, ''),
    ]) {
      if (!seen.has(variant)) {
        seen.add(variant);
        queue.push(variant);
      }
    }
  }
  return [...seen];
}

/**
 * Whether one raw remainder segment may be forwarded (v1.37.2). The segment
 * is forwarded exactly as the visitor sent it; what is checked is its text
 * once decoded, and every variant of that text under NFKC normalisation, the
 * dropping of ignorable code points and mark stripping (textVariants), since every upstream
 * acts on the decoded text (or on raw bytes that matter only when the decoded
 * text does). Refused: a malformed escape (a bare `%`, `%u`, invalid or
 * overlong UTF-8, Latin-1 bytes); in any variant, a `/` or `\\` (fullwidth
 * included, and the division-slash look-alikes), a C0 control, DEL or C1 control, any `%hh` or `%u` (so a second
 * decode changes nothing), or a core (before `;`, `?`, `#` or `:`) that is empty
 * or only dots, spaces, `+`, Unicode whitespace, combining marks or ignorable
 * code points. An empty segment is judged by its position in the path.
 */
function segmentAccepted(raw: string): boolean {
  if (raw === '') return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }
  for (const text of textVariants(decoded)) {
    if (SEPARATOR.test(text) || CONTROL.test(text) || RESIDUAL_ESCAPE.test(text)) return false;
    // `:` too: an NTFS stream suffix (`..::$INDEX_ALLOCATION`) is dropped
    const core = text.split(/[;?#:]/, 1)[0] ?? '';
    if (COLLAPSIBLE_CORE.test(core)) return false;
  }
  return true;
}

/**
 * The upstream URL a proxy route forwards `requestUrl` to, or null when the
 * request must be refused (the caller answers 404): a raw path that does not
 * align with the route's base (rawWildcardRemainder), a remainder that starts
 * with an empty segment, a segment segmentAccepted refuses, a path the URL
 * setter would change, or a result outside the target's base path. A
 * wildcard route appends the visitor's RAW remainder, byte for byte, to the
 * target's path; an exact route uses the target as is. The incoming query replaces the
 * target's unless `preserveQuery` is false, which drops it so no incoming
 * parameter reaches the upstream. Shared by the handler and the in-process
 * link preview (v1.37.2). The target must already have passed
 * validateProxyTarget.
 */
export function proxyDestination(route: KVRouteConfig, requestUrl: URL): URL | null {
  // Build full target URL using URL constructor for safe encoding
  const targetUrl = new URL(route.target);

  if (route.path.endsWith('/*')) {
    const rawRemainder = rawWildcardRemainder(requestUrl.pathname, route.path);
    if (rawRemainder === null) return null;
    const segments = rawRemainder.split('/').slice(1);
    // The remainder never starts with `//`: on a root target the upstream path
    // would read as another host to some upstreams
    if (segments.length > 1 && segments[0] === '') return null;
    if (!segments.every(segmentAccepted)) return null;
    const remainder = segments.length > 0 ? `/${segments.join('/')}` : '/';
    if (remainder !== '/') {
      const basePath = targetUrl.pathname.replace(/\/$/, '');
      const wanted = basePath + remainder;
      targetUrl.pathname = wanted;
      // The path sent is exactly the path checked: the URL setter may not
      // re-encode, resolve or otherwise change it
      if (targetUrl.pathname !== wanted) return null;
      const resolved = targetUrl.pathname;
      if (resolved.startsWith('//')) return null;
      if (resolved !== basePath && !resolved.startsWith(`${basePath}/`)) return null;
    }
  }

  // Preserve query string from original request (default: true). When a route
  // sets preserveQuery=false, drop ALL incoming query params so they never reach
  // the upstream (honours the dashboard toggle — previously ignored for proxy
  // routes — and lets an operator stop traversal/LFI-shaped query probes being
  // forwarded on routes that don't need a query string).
  if (route.preserveQuery !== false && requestUrl.search) {
    targetUrl.search = requestUrl.search;
  }
  return targetUrl;
}

/**
 * Handle proxy routes
 *
 * Features:
 * - Reverse proxy to target origin
 * - Path preservation for wildcard routes
 * - Configurable cache control
 * - Method and header forwarding
 * - SSRF protection via URL validation
 * - Timeout handling (default 30s)
 * - Graceful error handling for network failures
 */
export async function handleProxy(
  c: Context<AppEnv>,
  route: KVRouteConfig,
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate target URL for SSRF protection
  const validation = validateProxyTarget(route.target);
  if (!validation.valid) {
    return createProxyErrorResponse(
      c,
      'validation_error',
      'The proxy target is not allowed.',
      502,
      {
        path: route.path,
        target: redactRouteTarget(route.target),
        validationError: validation.error,
      },
    );
  }

  const destination = proxyDestination(route, new URL(c.req.url));
  if (!destination) {
    // A wildcard remainder that would leave the target's base path (v1.37.2)
    console.warn(
      JSON.stringify({ level: 'warn', message: 'Proxy path refused', path: route.path }),
    );
    return c.json({ error: 'Not Found', path: c.req.path }, 404);
  }
  const fullTargetUrl = destination.toString();

  // Create AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare headers, optionally overriding Host
    const headers = filterProxyHeaders(c.req.raw.headers);
    if (route.hostHeader) {
      headers.set('Host', route.hostHeader);
    }

    // Forward the request with timeout
    const response = await fetch(fullTargetUrl, {
      method: c.req.method,
      headers,
      ...(!['GET', 'HEAD'].includes(c.req.method) && { body: c.req.raw.body }),
      signal: controller.signal,
    });

    // Clear timeout on successful response
    clearTimeout(timeoutId);

    // Build response with optional cache control override
    const responseHeaders = new Headers(response.headers);

    if (route.cacheControl) {
      responseHeaders.set('Cache-Control', route.cacheControl);
    }

    // Add proxy indicator header
    responseHeaders.set('X-Proxied-By', 'bifrost');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    // Clear timeout on error
    clearTimeout(timeoutId);

    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      return createProxyErrorResponse(
        c,
        'timeout',
        `Upstream server did not respond within ${timeoutMs / 1000} seconds.`,
        504,
        { path: route.path, target: redactRouteTarget(route.target), timeoutMs },
      );
    }

    // Handle network errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createProxyErrorResponse(
      c,
      'network_error',
      `Failed to connect to upstream server: ${errorMessage}`,
      502,
      { path: route.path, target: redactRouteTarget(route.target) },
    );
  }
}

/**
 * Filter headers that shouldn't be forwarded to origin
 */
function filterProxyHeaders(headers: Headers): Headers {
  const filtered = new Headers(headers);

  // Remove Cloudflare-specific headers
  const headersToRemove = [
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'x-forwarded-proto',
    'x-real-ip',
  ];

  for (const header of headersToRemove) {
    filtered.delete(header);
  }

  return filtered;
}
