import { z } from 'zod';
import { R2_BUCKETS } from '../types';

/**
 * KV key format for unified namespace
 *
 * Key format: {domain}:{path}
 * Example: henrychong.com:/linkedin
 *
 * Colon separator chosen because:
 * - Colon is not valid in domain names (reserved for port)
 * - Path always starts with /, making format unambiguous
 * - Easy to parse: key.split(':') gives [domain, path]
 */

/**
 * Build a KV key for a route
 * @param domain - The domain (e.g., "henrychong.com")
 * @param path - The route path (e.g., "/linkedin")
 */
export function routeKey(domain: string, path: string): string {
  return `${domain}:${path}`;
}

/**
 * Parse a KV key into domain and path
 * @param key - The KV key (e.g., "henrychong.com:/linkedin")
 * @returns [domain, path] tuple
 */
export function parseRouteKey(key: string): [string, string] {
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid route key format: ${key}`);
  }
  const domain = key.substring(0, colonIndex);
  const path = key.substring(colonIndex + 1);
  return [domain, path];
}

/**
 * Build a prefix for listing all routes for a domain
 * @param domain - The domain to get routes for
 */
export function domainPrefix(domain: string): string {
  return `${domain}:`;
}

/**
 * Zod schema for route configuration validation
 */
export const RouteConfigSchema = z.object({
  path: z.string().min(1).startsWith('/').describe('URL path pattern (e.g., "/github", "/blog/*")'),

  type: z.enum(['redirect', 'proxy', 'r2']).describe('Route handler type'),

  target: z.string().min(1).describe('Target URL or R2 object key'),

  statusCode: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .optional()
    .describe('HTTP redirect status code'),

  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),

  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),

  cacheControl: z.string().optional().describe('Cache-Control header value'),

  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),

  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),

  bucket: z
    .enum(R2_BUCKETS)
    .optional()
    .describe('R2 bucket for file serving (R2 only, default: "files")'),

  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
});

/**
 * Zod schema for creating a new route (no timestamps)
 */
export const CreateRouteSchema = RouteConfigSchema;

/**
 * Zod schema for updating a route (all fields optional except path)
 */
export const UpdateRouteSchema = RouteConfigSchema.partial().required({ path: true });

/**
 * Inferred types from Zod schemas
 */
export type CreateRouteInput = z.infer<typeof CreateRouteSchema>;
export type UpdateRouteInput = z.infer<typeof UpdateRouteSchema>;

/**
 * Current schema version for migrations
 */
export const SCHEMA_VERSION = '2.0.0';
