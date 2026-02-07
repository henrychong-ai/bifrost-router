import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Key prefix for KV storage */
  keyPrefix?: string;
}

/**
 * Default rate limit configuration
 */
const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
  keyPrefix: 'ratelimit:',
};

/**
 * Rate limit entry stored in KV
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Get client IP from request headers
 * Cloudflare provides the real client IP via CF-Connecting-IP
 */
function getClientIP(c: Context<AppEnv>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Create a rate limit key for KV
 */
function createRateLimitKey(prefix: string, identifier: string): string {
  // Sanitize identifier to avoid KV key issues
  const sanitized = identifier.replace(/[^a-zA-Z0-9.:]/g, '_');
  return `${prefix}${sanitized}`;
}

/**
 * Rate limiting middleware for Hono
 *
 * Uses Cloudflare KV for distributed rate limiting across edge locations.
 * Falls back to allowing requests if KV is unavailable (fail-open).
 *
 * @param config - Rate limit configuration
 * @returns Hono middleware function
 */
export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  return async function rateLimitMiddleware(c: Context<AppEnv>, next: Next) {
    // Use unified ROUTES KV namespace for rate limiting
    const kv = c.env.ROUTES;
    const clientIP = getClientIP(c);
    const key = createRateLimitKey(finalConfig.keyPrefix!, clientIP);

    const now = Date.now();
    const windowMs = finalConfig.windowSeconds * 1000;

    try {
      // Get current rate limit entry
      const existing = await kv.get<RateLimitEntry>(key, 'json');

      let entry: RateLimitEntry;

      if (!existing || now >= existing.resetAt) {
        // Create new window
        entry = {
          count: 1,
          resetAt: now + windowMs,
        };
      } else {
        // Increment existing window
        entry = {
          count: existing.count + 1,
          resetAt: existing.resetAt,
        };
      }

      // Check if rate limit exceeded
      if (entry.count > finalConfig.maxRequests) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

        return c.json(
          {
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter,
          },
          429,
          {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(finalConfig.maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
          }
        );
      }

      // Store updated entry (TTL = window + buffer)
      const ttlSeconds = finalConfig.windowSeconds + 10;
      await kv.put(key, JSON.stringify(entry), {
        expirationTtl: ttlSeconds,
      });

      // Add rate limit headers to response
      c.header('X-RateLimit-Limit', String(finalConfig.maxRequests));
      c.header('X-RateLimit-Remaining', String(finalConfig.maxRequests - entry.count));
      c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

      await next();
    } catch (error) {
      // Fail open - allow request if rate limiting fails
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Rate limiting error (failing open)',
          error: error instanceof Error ? error.message : String(error),
          clientIP,
        })
      );

      await next();
    }
  };
}

/**
 * Strict rate limiting middleware (fail-closed)
 *
 * Returns 503 if rate limiting infrastructure is unavailable.
 * Use this for critical endpoints where rate limiting is essential.
 */
export function rateLimitStrict(config: Partial<RateLimitConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  return async function rateLimitStrictMiddleware(c: Context<AppEnv>, next: Next) {
    // Use unified ROUTES KV namespace for rate limiting
    const kv = c.env.ROUTES;
    const clientIP = getClientIP(c);
    const key = createRateLimitKey(finalConfig.keyPrefix!, clientIP);

    const now = Date.now();
    const windowMs = finalConfig.windowSeconds * 1000;

    try {
      const existing = await kv.get<RateLimitEntry>(key, 'json');

      let entry: RateLimitEntry;

      if (!existing || now >= existing.resetAt) {
        entry = {
          count: 1,
          resetAt: now + windowMs,
        };
      } else {
        entry = {
          count: existing.count + 1,
          resetAt: existing.resetAt,
        };
      }

      if (entry.count > finalConfig.maxRequests) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

        return c.json(
          {
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter,
          },
          429,
          {
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(finalConfig.maxRequests),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(entry.resetAt / 1000)),
          }
        );
      }

      const ttlSeconds = finalConfig.windowSeconds + 10;
      await kv.put(key, JSON.stringify(entry), {
        expirationTtl: ttlSeconds,
      });

      c.header('X-RateLimit-Limit', String(finalConfig.maxRequests));
      c.header('X-RateLimit-Remaining', String(finalConfig.maxRequests - entry.count));
      c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

      await next();
    } catch (error) {
      // Fail closed - reject request if rate limiting fails
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Rate limiting error (failing closed)',
          error: error instanceof Error ? error.message : String(error),
          clientIP,
        })
      );

      return c.json(
        {
          error: 'Service Unavailable',
          message: 'Rate limiting service temporarily unavailable.',
        },
        503
      );
    }
  };
}
