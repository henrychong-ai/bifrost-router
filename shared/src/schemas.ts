/**
 * Zod validation schemas for Bifrost
 *
 * These schemas are used for API request validation and
 * MCP tool input validation.
 */

import { z } from 'zod';
import { SUPPORTED_DOMAINS, R2_BUCKETS, ALL_R2_BUCKETS } from './types.js';

// =============================================================================
// Domain Schema
// =============================================================================

/**
 * Schema for supported domains
 */
export const DomainSchema = z
  .string()
  .optional()
  .refine(val => !val || SUPPORTED_DOMAINS.includes(val as (typeof SUPPORTED_DOMAINS)[number]), {
    message: `Domain must be one of: ${SUPPORTED_DOMAINS.join(', ')}`,
  });

// =============================================================================
// Route Schemas
// =============================================================================

/**
 * Route type enum schema
 */
export const RouteTypeSchema = z.enum(['redirect', 'proxy', 'r2']);

/**
 * HTTP redirect status code schema
 */
export const RedirectStatusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
  z.literal(308),
]);

/**
 * R2 bucket name schema
 */
export const R2BucketSchema = z.enum(R2_BUCKETS);

/**
 * Full route configuration schema (from API response)
 */
export const RouteSchema = z.object({
  path: z.string().min(1).startsWith('/').describe('URL path pattern (e.g., "/github", "/blog/*")'),
  type: RouteTypeSchema.describe('Route handler type'),
  target: z.string().min(1).describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP redirect status code'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
  createdAt: z.number().describe('Creation timestamp (Unix seconds)'),
  updatedAt: z.number().describe('Last update timestamp (Unix seconds)'),
});

/**
 * Schema for creating a new route
 */
export const CreateRouteInputSchema = z.object({
  path: z.string().min(1).startsWith('/').describe('URL path pattern starting with /'),
  type: RouteTypeSchema.describe('Route type: redirect, proxy, or r2'),
  target: z.string().min(1).describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP status code (301, 302, 307, 308)'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
});

/**
 * Schema for updating an existing route
 */
export const UpdateRouteInputSchema = z.object({
  type: RouteTypeSchema.optional().describe('Route type: redirect, proxy, or r2'),
  target: z.string().min(1).optional().describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP status code (301, 302, 307, 308)'),
  preserveQuery: z.boolean().optional().describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only)'),
  enabled: z.boolean().optional().describe('Enable/disable route'),
});

// =============================================================================
// Analytics Query Schemas
// =============================================================================

/**
 * Schema for analytics summary query params
 */
export const AnalyticsSummaryQuerySchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

/**
 * Schema for clicks/views list query params
 */
export const AnalyticsListQuerySchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(1000).optional().default(100).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  slug: z.string().optional().describe('Filter clicks by slug'),
  path: z.string().optional().describe('Filter views by path'),
  country: z
    .string()
    .length(2)
    .toUpperCase()
    .optional()
    .describe('Filter by country code (2-letter ISO)'),
});

/**
 * Schema for slug stats query params
 */
export const SlugStatsQuerySchema = z.object({
  slug: z.string().startsWith('/').describe('Link slug starting with /'),
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

// =============================================================================
// Routes List Query Schema
// =============================================================================

/**
 * Query parameters for listing routes with search and pagination
 */
export const RoutesListQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(1000).optional(),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().optional(),
  type: z.enum(['redirect', 'proxy', 'r2']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

// =============================================================================
// R2 Storage Schemas
// =============================================================================

export const AllR2BucketSchema = z.enum(ALL_R2_BUCKETS);

export const R2ListObjectsInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  prefix: z.string().optional().describe('Filter objects by key prefix'),
  cursor: z.string().optional().describe('Pagination cursor from a previous truncated response'),
  limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum objects to return (default: 100, max: 1000)'),
  delimiter: z.string().optional().describe('Delimiter for directory-like grouping (default: "/")'),
});

export const R2UploadInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) within the bucket'),
  content_base64: z.string().min(1).describe('Base64-encoded file content'),
  content_type: z.string().min(1).describe('MIME type of the file'),
  overwrite: z.boolean().optional().describe('Overwrite if object already exists (default: false)'),
});

export const R2RenameInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  old_key: z.string().min(1).describe('Current object key (path)'),
  new_key: z.string().min(1).describe('New object key (path)'),
});

export const R2MoveInputSchema = z.object({
  bucket: R2BucketSchema.describe('Source R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key to move'),
  destination_bucket: R2BucketSchema.describe('Destination R2 bucket name (read-write only)'),
  destination_key: z
    .string()
    .optional()
    .describe('New key in destination bucket (defaults to original key)'),
});

export const R2UpdateMetadataInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) to update metadata for'),
  content_type: z.string().optional().describe('New Content-Type'),
  cache_control: z.string().optional().describe('New Cache-Control header'),
  content_disposition: z.string().optional().describe('New Content-Disposition'),
});

export const R2ObjectKeyInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  key: z.string().min(1).describe('Object key (path) within the bucket'),
});

export const R2GetObjectInputSchema = z.object({
  bucket: AllR2BucketSchema.describe('R2 bucket name'),
  key: z.string().min(1).describe('Object key (path) within the bucket'),
  metadata_only: z
    .boolean()
    .optional()
    .describe('If true, return only metadata without downloading content (default: false)'),
});

export const R2DeleteObjectInputSchema = z.object({
  bucket: R2BucketSchema.describe('R2 bucket name (read-write only)'),
  key: z.string().min(1).describe('Object key (path) to delete'),
});

// =============================================================================
// MCP Tool Input Schemas
// =============================================================================

/**
 * list_routes tool input schema
 */
export const ListRoutesInputSchema = z.object({
  domain: DomainSchema.describe(
    "Target domain (e.g., 'link.henrychong.com'). Defaults to EDGE_ROUTER_DOMAIN env var.",
  ),
});

/**
 * get_route tool input schema
 */
export const GetRouteInputSchema = z.object({
  path: z.string().startsWith('/').describe('Route path starting with /'),
  domain: DomainSchema.describe('Target domain'),
});

/**
 * create_route tool input schema
 */
export const CreateRouteToolInputSchema = z.object({
  path: z.string().startsWith('/').describe('Route path starting with /'),
  type: RouteTypeSchema.describe('Route type: redirect, proxy, or r2'),
  target: z.string().min(1).describe('Target URL or R2 key'),
  statusCode: z.number().optional().describe('HTTP status (301/302/307/308) for redirects'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z
    .boolean()
    .optional()
    .default(false)
    .describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe(
    'R2 bucket for file serving (R2 only, default: "files")',
  ),
  domain: DomainSchema.describe('Target domain'),
});

/**
 * update_route tool input schema
 */
export const UpdateRouteToolInputSchema = z.object({
  path: z.string().startsWith('/').describe('Route path to update'),
  type: RouteTypeSchema.optional().describe('New route type'),
  target: z.string().min(1).optional().describe('New target URL or R2 key'),
  statusCode: z.number().optional().describe('New HTTP status code'),
  preserveQuery: z.boolean().optional().describe('New preserve query setting'),
  preservePath: z.boolean().optional().describe('New preserve path setting'),
  cacheControl: z.string().optional().describe('New Cache-Control header'),
  hostHeader: z.string().optional().describe('New Host header override for proxy routes'),
  forceDownload: z.boolean().optional().describe('New force download setting (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only)'),
  domain: DomainSchema.describe('Target domain'),
});

/**
 * delete_route tool input schema
 */
export const DeleteRouteInputSchema = z.object({
  path: z.string().startsWith('/').describe('Route path to delete'),
  domain: DomainSchema.describe('Target domain'),
});

/**
 * toggle_route tool input schema
 */
export const ToggleRouteInputSchema = z.object({
  path: z.string().startsWith('/').describe('Route path to toggle'),
  enabled: z.boolean().describe('Enable (true) or disable (false) the route'),
  domain: DomainSchema.describe('Target domain'),
});

/**
 * get_analytics_summary tool input schema
 */
export const GetAnalyticsSummaryInputSchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

/**
 * get_clicks tool input schema
 */
export const GetClicksInputSchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(100).optional().default(50).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  slug: z.string().optional().describe('Filter by specific slug'),
  country: z.string().length(2).optional().describe('Filter by country code'),
});

/**
 * get_views tool input schema
 */
export const GetViewsInputSchema = z.object({
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
  limit: z.number().min(1).max(100).optional().default(50).describe('Results per page'),
  offset: z.number().min(0).optional().default(0).describe('Pagination offset'),
  path: z.string().optional().describe('Filter by specific path'),
  country: z.string().length(2).optional().describe('Filter by country code'),
});

/**
 * get_slug_stats tool input schema
 */
export const GetSlugStatsInputSchema = z.object({
  slug: z.string().startsWith('/').describe("Link slug (e.g., '/linkedin')"),
  domain: DomainSchema.describe('Filter by domain'),
  days: z.number().min(1).max(365).optional().default(30).describe('Time range in days'),
});

// =============================================================================
// Inferred Types
// =============================================================================

export type Route = z.infer<typeof RouteSchema>;
export type CreateRouteInput = z.infer<typeof CreateRouteInputSchema>;
export type UpdateRouteInput = z.infer<typeof UpdateRouteInputSchema>;
export type ListRoutesInput = z.infer<typeof ListRoutesInputSchema>;
export type GetRouteInput = z.infer<typeof GetRouteInputSchema>;
export type CreateRouteToolInput = z.infer<typeof CreateRouteToolInputSchema>;
export type UpdateRouteToolInput = z.infer<typeof UpdateRouteToolInputSchema>;
export type DeleteRouteInput = z.infer<typeof DeleteRouteInputSchema>;
export type ToggleRouteInput = z.infer<typeof ToggleRouteInputSchema>;
export type GetAnalyticsSummaryInput = z.infer<typeof GetAnalyticsSummaryInputSchema>;
export type GetClicksInput = z.infer<typeof GetClicksInputSchema>;
export type GetViewsInput = z.infer<typeof GetViewsInputSchema>;
export type GetSlugStatsInput = z.infer<typeof GetSlugStatsInputSchema>;
export type RoutesListQuery = z.infer<typeof RoutesListQuerySchema>;
export type R2ListObjectsInput = z.infer<typeof R2ListObjectsInputSchema>;
export type R2UploadInput = z.infer<typeof R2UploadInputSchema>;
export type R2RenameInput = z.infer<typeof R2RenameInputSchema>;
export type R2MoveInput = z.infer<typeof R2MoveInputSchema>;
export type R2UpdateMetadataInput = z.infer<typeof R2UpdateMetadataInputSchema>;
export type R2ObjectKeyInput = z.infer<typeof R2ObjectKeyInputSchema>;
export type R2GetObjectInput = z.infer<typeof R2GetObjectInputSchema>;
export type R2DeleteObjectInput = z.infer<typeof R2DeleteObjectInputSchema>;

// =============================================================================
// Audit Log Schemas
// =============================================================================

/**
 * Audit action type schema - single source of truth for all audit actions
 */
export const AuditActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'toggle',
  'seed',
  'migrate',
  'r2_upload',
  'r2_delete',
  'r2_rename',
  'r2_metadata_update',
  'r2_move',
  'r2_replace',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

/**
 * Audit log entry schema
 */
export const AuditLogSchema = z.object({
  id: z.number(),
  domain: z.string(),
  action: AuditActionSchema,
  actorLogin: z.string().nullable(),
  actorName: z.string().nullable(),
  path: z.string().nullable(),
  details: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
});
