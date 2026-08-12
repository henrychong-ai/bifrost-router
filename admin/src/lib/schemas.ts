import { z } from 'zod';
import {
  R2_BUCKETS,
  SUPPORTED_DOMAINS,
  AuditActionSchema,
  AuditLogSchema,
  AuditSourceSchema,
  QRCodeSchema,
  type QRCode,
  type R2BucketName,
  type SupportedDomain,
  type AuditAction,
  type AuditSource,
} from '@bifrost/shared';

// Re-export for convenience
export { R2_BUCKETS, SUPPORTED_DOMAINS, QRCodeSchema };
export type { R2BucketName, SupportedDomain, QRCode };

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

/**
 * Route with required domain field — used for by-target responses
 * where routes always include their domain
 */
export const RouteWithDomainSchema = RouteSchema.extend({
  domain: z.string(),
});
export type RouteWithDomain = z.infer<typeof RouteWithDomainSchema>;

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

export const TopClickSchema = z.object({
  domain: z.string(),
  path: z.string(),
  sourceUrl: z.string(),
  targetUrl: z.string(),
  count: z.number(),
  previousCount: z.number(),
  share: z.number().min(0).max(1),
  deltaPercent: z.number().nullable(),
  name: z.string(),
  extra: z.string(),
});
export type TopClick = z.infer<typeof TopClickSchema>;

export const TopProxySchema = z.object({
  domain: z.string(),
  path: z.string(),
  sourceUrl: z.string(),
  targetUrl: z.string(),
  count: z.number(),
  previousCount: z.number(),
  share: z.number().min(0).max(1),
  deltaPercent: z.number().nullable(),
});
export type TopProxy = z.infer<typeof TopProxySchema>;

export const TopPageSchema = z.object({
  domain: z.string(),
  path: z.string(),
  sourceUrl: z.string(),
  count: z.number(),
  previousCount: z.number(),
  share: z.number().min(0).max(1),
  deltaPercent: z.number().nullable(),
  name: z.string(),
});
export type TopPage = z.infer<typeof TopPageSchema>;

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
    previousTotal: z.number(),
    deltaPercent: z.number().nullable(),
    uniqueUrls: z.number(),
    uniqueSlugs: z.number(),
  }),
  views: z.object({
    total: z.number(),
    previousTotal: z.number(),
    deltaPercent: z.number().nullable(),
    uniqueUrls: z.number(),
    uniquePaths: z.number(),
  }),
  downloads: z.object({
    total: z.number(),
    previousTotal: z.number(),
    deltaPercent: z.number().nullable(),
    totalBytes: z.number(),
    cacheHitRate: z.number().min(0).max(1).nullable(),
  }),
  proxy: z.object({
    total: z.number(),
    previousTotal: z.number(),
    deltaPercent: z.number().nullable(),
    errorCount: z.number(),
    errorRate: z.number().min(0).max(1).nullable(),
  }),
  overview: z.object({
    recordedEvents: z.number(),
    previousRecordedEvents: z.number(),
    deltaPercent: z.number().nullable(),
    activeDomains: z.number(),
    uniqueUrls: z.number(),
  }),
  filters: z.object({
    days: z.number(),
    country: z.string().nullable(),
    search: z.string().nullable(),
    includeMonitoring: z.boolean(),
  }),
  monitoring: z.object({
    included: z.boolean(),
    classifier: z.literal('cloudflare-healthchecks'),
    rows: z.object({
      clicks: z.number(),
      views: z.number(),
      downloads: z.number(),
      proxy: z.number(),
      total: z.number(),
    }),
  }),
  coverage: z.object({
    status: z.literal('partial'),
    cutoverAt: z.number().nullable(),
    note: z.string(),
    unifiedTraffic: z.object({
      mode: z.enum(['off', 'shadow']),
      enabled: z.boolean(),
      retentionDays: z.number().int().positive().nullable(),
      recordedRequests: z.number(),
      reconciled: z.literal(false),
      includedInHeadline: z.literal(false),
    }),
    streams: z.object({
      clicks: z.string(),
      views: z.string(),
      downloads: z.string(),
      proxy: z.string(),
    }),
  }),
  topClicks: z.array(TopClickSchema),
  topProxies: z.array(TopProxySchema),
  topPages: z.array(TopPageSchema),
  topDomains: z.array(
    z.object({ domain: z.string(), count: z.number(), share: z.number().min(0).max(1) }),
  ),
  topCountries: z.array(TopItemSchema),
  topReferrers: z.array(TopItemSchema),
  clicksByDay: z.array(TimeSeriesPointSchema),
  viewsByDay: z.array(TimeSeriesPointSchema),
  activityByDay: z.array(
    z.object({
      date: z.string(),
      clicks: z.number(),
      views: z.number(),
      downloads: z.number(),
      proxy: z.number(),
      total: z.number(),
    }),
  ),
  recentClicks: z.array(
    z.object({
      domain: z.string(),
      slug: z.string(),
      path: z.string(),
      sourceUrl: z.string(),
      target: z.string(),
      targetUrl: z.string(),
      country: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  recentViews: z.array(
    z.object({
      domain: z.string(),
      path: z.string(),
      sourceUrl: z.string(),
      country: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  recentActivity: z.array(
    z.object({
      eventId: z.string(),
      type: z.enum(['click', 'view', 'download', 'proxy']),
      domain: z.string(),
      path: z.string(),
      sourceUrl: z.string(),
      targetUrl: z.string().nullable(),
      country: z.string().nullable(),
      createdAt: z.number(),
    }),
  ),
  insights: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['info', 'positive', 'warning']),
      title: z.string(),
      description: z.string(),
      href: z.string().nullable(),
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
    meta: z
      .object({
        version: z.string().optional(),
        updatedAt: z.number().optional(),
        count: z.number().optional(),
        total: z.number().optional(),
        offset: z.number().optional(),
        hasMore: z.boolean().optional(),
      })
      .optional(),
  }),
);
export const RouteResponseSchema = ApiResponseSchema(RouteSchema);
export const AnalyticsSummaryResponseSchema = ApiResponseSchema(AnalyticsSummarySchema);

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

export const DownloadStatsResponseSchema = ApiResponseSchema(DownloadStatsSchema);

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
export { AuditActionSchema, AuditLogSchema, AuditSourceSchema };
export type { AuditAction, AuditSource };
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
  country?: string;
  search?: string;
  includeMonitoring?: boolean;
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
  /** Source pipeline filter: bifrost | r2_event | cf_audit */
  source?: AuditSource;
}

// =============================================================================
// Domain Constants (imported from @bifrost/shared)
// =============================================================================

// DOMAINS is now SUPPORTED_DOMAINS from @bifrost/shared (re-exported above)
export const DOMAINS = SUPPORTED_DOMAINS;
export type Domain = SupportedDomain;
