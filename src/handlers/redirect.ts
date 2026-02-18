import type { Context } from 'hono';
import type { AppEnv, KVRouteConfig } from '../types';
import { getWildcardRemainder } from '../kv/lookup';

/**
 * Handle redirect routes
 *
 * Features:
 * - Configurable status codes (301, 302, 307, 308)
 * - Path preservation for wildcard routes (optional, default: false)
 * - Query parameter preservation (optional, default: true)
 */
export function handleRedirect(
  c: Context<AppEnv>,
  route: KVRouteConfig,
): Response {
  const targetUrlObj = new URL(route.target);
  const incomingUrl = new URL(c.req.url);

  // 1. Preserve path for wildcard routes (if enabled)
  if (route.preservePath && route.path.endsWith('/*')) {
    const remainder = getWildcardRemainder(incomingUrl.pathname, route.path);

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

  return c.redirect(targetUrlObj.toString(), route.statusCode || 302);
}
