import { normalizeAnalyticsPath } from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/** Drop query strings and fragments from every persisted request log. */
export function privacySafeRequestPath(rawPath: string): string {
  return normalizeAnalyticsPath(rawPath.split(/[?#]/, 1)[0] || '/');
}

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
          path: privacySafeRequestPath(c.req.path),
          status,
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  };
}
