import { isRedirectStatusCode } from '@bifrost/shared';
import type { Context } from 'hono';
import { rawWildcardRemainder } from '../kv/lookup';
import type { AppEnv, KVRouteConfig, RedirectStatusCode } from '../types';

/**
 * The URL a redirect route sends a visitor of `incomingUrl` to: the target,
 * with the raw wildcard remainder appended when `preservePath` is set and the
 * incoming query merged in unless `preserveQuery` is false (a parameter the
 * target already has wins). Null when the request path cannot be aligned with
 * the route's base (the caller answers 404). Shared by the handler and the
 * in-process link preview (v1.37.2), so both send a visitor to the same place.
 * Throws when the stored target is not a URL.
 */
export function redirectDestination(route: KVRouteConfig, incomingUrl: URL): URL | null {
  const targetUrlObj = new URL(route.target);

  // 1. Preserve path for wildcard routes (if enabled)
  if (route.preservePath && route.path.endsWith('/*')) {
    const remainder = rawWildcardRemainder(incomingUrl.pathname, route.path);
    if (remainder === null) return null;

    // Append remainder to target, avoiding double slashes
    const basePath = targetUrlObj.pathname.replace(/\/$/, '');
    targetUrlObj.pathname = basePath + remainder;
  }

  // 2. Preserve query params (if enabled, default: true)
  if (route.preserveQuery !== false) {
    const incomingParams = incomingUrl.searchParams;

    // Only add params that don't already exist in target
    incomingParams.forEach((value, key) => {
      if (!targetUrlObj.searchParams.has(key)) {
        targetUrlObj.searchParams.set(key, value);
      }
    });
  }

  return targetUrlObj;
}

/**
 * The status a redirect route answers with (v1.38.0): its stored code when it
 * is one a write accepts (301, 302, 307, 308), else 302, the default. The
 * stored-route reader is tolerant, so a record written before today's rules
 * may hold any number; it is never passed raw to the response, where a 200
 * would answer an empty page and a value outside 200–599 would throw. Shared
 * by the handler and the in-process link preview.
 */
export function redirectStatus(route: Pick<KVRouteConfig, 'statusCode'>): RedirectStatusCode {
  const code: unknown = route.statusCode;
  return isRedirectStatusCode(code) ? code : 302;
}

/**
 * Handle redirect routes
 *
 * Features:
 * - Configurable status codes (301, 302, 307, 308; any other stored value answers 302)
 * - Path preservation for wildcard routes (optional, default: false)
 * - Query parameter preservation (optional, default: true)
 */
export function handleRedirect(c: Context<AppEnv>, route: KVRouteConfig): Response {
  const destination = redirectDestination(route, new URL(c.req.url));
  if (!destination) return c.json({ error: 'Not Found', path: c.req.path }, 404);
  return c.redirect(destination.toString(), redirectStatus(route));
}
