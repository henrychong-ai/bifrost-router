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
  'files-anjachong',
  'files-davidchong',
  'files-nadjachong',
  'files-sonjachong',
  'files-valeriehung',
  'files-vanessahung',
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
  'files-anjachong': 'FILES_ANJACHONG_BUCKET',
  'files-davidchong': 'FILES_DAVIDCHONG_BUCKET',
  'files-nadjachong': 'FILES_NADJACHONG_BUCKET',
  'files-sonjachong': 'FILES_SONJACHONG_BUCKET',
  'files-valeriehung': 'FILES_VALERIEHUNG_BUCKET',
  'files-vanessahung': 'FILES_VANESSAHUNG_BUCKET',
} as const satisfies Record<R2BucketName, string>;

export type BucketBindingName = (typeof BUCKET_BINDINGS)[R2BucketName];

// =============================================================================
// Supported Domains
// =============================================================================

/**
 * Supported domains for the edge router
 * Routes for these domains are stored in the unified ROUTES KV namespace
 */
export const SUPPORTED_DOMAINS = [
  'henrychong.com',
  'link.henrychong.com',
  'bifrost.henrychong.com',
  'vanessahung.net',
  'davidchong.co',
  'sonjachong.com',
  'anjachong.com',
  'kitkatcouple.com',
  'valeriehung.com',
] as const;

export type SupportedDomain = (typeof SUPPORTED_DOMAINS)[number];

/**
 * Check if a domain is supported
 */
export function isValidDomain(domain: string): domain is SupportedDomain {
  return SUPPORTED_DOMAINS.includes(domain as SupportedDomain);
}

/**
 * Cloudflare Worker bindings for the edge router
 */
export type Bindings = {
  // Environment variables
  ENVIRONMENT: 'development' | 'production';
  VERSION: string;

  // Admin API domain (e.g., "bifrost.henrychong.com")
  // The admin API is only accessible from this domain
  ADMIN_API_DOMAIN?: string;

  // Unified KV namespace for all routes (key format: {domain}:{path})
  ROUTES: KVNamespace;

  // D1 database for analytics
  DB: D1Database;

  // Admin API key (set as secret)
  ADMIN_API_KEY?: string;

  // R2 buckets for file serving
  FILES_BUCKET?: R2Bucket;
  ASSETS_BUCKET?: R2Bucket;
  FILES_ANJACHONG_BUCKET?: R2Bucket;
  FILES_DAVIDCHONG_BUCKET?: R2Bucket;
  FILES_NADJACHONG_BUCKET?: R2Bucket;
  FILES_SONJACHONG_BUCKET?: R2Bucket;
  FILES_VALERIEHUNG_BUCKET?: R2Bucket;
  FILES_VANESSAHUNG_BUCKET?: R2Bucket;

  // R2 bucket for automated backups (KV + D1)
  BACKUP_BUCKET?: R2Bucket;

  // Slack webhook URL for backup health alerts (optional)
  SLACK_BACKUP_WEBHOOK?: string;

  // Service Bindings for Worker-to-Worker calls
  HENRYCHONG_SITE?: Fetcher;
};

/**
 * Service binding names for domain fallback
 */
export type ServiceBindingName = 'HENRYCHONG_SITE';

/**
 * Domain to Service Binding fallback mapping
 * When no KV route matches, forward to the service binding
 */
export const DOMAIN_SERVICE_FALLBACK: Record<string, ServiceBindingName> = {
  'henrychong.com': 'HENRYCHONG_SITE',
};

/**
 * Get service binding for fallback (if configured)
 */
export function getServiceFallback(
  env: Bindings,
  hostname: string,
): Fetcher | undefined {
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
  /** Override Host header for proxy requests (e.g., "fusang.co" when proxying to cdn.webflow.com) */
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
export type TypedRouteConfig =
  | RedirectRouteConfig
  | ProxyRouteConfig
  | R2RouteConfig;

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

  /** Override Host header for proxy requests (e.g., "fusang.co" when proxying to cdn.webflow.com) */
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
export function isProxyRoute(
  route: KVRouteConfig,
): route is KVRouteConfig & { type: 'proxy' } {
  return route.type === 'proxy';
}

/**
 * Type guard for R2 routes
 */
export function isR2Route(
  route: KVRouteConfig,
): route is KVRouteConfig & { type: 'r2' } {
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
