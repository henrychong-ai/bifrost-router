import type { Context } from 'hono';
import { rawWildcardRemainder } from '../kv/lookup';
import type { AppEnv, KVRouteConfig } from '../types';
import { redactRouteTarget } from '../utils/credential-redaction';
import { errorName } from '../utils/error-name';
import { withoutInternalHeaders } from '../utils/internal-headers';
import { validateProxyTarget } from '../utils/url-validation';

/**
 * Default proxy timeout in milliseconds (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Upstream redirects the proxy follows before giving up (v1.38.0): 20, the
 * Fetch standard's limit the runtime applied when it followed them, so every
 * redirect chain served before is served now. Each hop is checked against the
 * shared outbound host policy before it is fetched. The link preview has its
 * own, lower cap (`MAX_REDIRECTS`, 5, in `og-parser.ts`), also for a preview
 * of a proxy route; the two loops and caps are separate on purpose.
 */
export const MAX_PROXY_REDIRECTS = 20;

/** Statuses the proxy follows as redirects when they carry a Location (as fetch does). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * The only request headers a followed redirect carries to another origin
 * (v1.38.0), an ALLOW-list by exact name: content negotiation, the user
 * agent, caching, ranges and the five HTTP conditional headers. Everything
 * else stays behind: the visitor's credentials (Authorization, Cookie,
 * Proxy-Authorization), the route's Host override and any custom header, a
 * custom `If-…` header (`If-Api-Key`) included. Before v1.38.0 the runtime
 * followed redirects itself and, with the
 * `retain_authorization_on_cross_origin_redirect` flag, sent every header on.
 */
const CROSS_ORIGIN_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'range',
  'user-agent',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
]);

/**
 * `headers` reduced to what may go to another origin (CROSS_ORIGIN_HEADERS).
 * A followed redirect never carries a body (one that would need resending is
 * refused, any other becomes a bodiless GET), so no body header is kept.
 */
function crossOriginHeaders(headers: Headers): Headers {
  const kept = new Headers();
  for (const [name, value] of headers) {
    if (CROSS_ORIGIN_HEADERS.has(name)) kept.append(name, value);
  }
  return kept;
}

/**
 * Whether a redirect from `from` to `to` leaves the origin, for what the next
 * hop may carry (v1.39.0). A different origin does, except the one a host
 * makes to upgrade itself: http on the default port to https on the default
 * port, same host. That hop keeps the request headers and the route's Host
 * override, which a CDN target redirecting http to https needs; a downgrade
 * to http, another host or another port still leaves the origin.
 */
export function leavesOrigin(from: URL, to: URL): boolean {
  if (from.origin === to.origin) return false;
  const upgrade =
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    from.hostname === to.hostname &&
    from.port === '' &&
    to.port === '';
  return !upgrade;
}

/** Headers that describe a request body, dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
];

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
 * A path separator: ASCII, fullwidth (after NFKC), or a look-alike a
 * best-fit code-page conversion turns into one and no legitimate name needs
 * (∕ U+2215, ⁄ U+2044, ⧸ U+29F8, ∖ U+2216, ´ U+00B4). `¥` and `₩` stay
 * allowed (Japanese and Korean names): an accepted residual for a CP932 or
 * CP949 IIS upstream.
 */
const SEPARATOR = /[/\\\u2215\u2044\u29f8\u2216\u00b4]/;
/** A C0 control, DEL or a C1 control (U+0085 NEL among them). */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * A percent-escape a second decode would act on (`%hh` or `%u`), also with
 * `٪` (U+066A ARABIC PERCENT SIGN), which best-fit conversion turns into `%`
 * (the fullwidth and small forms `％` and `﹪` are caught on the NFKC variant).
 */
const RESIDUAL_ESCAPE = /[%\u066a](?:[0-9a-f]{2}|u)/i;

/**
 * Where a segment's name ends: path parameters (`;`), a re-split query or
 * fragment (`?`, `#`), or an NTFS stream name (`:`, and its best-fit
 * look-alikes `∶` U+2236 and `։` U+0589; `..:` and `..::$INDEX_ALLOCATION`
 * name the parent directory on Windows).
 */
const CORE_END = /[;?#:\u2236\u0589]/;
/**
 * A segment core (before any `;`, `?`, `#` or `:`, or a look-alike colon) that is empty or only dots,
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
 * included, and the best-fit look-alikes), a C0 control, DEL or C1 control, any `%hh` or `%u`,
 * with `%` or `٪` (so a second decode changes nothing), or a core (before
 * `;`, `?`, `#`, `:` or a look-alike colon) that is empty
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
    const core = text.split(CORE_END, 1)[0] ?? '';
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
 * - SSRF protection via URL validation, on the target and on every redirect
 *   hop (at most {@link MAX_PROXY_REDIRECTS}, v1.38.0)
 * - Timeout handling (default 30s, for the whole redirect chain)
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

  // Create AbortController for timeout (the whole redirect chain shares it)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare headers, optionally overriding Host
    let headers = filterProxyHeaders(c.req.raw.headers, c.env.ADMIN_API_KEY);
    if (route.hostHeader) {
      headers.set('Host', route.hostHeader);
    }

    // Redirects are followed here, not by the runtime (v1.38.0), so every hop
    // passes the shared outbound host policy before it is fetched: an allowed
    // upstream could otherwise redirect the Worker to a private address, and
    // the visitor's credentials no longer follow a redirect to another origin.
    let url = fullTargetUrl;
    let method = c.req.method;
    let body: ReadableStream | null = ['GET', 'HEAD'].includes(method) ? null : c.req.raw.body;
    let response: Response;
    for (let hop = 0; ; hop++) {
      response = await fetch(url, {
        method,
        headers,
        ...(body !== null && { body }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || location === null) break;

      // A redirect: its own body is never read
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_PROXY_REDIRECTS) {
        clearTimeout(timeoutId);
        return createProxyErrorResponse(
          c,
          'upstream_error',
          `The upstream server redirected more than ${MAX_PROXY_REDIRECTS} times.`,
          502,
          { path: route.path, target: redactRouteTarget(route.target) },
        );
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        clearTimeout(timeoutId);
        return createProxyErrorResponse(
          c,
          'upstream_error',
          'The upstream server sent an invalid redirect.',
          502,
          { path: route.path, target: redactRouteTarget(route.target) },
        );
      }
      const hopValidation = validateProxyTarget(next.href);
      if (!hopValidation.valid) {
        clearTimeout(timeoutId);
        return createProxyErrorResponse(
          c,
          'validation_error',
          'The proxy target is not allowed.',
          502,
          {
            path: route.path,
            target: redactRouteTarget(route.target),
            // Never the refused Location: an upstream can build it from the
            // visitor's remainder and query (log rule)
            validationError: hopValidation.error,
          },
        );
      }

      // As fetch does: a 303 (except for HEAD), or a 301/302 answering a
      // POST, becomes a GET without a body; any other redirect resends the
      // request as it was, which a body that has already streamed cannot do.
      const status = response.status;
      if (
        (status === 303 && method !== 'HEAD') ||
        ((status === 301 || status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = null;
        for (const header of BODY_HEADERS) headers.delete(header);
      } else if (body !== null) {
        clearTimeout(timeoutId);
        return createProxyErrorResponse(
          c,
          'network_error',
          'Failed to connect to upstream server: the redirect needs the request body sent again.',
          502,
          { path: route.path, target: redactRouteTarget(route.target) },
        );
      }
      // Leaving this hop's origin: only allow-listed headers go on (a
      // same-host upgrade to https keeps them, see leavesOrigin)
      if (leavesOrigin(new URL(url), next)) {
        headers = crossOriginHeaders(headers);
      }
      url = next.href;
    }

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

    // Handle network errors: the visitor gets a fixed message, never the
    // runtime's own text (it can name an upstream host or address); the error's
    // class name is logged
    return createProxyErrorResponse(
      c,
      'network_error',
      'Failed to connect to upstream server.',
      502,
      {
        path: route.path,
        target: redactRouteTarget(route.target),
        errorName: errorName(error),
      },
    );
  }
}

/**
 * Filter headers that shouldn't be forwarded to origin
 */
function filterProxyHeaders(headers: Headers, adminKey: string | undefined): Headers {
  // This deployment's own headers, and an Authorization carrying the admin
  // key, never go to an upstream, on any hop
  const filtered = withoutInternalHeaders(headers, adminKey);

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
