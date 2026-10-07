import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { AppEnv } from '../types';

/**
 * One structured line per request (v1.39.0): the method, the ROUTE PATTERN
 * that answered (`/api/routes`, `/api/storage/:bucket/objects/:key{.+}`, or
 * `/*` for the router's catch-all), the status and the duration. Never the
 * request path or its query: a wildcard or proxy remainder, a storage key or
 * anything a visitor appends can carry a secret, and this line is written on
 * every request. The catch-all logs the matched route key on its own line
 * (`Route matched`).
 */
export function privacySafeRequestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (error) {
      status = error instanceof HTTPException ? error.status : 500;
      throw error;
    } finally {
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'request',
          method: c.req.method,
          // The pattern of the handler that answered (after next(), the
          // route index is the last one dispatched)
          route: routePath(c),
          status,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  };
}
