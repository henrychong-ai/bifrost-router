import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/**
 * Allowed CORS origins for admin API
 * Single source of truth - used by index.ts, admin.ts, and cors middleware
 */
export const ALLOWED_ORIGINS = [
  'https://bifrost.henrychong.com',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
] as const;

/**
 * Check if origin is allowed, including workers.dev for development
 * Returns the origin string if allowed, empty string if not
 * @param origin - The Origin header value
 * @param isDev - Whether to allow workers.dev origins (default: true for backwards compatibility)
 */
export function isAllowedOrigin(origin: string | undefined, isDev = true): string {
  if (!origin) return '';
  if ((ALLOWED_ORIGINS as readonly string[]).includes(origin)) return origin;

  // Allow workers.dev origins for development (wrangler dev --remote)
  if (isDev) {
    try {
      const url = new URL(origin);
      if (url.hostname.endsWith('.workers.dev')) return origin;
    } catch {
      // Invalid URL
    }
  }

  return '';
}

/**
 * Origin checker function type
 */
export type OriginChecker = (origin: string) => boolean;

/**
 * CORS configuration
 */
export interface CorsConfig {
  /** Allowed origins (use '*' for any, array of specific origins, or function) */
  origins: string | string[] | OriginChecker;
  /** Allowed HTTP methods */
  methods?: string[];
  /** Allowed headers */
  headers?: string[];
  /** Exposed headers */
  exposeHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache (seconds) */
  maxAge?: number;
}

/**
 * Default CORS configuration for admin API
 */
const DEFAULT_CONFIG: CorsConfig = {
  origins: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  headers: ['Content-Type', 'X-Admin-Key', 'Authorization'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: false,
  maxAge: 86400, // 24 hours
};

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin: string, allowed: string | string[] | OriginChecker): boolean {
  if (allowed === '*') return true;
  if (typeof allowed === 'function') return allowed(origin);
  if (typeof allowed === 'string') return origin === allowed;
  return allowed.includes(origin);
}

/**
 * Get the allowed origin for response
 */
function getAllowedOrigin(origin: string | null, config: CorsConfig): string {
  if (!origin) return config.origins === '*' ? '*' : '';

  if (config.origins === '*') return '*';

  if (isOriginAllowed(origin, config.origins)) {
    return origin;
  }

  return '';
}

/**
 * CORS middleware for Hono
 *
 * Handles CORS headers and preflight requests.
 *
 * @param config - CORS configuration
 * @returns Hono middleware function
 */
export function cors(config: Partial<CorsConfig> = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  return async function corsMiddleware(c: Context<AppEnv>, next: Next) {
    const origin = c.req.header('Origin') ?? null;
    const allowedOrigin = getAllowedOrigin(origin, finalConfig);

    // Handle preflight requests
    if (c.req.method === 'OPTIONS') {
      // Check if it's actually a CORS preflight
      const requestMethod = c.req.header('Access-Control-Request-Method');

      if (requestMethod) {
        const headers: Record<string, string> = {
          'Access-Control-Allow-Origin': allowedOrigin || '',
          'Access-Control-Allow-Methods': finalConfig.methods?.join(', ') || '',
          'Access-Control-Allow-Headers': finalConfig.headers?.join(', ') || '',
          'Access-Control-Max-Age': String(finalConfig.maxAge || 0),
        };

        if (finalConfig.credentials) {
          headers['Access-Control-Allow-Credentials'] = 'true';
        }

        return new Response(null, {
          status: 204,
          headers,
        });
      }
    }

    // Add CORS headers to actual response
    await next();

    // Set CORS headers on response
    if (allowedOrigin) {
      c.header('Access-Control-Allow-Origin', allowedOrigin);
    }

    if (finalConfig.exposeHeaders?.length) {
      c.header('Access-Control-Expose-Headers', finalConfig.exposeHeaders.join(', '));
    }

    if (finalConfig.credentials) {
      c.header('Access-Control-Allow-Credentials', 'true');
    }

    // Vary header for proper caching when origin-specific
    // Always set Vary for functions or arrays (not wildcard)
    if (finalConfig.origins !== '*') {
      c.header('Vary', 'Origin');
    }
  };
}
