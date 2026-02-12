import type { Context } from 'hono';
import type { AppEnv, KVRouteConfig } from '../types';
import { getWildcardRemainder } from '../kv/lookup';
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
      { path: route.path, target: route.target, validationError: validation.error },
    );
  }

  const requestPath = c.req.path;

  // Calculate the target URL
  let targetPath: string;

  if (route.path.endsWith('/*')) {
    // Wildcard route: append remainder to target
    const remainder = getWildcardRemainder(requestPath, route.path);
    targetPath = remainder;
  } else {
    // Exact route: just use root of target
    targetPath = '/';
  }

  // Build full target URL using URL constructor for safe encoding
  const targetUrl = new URL(route.target);
  if (targetPath && targetPath !== '/') {
    const existingPath = targetUrl.pathname.replace(/\/$/, '');
    targetUrl.pathname = existingPath + targetPath;
  }

  // Preserve query string
  const requestUrl = new URL(c.req.url);
  if (requestUrl.search) {
    targetUrl.search = requestUrl.search;
  }
  const fullTargetUrl = targetUrl.toString();

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
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
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
        { path: route.path, target: route.target, timeoutMs },
      );
    }

    // Handle network errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    return createProxyErrorResponse(
      c,
      'network_error',
      `Failed to connect to upstream server: ${errorMessage}`,
      502,
      { path: route.path, target: route.target },
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
