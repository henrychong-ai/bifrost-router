import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AnalyticsQueryParams, PaginationQueryParams, AuditQueryParams } from '@/lib/schemas';

// =============================================================================
// Query Keys
// =============================================================================

export const analyticsKeys = {
  all: ['analytics'] as const,
  summary: (params?: AnalyticsQueryParams) => ['analytics', 'summary', params] as const,
  clicks: (params?: PaginationQueryParams) => ['analytics', 'clicks', params] as const,
  views: (params?: PaginationQueryParams) => ['analytics', 'views', params] as const,
  slugStats: (slug: string, params?: AnalyticsQueryParams) =>
    ['analytics', 'slug', slug, params] as const,
  downloads: (params?: PaginationQueryParams) => ['analytics', 'downloads', params] as const,
  downloadStats: (path: string, params?: AnalyticsQueryParams) =>
    ['analytics', 'download', path, params] as const,
  proxyRequests: (params?: PaginationQueryParams) => ['analytics', 'proxy', params] as const,
  proxyStats: (path: string, params?: AnalyticsQueryParams) =>
    ['analytics', 'proxyStats', path, params] as const,
  auditLogs: (params?: AuditQueryParams) => ['analytics', 'audit', params] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch analytics summary for dashboard
 */
export function useAnalyticsSummary(params: AnalyticsQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.summary(params),
    queryFn: () => api.analytics.summary(params),
  });
}

/**
 * Fetch paginated link clicks
 */
export function useClicks(params: PaginationQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.clicks(params),
    queryFn: () => api.analytics.clicks(params),
  });
}

/**
 * Fetch paginated page views
 */
export function useViews(params: PaginationQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.views(params),
    queryFn: () => api.analytics.views(params),
  });
}

/**
 * Fetch statistics for a specific slug
 */
export function useSlugStats(slug: string, params: AnalyticsQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.slugStats(slug, params),
    queryFn: () => api.analytics.slugStats(slug, params),
    enabled: !!slug,
  });
}

/**
 * Fetch paginated file downloads
 */
export function useDownloads(params: PaginationQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.downloads(params),
    queryFn: () => api.analytics.downloads(params),
  });
}

/**
 * Fetch statistics for a specific download path
 */
export function useDownloadStats(path: string, params: AnalyticsQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.downloadStats(path, params),
    queryFn: () => api.analytics.downloadStats(path, params),
    enabled: !!path,
  });
}

/**
 * Fetch paginated proxy requests
 */
export function useProxyRequests(params: PaginationQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.proxyRequests(params),
    queryFn: () => api.analytics.proxyRequests(params),
  });
}

/**
 * Fetch statistics for a specific proxy path
 */
export function useProxyStats(path: string, params: AnalyticsQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.proxyStats(path, params),
    queryFn: () => api.analytics.proxyStats(path, params),
    enabled: !!path,
  });
}

/**
 * Fetch paginated audit logs
 */
export function useAuditLogs(params: AuditQueryParams = {}) {
  return useQuery({
    queryKey: analyticsKeys.auditLogs(params),
    queryFn: () => api.analytics.auditLogs(params),
  });
}
