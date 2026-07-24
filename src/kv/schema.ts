import { z } from 'zod';
import { R2_BUCKETS } from '../types';

/**
 * KV key format for unified namespace
 *
 * Key format: {domain}:{path}
 * Example: example.com:/linkedin
 *
 * Colon separator chosen because:
 * - Colon is not valid in domain names (reserved for port)
 * - Path always starts with /, making format unambiguous
 * - Easy to parse: key.split(':') gives [domain, path]
 */

/**
 * Build a KV key for a route
 * @param domain - The domain (e.g., "example.com")
 * @param path - The route path (e.g., "/linkedin")
 */
export function routeKey(domain: string, path: string): string {
  return `${domain}:${path}`;
}

/**
 * Parse a KV key into domain and path
 * @param key - The KV key (e.g., "example.com:/linkedin")
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
export const UpdateRouteSchema = RouteConfigSchema.partial().required({
  path: true,
});

/**
 * Inferred types from Zod schemas
 */
export type CreateRouteInput = z.infer<typeof CreateRouteSchema>;
export type UpdateRouteInput = z.infer<typeof UpdateRouteSchema>;

/**
 * Current schema version for migrations
 */
export const SCHEMA_VERSION = '2.0.0';

// =============================================================================
// QR code keys (v1.30.0 — ported from upstream v1.54.0)
// =============================================================================

/**
 * Namespace prefix separating QR records from route keys in the shared KV
 * namespace. Route keys are `{domain}:{path}` and domains never contain ':',
 * so `qr:`-prefixed keys cannot collide with any route key — but full-namespace
 * scanners (getAllRoutesAllDomains, backups) must be aware of them.
 */
export const QR_KV_NAMESPACE = 'qr:';

/**
 * Build a KV key for a QR code record
 * @param domain - The domain the QR belongs to (e.g., "links.example.com")
 * @param id - The QR id (generated 12-char hex or user slug)
 */
export function qrKey(domain: string, id: string): string {
  return `${QR_KV_NAMESPACE}${domain}:${id}`;
}

/**
 * Parse a QR KV key into domain and id
 * @param key - The KV key (e.g., "qr:links.example.com:office-wifi")
 * @returns [domain, id] tuple
 */
export function parseQRKey(key: string): [string, string] {
  if (!key.startsWith(QR_KV_NAMESPACE)) {
    throw new Error(`Invalid QR key format: ${key}`);
  }
  const rest = key.substring(QR_KV_NAMESPACE.length);
  const colonIndex = rest.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid QR key format: ${key}`);
  }
  return [rest.substring(0, colonIndex), rest.substring(colonIndex + 1)];
}

/**
 * Build a prefix for listing all QR codes for a domain
 */
export function qrDomainPrefix(domain: string): string {
  return `${QR_KV_NAMESPACE}${domain}:`;
}
