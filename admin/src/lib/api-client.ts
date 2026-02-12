import { z } from 'zod';
import { env } from '@/env';
import {
  type Route,
  type CreateRouteInput,
  type UpdateRouteInput,
  type AnalyticsSummary,
  type LinkClick,
  type PageView,
  type FileDownload,
  type ProxyRequest,
  type AuditLog,
  type PaginationMeta,
  type SlugStats,
  type DownloadStats,
  type ProxyStats,
  type AnalyticsQueryParams,
  type PaginationQueryParams,
  type AuditQueryParams,
  RoutesListResponseSchema,
  RouteResponseSchema,
  AnalyticsSummaryResponseSchema,
  ClicksListResponseSchema,
  ViewsListResponseSchema,
  SlugStatsResponseSchema,
  DownloadsListResponseSchema,
  DownloadStatsResponseSchema,
  ProxyRequestsListResponseSchema,
  ProxyStatsResponseSchema,
  AuditLogsListResponseSchema,
} from './schemas';

// =============================================================================
// API Client Configuration
// =============================================================================

const API_BASE = env.VITE_API_URL;
const API_KEY = env.VITE_ADMIN_API_KEY;

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// =============================================================================
// Base Fetch Functions
// =============================================================================

async function fetchApi<T>(
  path: string,
  schema: z.ZodSchema<T>,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(path, API_BASE);

  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      'X-Admin-Key': API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return schema.parse(data);
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const filtered = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined,
  );
  if (filtered.length === 0) return '';
  return '?' + new URLSearchParams(filtered.map(([k, v]) => [k, String(v)])).toString();
}

// =============================================================================
// Routes API
// =============================================================================

export const routesApi = {
  /**
   * List all routes for a domain
   * @param domain - Optional domain to filter routes (defaults to henrychong.com)
   */
  async list(domain?: string): Promise<Route[]> {
    const query = domain ? buildQueryString({ domain }) : '';
    const response = await fetchApi(`/api/routes${query}`, RoutesListResponseSchema);
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch routes');
    }
    return response.data.routes;
  },

  /**
   * Get a single route by path
   * @param path - Route path to get
   * @param domain - Target domain for the route
   */
  async get(path: string, domain?: string): Promise<Route> {
    const query = buildQueryString({ path, domain });
    const response = await fetchApi(`/api/routes${query}`, RouteResponseSchema);
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'Route not found');
    }
    return response.data;
  },

  /**
   * Create a new route
   * @param data - Route configuration
   * @param domain - Target domain for the route
   */
  async create(data: CreateRouteInput, domain?: string): Promise<Route> {
    const query = domain ? buildQueryString({ domain }) : '';
    const response = await fetchApi(`/api/routes${query}`, RouteResponseSchema, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to create route');
    }
    return response.data;
  },

  /**
   * Update an existing route
   * @param path - Route path to update
   * @param data - Update data
   * @param domain - Target domain (required when viewing all domains)
   */
  async update(path: string, data: UpdateRouteInput, domain?: string): Promise<Route> {
    const query = buildQueryString({ path, domain });
    const response = await fetchApi(`/api/routes${query}`, RouteResponseSchema, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to update route');
    }
    return response.data;
  },

  /**
   * Delete a route
   * @param path - Route path to delete
   * @param domain - Target domain (required when viewing all domains)
   */
  async delete(path: string, domain?: string): Promise<void> {
    const query = buildQueryString({ path, domain });
    await fetchApi(
      `/api/routes${query}`,
      z.object({ success: z.boolean(), error: z.string().optional() }),
      { method: 'DELETE' },
    );
  },

  /**
   * Migrate a route to a new path
   * @param oldPath - Current route path
   * @param newPath - New route path
   * @param domain - Target domain
   */
  async migrate(oldPath: string, newPath: string, domain?: string): Promise<Route> {
    const query = buildQueryString({ oldPath, newPath, domain });
    const response = await fetchApi(`/api/routes/migrate${query}`, RouteResponseSchema, {
      method: 'POST',
    });
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to migrate route');
    }
    return response.data;
  },
};

// =============================================================================
// Analytics API
// =============================================================================

export const analyticsApi = {
  /**
   * Get analytics summary for dashboard
   */
  async summary(params: AnalyticsQueryParams = {}): Promise<AnalyticsSummary> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/summary${query}`,
      AnalyticsSummaryResponseSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch analytics summary');
    }
    return response.data;
  },

  /**
   * Get paginated list of link clicks
   */
  async clicks(params: PaginationQueryParams = {}): Promise<{
    items: LinkClick[];
    meta: PaginationMeta;
  }> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(`/api/analytics/clicks${query}`, ClicksListResponseSchema);
    if (!response.success) {
      throw new ApiError(500, response.error || 'Failed to fetch clicks');
    }
    return {
      items: response.data,
      meta: response.meta,
    };
  },

  /**
   * Get paginated list of page views
   */
  async views(params: PaginationQueryParams = {}): Promise<{
    items: PageView[];
    meta: PaginationMeta;
  }> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(`/api/analytics/views${query}`, ViewsListResponseSchema);
    if (!response.success) {
      throw new ApiError(500, response.error || 'Failed to fetch views');
    }
    return {
      items: response.data,
      meta: response.meta,
    };
  },

  /**
   * Get statistics for a specific slug
   */
  async slugStats(slug: string, params: AnalyticsQueryParams = {}): Promise<SlugStats> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/clicks/${encodeURIComponent(slug)}${query}`,
      SlugStatsResponseSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'Slug not found');
    }
    return response.data;
  },

  /**
   * Get paginated list of file downloads
   */
  async downloads(params: PaginationQueryParams = {}): Promise<{
    items: FileDownload[];
    meta: PaginationMeta;
  }> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/downloads${query}`,
      DownloadsListResponseSchema,
    );
    if (!response.success) {
      throw new ApiError(500, response.error || 'Failed to fetch downloads');
    }
    return {
      items: response.data,
      meta: response.meta,
    };
  },

  /**
   * Get statistics for a specific download path
   */
  async downloadStats(path: string, params: AnalyticsQueryParams = {}): Promise<DownloadStats> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/downloads/${encodeURIComponent(path)}${query}`,
      DownloadStatsResponseSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'Download path not found');
    }
    return response.data;
  },

  /**
   * Get paginated list of proxy requests
   */
  async proxyRequests(params: PaginationQueryParams = {}): Promise<{
    items: ProxyRequest[];
    meta: PaginationMeta;
  }> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/proxy${query}`,
      ProxyRequestsListResponseSchema,
    );
    if (!response.success) {
      throw new ApiError(500, response.error || 'Failed to fetch proxy requests');
    }
    return {
      items: response.data,
      meta: response.meta,
    };
  },

  /**
   * Get statistics for a specific proxy path
   */
  async proxyStats(path: string, params: AnalyticsQueryParams = {}): Promise<ProxyStats> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(
      `/api/analytics/proxy/${encodeURIComponent(path)}${query}`,
      ProxyStatsResponseSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'Proxy path not found');
    }
    return response.data;
  },

  /**
   * Get paginated list of audit logs
   */
  async auditLogs(params: AuditQueryParams = {}): Promise<{
    items: AuditLog[];
    meta: PaginationMeta;
  }> {
    const query = buildQueryString(params as Record<string, string | number | undefined>);
    const response = await fetchApi(`/api/analytics/audit${query}`, AuditLogsListResponseSchema);
    if (!response.success) {
      throw new ApiError(500, response.error || 'Failed to fetch audit logs');
    }
    return {
      items: response.data,
      meta: response.meta,
    };
  },
};

// =============================================================================
// Backup API
// =============================================================================

export const backupApi = {
  /**
   * Get backup health status
   * Backend always returns 200 — health status conveyed via JSON body field
   */
  async health(): Promise<BackupHealthResponse> {
    const url = new URL('/api/backups/health', API_BASE);

    const response = await fetch(url.toString(), {
      headers: {
        'X-Admin-Key': API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }

    return response.json();
  },
};

// =============================================================================
// Backup Health Types (matching backend schemas)
// =============================================================================

export interface BackupFileStatus {
  key: string;
  size: number;
  exists: boolean;
}

export interface D1TableInfo {
  name: string;
  rows: number;
}

export interface ManifestSummary {
  version: string;
  kv: {
    totalRoutes: number;
    domains: string[];
  };
  d1: {
    totalRows: number;
    tables: D1TableInfo[];
  };
}

export interface LastBackupInfo {
  date: string;
  timestamp: string;
  ageHours: number;
  manifest: ManifestSummary | null;
  files: BackupFileStatus[];
}

export interface HealthIssue {
  severity: 'warning' | 'critical';
  message: string;
}

export interface HealthChecks {
  backupExists: boolean;
  backupAge: 'ok' | 'warning' | 'critical';
  manifestValid: boolean;
  filesComplete: boolean;
  routeCountOk: boolean;
}

export interface BackupHealthResponse {
  status: 'healthy' | 'warning' | 'critical';
  timestamp: string;
  lastBackup: LastBackupInfo | null;
  issues: HealthIssue[];
  checks: HealthChecks;
}

// =============================================================================
// Metadata API
// =============================================================================

export interface OpenGraphData {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string | null;
}

const OpenGraphResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      title: z.string().nullable(),
      description: z.string().nullable(),
      image: z.string().nullable(),
      siteName: z.string().nullable(),
      url: z.string().nullable(),
    })
    .optional(),
  error: z.string().optional(),
});

export const metadataApi = {
  /**
   * Fetch Open Graph metadata for a URL
   * @param url - URL to fetch metadata from
   */
  async getOpenGraph(url: string): Promise<OpenGraphData> {
    const query = buildQueryString({ url });
    const response = await fetchApi(`/api/metadata/og${query}`, OpenGraphResponseSchema);
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to fetch metadata');
    }
    return response.data;
  },
};

// =============================================================================
// Combined API Export
// =============================================================================

export const api = {
  routes: routesApi,
  analytics: analyticsApi,
  backup: backupApi,
  metadata: metadataApi,
};

export { ApiError };
