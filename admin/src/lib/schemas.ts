import { z } from 'zod';
import {
  R2_BUCKETS,
  SUPPORTED_DOMAINS,
  AuditActionSchema,
  AuditLogSchema,
  type R2BucketName,
  type SupportedDomain,
  type AuditAction,
} from '@bifrost/shared';

// Re-export for convenience
export { R2_BUCKETS, SUPPORTED_DOMAINS };
export type { R2BucketName, SupportedDomain };

// =============================================================================
// R2 Bucket Configuration (imported from @bifrost/shared)
// =============================================================================

export const R2BucketSchema = z.enum(R2_BUCKETS);

// =============================================================================
// Route Schemas (matching src/types.ts and src/kv/schema.ts)
// =============================================================================

export const RouteTypeSchema = z.enum(['redirect', 'proxy', 'r2']);
export type RouteType = z.infer<typeof RouteTypeSchema>;

export const RedirectStatusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
  z.literal(308),
]);
export type RedirectStatusCode = z.infer<typeof RedirectStatusCodeSchema>;

export const RouteSchema = z.object({
  path: z.string().min(1),
  type: RouteTypeSchema,
  target: z.string().min(1),
  statusCode: RedirectStatusCodeSchema.optional(),
  preserveQuery: z.boolean().optional(),
  preservePath: z.boolean().optional(),
  cacheControl: z.string().optional(),
  hostHeader: z.string().optional(),
  forceDownload: z.boolean().optional(),
  bucket: R2BucketSchema.optional(),
  enabled: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // Domain field is included when fetching routes from all domains
  domain: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const CreateRouteSchema = z.object({
  path: z.string().min(1).regex(/^\//, 'Path must start with /'),
  type: RouteTypeSchema,
  target: z.string().min(1),
  statusCode: RedirectStatusCodeSchema.optional(),
  preserveQuery: z.boolean().optional(),
  preservePath: z.boolean().optional(),
  cacheControl: z.string().optional(),
  hostHeader: z.string().optional(),
  forceDownload: z.boolean().optional(),
  bucket: R2BucketSchema.optional(),
  enabled: z.boolean().optional(),
});
export type CreateRouteInput = z.infer<typeof CreateRouteSchema>;

export const UpdateRouteSchema = CreateRouteSchema.partial().omit({
  path: true,
});
export type UpdateRouteInput = z.infer<typeof UpdateRouteSchema>;

// =============================================================================
// Analytics Schemas (matching src/db/queries.ts)
// =============================================================================

export const TopItemSchema = z.object({
  name: z.string(),
  count: z.number(),
  extra: z.string().optional(),
});
export type TopItem = z.infer<typeof TopItemSchema>;

export const TimeSeriesPointSchema = z.object({
  date: z.string(),
  count: z.number(),
});
export type TimeSeriesPoint = z.infer<typeof TimeSeriesPointSchema>;

export const AnalyticsSummarySchema = z.object({
  period: z.string(),
  domain: z.string(),
  clicks: z.object({
    total: z.number(),
    uniqueSlugs: z.number(),
  }),
  views: z.object({
    total: z.number(),
    uniquePaths: z.number(),
  }),
  topClicks: z.array(TopItemSchema),
  topPages: z.array(TopItemSchema),
  topCountries: z.array(TopItemSchema),
  topReferrers: z.array(TopItemSchema),
  clicksByDay: z.array(TimeSeriesPointSchema),
  viewsByDay: z.array(TimeSeriesPointSchema),
  recentClicks: z.array(
    z.object({
      slug: z.string(),
      target: z.string(),
      country: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  recentViews: z.array(
    z.object({
      path: z.string(),
      country: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
});
export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;

export const LinkClickSchema = z.object({
  id: z.number(),
  domain: z.string(),
  slug: z.string(),
  targetUrl: z.string(),
  queryString: z.string().nullable(),
  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  colo: z.string().nullable(),
  continent: z.string().nullable(),
  httpProtocol: z.string().nullable(),
  timezone: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
});
export type LinkClick = z.infer<typeof LinkClickSchema>;

export const PageViewSchema = z.object({
  id: z.number(),
  domain: z.string(),
  path: z.string(),
  queryString: z.string().nullable(),
  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  colo: z.string().nullable(),
  continent: z.string().nullable(),
  httpProtocol: z.string().nullable(),
  timezone: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
});
export type PageView = z.infer<typeof PageViewSchema>;

export const PaginationMetaSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const SlugStatsSchema = z.object({
  slug: z.string(),
  totalClicks: z.number(),
  target: z.string().nullable(),
  clicksByDay: z.array(TimeSeriesPointSchema),
  topCountries: z.array(TopItemSchema),
  topReferrers: z.array(TopItemSchema),
});
export type SlugStats = z.infer<typeof SlugStatsSchema>;

// =============================================================================
// API Response Schemas
// =============================================================================

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  });

export const RoutesListResponseSchema = ApiResponseSchema(
  z.object({
    routes: z.array(RouteSchema),
  }),
);
export const RouteResponseSchema = ApiResponseSchema(RouteSchema);
export const AnalyticsSummaryResponseSchema = ApiResponseSchema(
  AnalyticsSummarySchema,
);

export const ClicksListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(LinkClickSchema),
  meta: PaginationMetaSchema,
  error: z.string().optional(),
});

export const ViewsListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(PageViewSchema),
  meta: PaginationMetaSchema,
  error: z.string().optional(),
});

export const SlugStatsResponseSchema = ApiResponseSchema(SlugStatsSchema);

// =============================================================================
// File Download Schemas
// =============================================================================

export const CacheStatusSchema = z.enum(['HIT', 'MISS']);
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

export const FileDownloadSchema = z.object({
  id: z.number(),
  domain: z.string(),
  path: z.string(),
  r2Key: z.string(),
  contentType: z.string().nullable(),
  fileSize: z.number().nullable(),
  cacheStatus: z.string().nullable(),
  queryString: z.string().nullable(),
  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  colo: z.string().nullable(),
  continent: z.string().nullable(),
  httpProtocol: z.string().nullable(),
  timezone: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
});
export type FileDownload = z.infer<typeof FileDownloadSchema>;

export const DownloadsListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(FileDownloadSchema),
  meta: PaginationMetaSchema,
  error: z.string().optional(),
});

export const DownloadStatsSchema = z.object({
  path: z.string(),
  totalDownloads: z.number(),
  totalBytes: z.number().nullable(),
  r2Key: z.string().nullable(),
  downloadsByDay: z.array(TimeSeriesPointSchema),
  topCountries: z.array(TopItemSchema),
  topReferrers: z.array(TopItemSchema),
});
export type DownloadStats = z.infer<typeof DownloadStatsSchema>;

export const DownloadStatsResponseSchema =
  ApiResponseSchema(DownloadStatsSchema);

// =============================================================================
// Proxy Request Schemas
// =============================================================================

export const ProxyRequestSchema = z.object({
  id: z.number(),
  domain: z.string(),
  path: z.string(),
  targetUrl: z.string(),
  responseStatus: z.number().nullable(),
  contentType: z.string().nullable(),
  contentLength: z.number().nullable(),
  queryString: z.string().nullable(),
  referrer: z.string().nullable(),
  userAgent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  colo: z.string().nullable(),
  continent: z.string().nullable(),
  httpProtocol: z.string().nullable(),
  timezone: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.number(),
});
export type ProxyRequest = z.infer<typeof ProxyRequestSchema>;

export const ProxyRequestsListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(ProxyRequestSchema),
  meta: PaginationMetaSchema,
  error: z.string().optional(),
});

export const ProxyStatsSchema = z.object({
  path: z.string(),
  totalRequests: z.number(),
  target: z.string().nullable(),
  requestsByDay: z.array(TimeSeriesPointSchema),
  statusCodes: z.array(TopItemSchema),
  topCountries: z.array(TopItemSchema),
  topReferrers: z.array(TopItemSchema),
});
export type ProxyStats = z.infer<typeof ProxyStatsSchema>;

export const ProxyStatsResponseSchema = ApiResponseSchema(ProxyStatsSchema);

// =============================================================================
// Audit Log Schemas (imported from @bifrost/shared)
// =============================================================================

// Re-export for convenience
export { AuditActionSchema, AuditLogSchema };
export type { AuditAction };
export type AuditLog = z.infer<typeof AuditLogSchema>;

export const AuditLogsListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(AuditLogSchema),
  meta: PaginationMetaSchema,
  error: z.string().optional(),
});

// =============================================================================
// Query Parameter Types
// =============================================================================

export interface AnalyticsQueryParams {
  domain?: string;
  days?: number;
}

export interface PaginationQueryParams {
  limit?: number;
  offset?: number;
  domain?: string;
  days?: number;
  slug?: string;
  path?: string;
  country?: string;
  targetUrl?: string;
  r2Key?: string;
}

export interface AuditQueryParams {
  limit?: number;
  offset?: number;
  domain?: string;
  days?: number;
  action?: AuditAction;
  actor?: string;
  path?: string;
}

// =============================================================================
// Domain Constants (imported from @bifrost/shared)
// =============================================================================

// DOMAINS is now SUPPORTED_DOMAINS from @bifrost/shared (re-exported above)
export const DOMAINS = SUPPORTED_DOMAINS;
export type Domain = SupportedDomain;
