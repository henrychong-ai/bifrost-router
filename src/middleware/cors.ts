import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/**
 * The browser origins allowed to call the admin API cross-origin (v1.39.0):
 * none. The dashboard calls its own origin, and the server in front of it
 * (nginx in the containers, the Vite dev server under `pnpm dev`) calls the
 * Worker server to server, which CORS does not apply to; the MCP server and
 * the scripts are not browsers either. A deployer who builds a browser
 * client on another origin adds that origin here; the admin key is still
 * required on every request but the preflight.
 */
export const ADMIN_API_CORS_ORIGINS: readonly string[] = [];

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
    return undefined;
  };
}
