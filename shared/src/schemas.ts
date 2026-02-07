/**
 * Zod validation schemas for Bifrost
 *
 * These schemas are used for API request validation and
 * MCP tool input validation.
 */

import { z } from 'zod';
import { SUPPORTED_DOMAINS, R2_BUCKETS } from './types.js';

// =============================================================================
// Domain Schema
// =============================================================================

/**
 * Schema for supported domains
 */
export const DomainSchema = z
  .string()
  .optional()
  .refine(
    (val) => !val || SUPPORTED_DOMAINS.includes(val as (typeof SUPPORTED_DOMAINS)[number]),
    {
      message: `Domain must be one of: ${SUPPORTED_DOMAINS.join(', ')}`,
    }
  );

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
  path: z
    .string()
    .min(1)
    .startsWith('/')
    .describe('URL path pattern (e.g., "/github", "/blog/*")'),
  type: RouteTypeSchema.describe('Route handler type'),
  target: z.string().min(1).describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP redirect status code'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z.boolean().optional().default(false).describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only, default: "files")'),
  enabled: z.boolean().optional().default(true).describe('Enable/disable route'),
  createdAt: z.number().describe('Creation timestamp (Unix seconds)'),
  updatedAt: z.number().describe('Last update timestamp (Unix seconds)'),
});

/**
 * Schema for creating a new route
 */
export const CreateRouteInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .startsWith('/')
    .describe('URL path pattern starting with /'),
  type: RouteTypeSchema.describe('Route type: redirect, proxy, or r2'),
  target: z.string().min(1).describe('Target URL or R2 object key'),
  statusCode: RedirectStatusCodeSchema.optional().describe('HTTP status code (301, 302, 307, 308)'),
  preserveQuery: z.boolean().optional().default(true).describe('Preserve query params on redirect'),
  preservePath: z.boolean().optional().default(false).describe('Preserve path for wildcard routes'),
  cacheControl: z.string().optional().describe('Cache-Control header value'),
  hostHeader: z.string().optional().describe('Override Host header for proxy requests'),
  forceDownload: z.boolean().optional().default(false).describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only, default: "files")'),
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
  forceDownload: z.boolean().optional().describe('Force browser to download instead of display inline (R2 only)'),
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
// MCP Tool Input Schemas
// =============================================================================

/**
 * list_routes tool input schema
 */
export const ListRoutesInputSchema = z.object({
  domain: DomainSchema.describe(
    "Target domain (e.g., 'link.example.com'). Defaults to EDGE_ROUTER_DOMAIN env var."
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
  forceDownload: z.boolean().optional().default(false).describe('Force browser to download instead of display inline (R2 only)'),
  bucket: R2BucketSchema.optional().describe('R2 bucket for file serving (R2 only, default: "files")'),
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

/**
 * Audit action type schema - single source of truth for all audit actions
 */
export const AuditActionSchema = z.enum(['create', 'update', 'delete', 'toggle', 'seed', 'migrate']);
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
