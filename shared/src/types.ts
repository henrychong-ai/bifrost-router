/**
 * Shared types for Bifrost MCP server and Slackbot
 *
 * These types mirror the main Worker types but are decoupled from
 * Cloudflare-specific bindings for use in MCP and Slackbot clients.
 */

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

// =============================================================================
// Domain Configuration
// =============================================================================

/**
 * Supported domains for the edge router
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
export function isSupportedDomain(domain: string): domain is SupportedDomain {
  return SUPPORTED_DOMAINS.includes(domain as SupportedDomain);
}

// =============================================================================
// Route Types
// =============================================================================

/**
 * Route types supported by the router
 */
export type RouteType = 'redirect' | 'proxy' | 'r2';

/**
 * HTTP redirect status codes
 */
export type RedirectStatusCode = 301 | 302 | 307 | 308;

/**
 * Route configuration as stored in KV and returned by API
 */
export interface Route {
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

  /** Creation timestamp (Unix seconds) */
  createdAt: number;

  /** Last update timestamp (Unix seconds) */
  updatedAt: number;
}

/**
 * Input for creating a new route
 */
export interface CreateRouteInput {
  path: string;
  type: RouteType;
  target: string;
  statusCode?: RedirectStatusCode;
  preserveQuery?: boolean;
  preservePath?: boolean;
  cacheControl?: string;
  hostHeader?: string;
  forceDownload?: boolean;
  bucket?: R2BucketName;
  enabled?: boolean;
}

/**
 * Input for updating an existing route (path cannot be changed)
 */
export interface UpdateRouteInput {
  type?: RouteType;
  target?: string;
  statusCode?: RedirectStatusCode;
  preserveQuery?: boolean;
  preservePath?: boolean;
  cacheControl?: string;
  hostHeader?: string;
  forceDownload?: boolean;
  bucket?: R2BucketName;
  enabled?: boolean;
}

// =============================================================================
// R2 Storage Types
// =============================================================================

/**
 * All R2 buckets including read-only backup bucket
 */
export const ALL_R2_BUCKETS = [...R2_BUCKETS, 'bifrost-backups'] as const;
export type AllR2BucketName = (typeof ALL_R2_BUCKETS)[number];

/**
 * Read-only buckets (no write operations allowed)
 */
export const READ_ONLY_BUCKETS: readonly AllR2BucketName[] = ['bifrost-backups'];

/**
 * R2 object metadata
 */
export interface R2ObjectInfo {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    contentLanguage?: string;
    contentEncoding?: string;
  };
  customMetadata?: Record<string, string>;
}

/**
 * R2 list response
 */
export interface R2ListResponse {
  objects: R2ObjectInfo[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

/**
 * R2 buckets response
 */
export interface R2BucketsResponse {
  buckets: Array<{
    name: AllR2BucketName;
    access: 'read-write' | 'read-only';
  }>;
}

/**
 * R2 list objects query params
 */
export interface R2ListObjectsParams {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

/**
 * R2 update metadata params
 */
export interface R2UpdateMetadataParams {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
}

// =============================================================================
// Analytics Types
// =============================================================================

/**
 * Link click record from analytics database
 */
export interface LinkClick {
  id: number;
  domain: string;
  slug: string;
  targetUrl: string;
  queryString: string | null;
  referrer: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
  colo: string | null;
  continent: string | null;
  httpProtocol: string | null;
  timezone: string | null;
  ipAddress: string | null;
  createdAt: number;
}

/**
 * Page view record from analytics database
 */
export interface PageView {
  id: number;
  domain: string;
  path: string;
  queryString: string | null;
  referrer: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
  colo: string | null;
  continent: string | null;
  httpProtocol: string | null;
  timezone: string | null;
  ipAddress: string | null;
  createdAt: number;
}

/**
 * Top item with count (used in summaries)
 */
export interface TopItem {
  name: string;
  count: number;
  extra?: string;
}

/**
 * Time series data point
 */
export interface TimeSeriesPoint {
  date: string;
  count: number;
}

/**
 * Analytics summary response from /api/analytics/summary
 */
export interface AnalyticsSummary {
  period: string;
  domain: string;
  clicks: {
    total: number;
    uniqueSlugs: number;
  };
  views: {
    total: number;
    uniquePaths: number;
  };
  topClicks: TopItem[];
  topPages: TopItem[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
  clicksByDay: TimeSeriesPoint[];
  viewsByDay: TimeSeriesPoint[];
  recentClicks: Array<{
    slug: string;
    target: string;
    country: string | null;
    createdAt: number;
  }>;
  recentViews: Array<{
    path: string;
    country: string | null;
    createdAt: number;
  }>;
}

/**
 * Slug-specific statistics
 */
export interface SlugStats {
  slug: string;
  totalClicks: number;
  target: string | null;
  clicksByDay: TimeSeriesPoint[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
}

/**
 * Pagination metadata
 */
export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  meta: PaginationMeta;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

/**
 * API response with pagination
 */
export interface PaginatedApiResponse<T> {
  success: boolean;
  data?: T[];
  meta?: PaginationMeta;
  error?: string;
}

// =============================================================================
// Query Options
// =============================================================================

/**
 * Options for analytics queries
 */
export interface AnalyticsQueryOptions {
  /** Filter by domain */
  domain?: string;
  /** Time range in days (default: 30, max: 365) */
  days?: number;
  /** Results per page (default: 100, max: 1000) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Filter clicks by slug */
  slug?: string;
  /** Filter views by path */
  path?: string;
  /** Filter by country code (2-letter ISO) */
  country?: string;
}

// =============================================================================
// Permission Types (for Slackbot)
// =============================================================================

/**
 * Permission levels for domain access
 */
export type PermissionLevel = 'none' | 'read' | 'edit' | 'admin';

/**
 * Permission hierarchy (admin > edit > read > none)
 */
export const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  edit: 2,
  admin: 3,
};

/**
 * Check if a user has at least the required permission level
 */
export function hasPermission(userLevel: PermissionLevel, requiredLevel: PermissionLevel): boolean {
  return PERMISSION_HIERARCHY[userLevel] >= PERMISSION_HIERARCHY[requiredLevel];
}

/**
 * Tool permission requirements
 */
export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  // Read operations
  list_routes: 'read',
  get_route: 'read',
  get_analytics_summary: 'read',
  get_clicks: 'read',
  get_views: 'read',
  get_slug_stats: 'read',

  // Edit operations
  create_route: 'edit',
  update_route: 'edit',
  toggle_route: 'edit',

  // Admin operations
  delete_route: 'admin',

  // Storage operations
  list_buckets: 'read',
  list_objects: 'read',
  get_object_meta: 'read',
  get_object: 'read',
  upload_object: 'edit',
  rename_object: 'edit',
  move_object: 'edit',
  update_object_metadata: 'edit',
  delete_object: 'admin',
};

/**
 * Slack user permissions stored in KV
 */
export interface SlackUserPermissions {
  user_id: string;
  user_name: string;
  permissions: Record<string, PermissionLevel>;
  created_at: number;
  updated_at: number;
}
