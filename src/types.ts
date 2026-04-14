// =============================================================================
// R2 Bucket Configuration
// =============================================================================

/**
 * Available R2 buckets for file serving
 * Matches bucket_name values in wrangler.toml
 */
export const R2_BUCKETS = [
  'files',
  'assets',
  'files-user1',
  'files-user2',
  'files-user3',
  'files-user4',
  'files-user5',
  'files-user6',
] as const;

export type R2BucketName = (typeof R2_BUCKETS)[number];

/**
 * Check if a string is a valid R2 bucket name
 */
export function isValidR2Bucket(bucket: string): bucket is R2BucketName {
  return R2_BUCKETS.includes(bucket as R2BucketName);
}

/**
 * Mapping from bucket names to Worker binding names
 */
export const BUCKET_BINDINGS = {
  files: 'FILES_BUCKET',
  assets: 'ASSETS_BUCKET',
  'files-user1': 'FILES_USER1_BUCKET',
  'files-user2': 'FILES_USER2_BUCKET',
  'files-user3': 'FILES_USER3_BUCKET',
  'files-user4': 'FILES_USER4_BUCKET',
  'files-user5': 'FILES_USER5_BUCKET',
  'files-user6': 'FILES_USER6_BUCKET',
} as const satisfies Record<R2BucketName, string>;

export type BucketBindingName = (typeof BUCKET_BINDINGS)[R2BucketName];

export const ALL_BUCKET_BINDINGS = {
  ...BUCKET_BINDINGS,
  'bifrost-backups': 'BACKUP_BUCKET',
} as const;

// =============================================================================
// Supported Domains
// =============================================================================

/**
 * Supported domains for the edge router
 * Routes for these domains are stored in the unified ROUTES KV namespace
 */
export const SUPPORTED_DOMAINS = [
  'example.com',
  'links.example.com',
  'bifrost.example.com',
  'secondary.example.net',
  'user1.example.com',
  'user2.example.com',
  'user3.example.com',
  'couple.example.com',
  'user5.example.com',
] as const;

export type SupportedDomain = (typeof SUPPORTED_DOMAINS)[number];

/**
 * Check if a domain is supported
 */
export function isValidDomain(domain: string): domain is SupportedDomain {
  return SUPPORTED_DOMAINS.includes(domain as SupportedDomain);
}

// =============================================================================
// Cloudflare Zone Configuration (for Zone Cache Purge API)
// =============================================================================

/**
 * Cloudflare zone IDs for domains managed in this account.
 * Used by Zone Cache Purge API to invalidate CDN cache globally.
 */
export const CLOUDFLARE_ZONE_IDS: Record<string, string> = {
  // Configure with your zone IDs. Find them in Cloudflare Dashboard > Domain > Overview.
  // Example: 'example.com': 'your-zone-id-here',
};

/**
 * Get the Cloudflare zone ID for a given domain.
 * Walks up from subdomain to parent domain (e.g., links.example.com → example.com).
 * Returns undefined for domains not in the CF account.
 */
export function getZoneIdForDomain(domain: string): string | undefined {
  if (CLOUDFLARE_ZONE_IDS[domain]) return CLOUDFLARE_ZONE_IDS[domain];
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (CLOUDFLARE_ZONE_IDS[parent]) return CLOUDFLARE_ZONE_IDS[parent];
  }
  return undefined;
}

/**
 * R2 bucket custom domain mapping.
 * Maps bucket names to their Cloudflare custom domain(s).
 * Used for Zone Cache Purge API calls on R2 custom domain URLs.
 */
export const R2_BUCKET_CUSTOM_DOMAINS: Record<string, string[]> = {
  // Configure with your R2 custom domain URLs.
  // Example: files: ['files.example.com'],
};

/**
 * Get all custom domain URLs + zone IDs that need cache purging for an R2 object.
 * Returns URLs like https://files.example.com/path/to/file.png with their zone IDs.
 * Skips domains without a known zone ID.
 */
export function getR2CustomDomainUrls(
  bucket: string,
  key: string,
): { url: string; zoneId: string }[] {
  const domains = R2_BUCKET_CUSTOM_DOMAINS[bucket];
  if (!domains) return [];
  const encodedPath = encodeR2KeyAsPath(key);
  const results: { url: string; zoneId: string }[] = [];
  for (const domain of domains) {
    const zoneId = getZoneIdForDomain(domain);
    if (zoneId) {
      results.push({ url: `https://${domain}/${encodedPath}`, zoneId });
    }
  }
  return results;
}

/**
 * Encode an R2 key as a URL path, applying encodeURIComponent to each segment.
 * Preserves `/` as path separators while encoding special characters in each segment.
 * e.g., "docs/Q1 Report (2025).pdf" → "docs/Q1%20Report%20(2025).pdf"
 */
export function encodeR2KeyAsPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * Cloudflare Worker bindings for the edge router
 */
export type Bindings = {
  // Environment variables
  ENVIRONMENT: 'development' | 'production';
  VERSION: string;

  // Admin API domain (e.g., "bifrost.example.com")
  // The admin API is only accessible from this domain
  ADMIN_API_DOMAIN?: string;

  // Unified KV namespace for all routes (key format: {domain}:{path})
  ROUTES: KVNamespace;

  // D1 database for analytics
  DB: D1Database;

  // R2 copy size limit for rename/metadata operations (in MB, default: 100)
  R2_COPY_SIZE_LIMIT_MB?: string;

  // Admin API key (set as secret)
  ADMIN_API_KEY?: string;

  // R2 buckets for file serving
  FILES_BUCKET?: R2Bucket;
  ASSETS_BUCKET?: R2Bucket;
  FILES_USER1_BUCKET?: R2Bucket;
  FILES_USER2_BUCKET?: R2Bucket;
  FILES_USER3_BUCKET?: R2Bucket;
  FILES_USER4_BUCKET?: R2Bucket;
  FILES_USER5_BUCKET?: R2Bucket;
  FILES_USER6_BUCKET?: R2Bucket;

  // R2 bucket for automated backups (KV routes)
  BACKUP_BUCKET?: R2Bucket;

  // Cloudflare API token for Zone Cache Purge (optional, graceful degradation without it)
  CLOUDFLARE_API_TOKEN?: string;

  // Slack webhook URL for backup health alerts (optional)
  SLACK_BACKUP_WEBHOOK?: string;

  // Service Bindings for Worker-to-Worker calls
  EXAMPLE_SITE?: Fetcher;
};

/**
 * Service binding names for domain fallback
 */
export type ServiceBindingName = 'EXAMPLE_SITE';

/**
 * Domain to Service Binding fallback mapping
 * When no KV route matches, forward to the service binding
 */
export const DOMAIN_SERVICE_FALLBACK: Record<string, ServiceBindingName> = {
  'example.com': 'EXAMPLE_SITE',
};

/**
 * Get service binding for fallback (if configured)
 */
export function getServiceFallback(env: Bindings, hostname: string): Fetcher | undefined {
  const binding = DOMAIN_SERVICE_FALLBACK[hostname];
  if (!binding) return undefined;
  return env[binding];
}

/**
 * Hono app type with bindings
 */
export type AppEnv = {
  Bindings: Bindings;
};

/**
 * Route types supported by the router
 */
export type RouteType = 'redirect' | 'proxy' | 'r2';

/**
 * HTTP redirect status codes
 */
export type RedirectStatusCode = 301 | 302 | 307 | 308;

/**
 * Base route configuration fields
 */
interface BaseRouteConfig {
  /** Path pattern (e.g., "/github", "/blog/*") */
  path: string;

  /** Enable/disable route without deleting (default: true) */
  enabled?: boolean;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Redirect route configuration
 */
export interface RedirectRouteConfig extends BaseRouteConfig {
  type: 'redirect';
  /** Target URL to redirect to */
  target: string;
  /** HTTP status code for redirects (default: 302) */
  statusCode?: RedirectStatusCode;
  /** Preserve query params on redirect (default: true) */
  preserveQuery?: boolean;
  /** Preserve path for wildcard routes (default: false) */
  preservePath?: boolean;
}

/**
 * Proxy route configuration
 */
export interface ProxyRouteConfig extends BaseRouteConfig {
  type: 'proxy';
  /** Target URL to proxy to */
  target: string;
  /** Cache-Control header for proxied content */
  cacheControl?: string;
  /** Override Host header for proxy requests (e.g., "example.com" when proxying to cdn.webflow.com) */
  hostHeader?: string;
}

/**
 * R2 route configuration
 */
export interface R2RouteConfig extends BaseRouteConfig {
  type: 'r2';
  /** R2 object key */
  target: string;
  /** R2 bucket name (default: "files") */
  bucket?: R2BucketName;
  /** Cache-Control header for R2 content */
  cacheControl?: string;
  /** Force browser to download instead of display inline (default: false) */
  forceDownload?: boolean;
}

/**
 * Discriminated union of all route configurations
 * Use this for type-safe route handling
 */
export type TypedRouteConfig = RedirectRouteConfig | ProxyRouteConfig | R2RouteConfig;

/**
 * Route configuration stored in KV
 * Union type for backwards compatibility
 */
export interface KVRouteConfig {
  /** Path pattern (e.g., "/github", "/blog/*") */
  path: string;

  /** Route handler type */
  type: RouteType;

  /** Target URL (redirect/proxy) or R2 object key */
  target: string;

  /** HTTP status code for redirects (default: 302) */
  statusCode?: RedirectStatusCode;

  /** Preserve query params on redirect (default: true) */
  preserveQuery?: boolean;

  /** Preserve path for wildcard routes (default: false) */
  preservePath?: boolean;

  /** Cache-Control header for proxied/R2 content */
  cacheControl?: string;

  /** Override Host header for proxy requests (e.g., "example.com" when proxying to cdn.webflow.com) */
  hostHeader?: string;

  /** Force browser to download instead of display inline (R2 only, default: false) */
  forceDownload?: boolean;

  /** R2 bucket name for file serving (R2 only, default: "files") */
  bucket?: R2BucketName;

  /** Enable/disable route without deleting (default: true) */
  enabled?: boolean;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;
}

/**
 * Type guard for redirect routes
 */
export function isRedirectRoute(
  route: KVRouteConfig,
): route is KVRouteConfig & { type: 'redirect' } {
  return route.type === 'redirect';
}

/**
 * Type guard for proxy routes
 */
export function isProxyRoute(route: KVRouteConfig): route is KVRouteConfig & { type: 'proxy' } {
  return route.type === 'proxy';
}

/**
 * Type guard for R2 routes
 */
export function isR2Route(route: KVRouteConfig): route is KVRouteConfig & { type: 'r2' } {
  return route.type === 'r2';
}

/**
 * Route metadata stored in KV
 */
export interface RoutesMetadata {
  /** Schema version for migrations */
  version: string;

  /** Last update timestamp */
  updatedAt: number;

  /** Total route count */
  count: number;
}

/**
 * API response types
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
