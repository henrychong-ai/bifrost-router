import { z } from 'zod';
import { env } from '@/env';
import {
  type Route,
  type RouteWithDomain,
  RouteWithDomainSchema,
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
  ApiResponseSchema,
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
const API_KEY = env.ADMIN_API_KEY;

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
   * List all routes for a domain with optional search and pagination
   * @param domain - Optional domain to filter routes (defaults to example.com)
   * @param options - Optional search, limit, and offset parameters
   */
  async list(
    domain?: string,
    options?: { search?: string; limit?: number; offset?: number },
  ): Promise<{
    routes: Route[];
    total: number;
    offset: number;
    hasMore: boolean;
  }> {
    const query = buildQueryString({
      domain,
      search: options?.search,
      limit: options?.limit,
      offset: options?.offset,
    });
    const response = await fetchApi(`/api/routes${query}`, RoutesListResponseSchema);
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch routes');
    }
    const meta = (response.data as Record<string, unknown>).meta as
      | { total?: number; offset?: number; hasMore?: boolean }
      | undefined;
    return {
      routes: response.data.routes,
      total: meta?.total ?? response.data.routes.length,
      offset: meta?.offset ?? 0,
      hasMore: meta?.hasMore ?? false,
    };
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

  /**
   * Transfer a route to a different domain
   * @param path - Route path
   * @param fromDomain - Current domain
   * @param toDomain - Target domain
   */
  async transfer(path: string, fromDomain: string, toDomain: string): Promise<Route> {
    const response = await fetchApi(`/api/routes/transfer`, RouteResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ path, fromDomain, toDomain }),
    });
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to transfer route');
    }
    return response.data;
  },

  /**
   * Find routes by R2 target (bucket + key)
   * @param bucket - R2 bucket name
   * @param target - R2 object key
   */
  async byTarget(bucket: string, target: string): Promise<RouteWithDomain[]> {
    const query = buildQueryString({ bucket, target });
    const response = await fetchApi(
      `/api/routes/by-target${query}`,
      ApiResponseSchema(z.object({ routes: z.array(RouteWithDomainSchema) })),
    );
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch routes by target');
    }
    return response.data.routes;
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

export interface ManifestSummary {
  version: string;
  kv: {
    totalRoutes: number;
    domains: string[];
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
// Storage API Types
// =============================================================================

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

export interface R2ListResponse {
  objects: R2ObjectInfo[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

export interface StorageListParams {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface R2MetadataUpdate {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
}

export interface R2BucketInfo {
  name: string;
  access: 'read-write' | 'read-only';
}

// =============================================================================
// Storage API
// =============================================================================

export const storageApi = {
  /**
   * List all available R2 buckets
   */
  async listBuckets(): Promise<R2BucketInfo[]> {
    const response = await fetchApi(
      '/api/storage/buckets',
      z.object({
        success: z.boolean(),
        data: z.object({
          buckets: z.array(
            z.object({
              name: z.string(),
              access: z.enum(['read-write', 'read-only']),
            }),
          ),
        }),
      }),
    );
    return response.data.buckets;
  },

  /**
   * List objects in a bucket with optional prefix filtering
   */
  async listObjects(bucket: string, params?: StorageListParams): Promise<R2ListResponse> {
    const query = buildQueryString({
      prefix: params?.prefix,
      cursor: params?.cursor,
      limit: params?.limit,
      delimiter: params?.delimiter,
    });
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/objects${query}`,
      z.object({
        success: z.boolean(),
        data: z.object({
          objects: z.array(
            z.object({
              key: z.string(),
              size: z.number(),
              etag: z.string(),
              uploaded: z.string(),
              httpMetadata: z
                .object({
                  contentType: z.string().optional(),
                  cacheControl: z.string().optional(),
                  contentDisposition: z.string().optional(),
                  contentLanguage: z.string().optional(),
                  contentEncoding: z.string().optional(),
                })
                .optional(),
              customMetadata: z.record(z.string(), z.string()).optional(),
            }),
          ),
          truncated: z.boolean(),
          cursor: z.string().optional(),
          delimitedPrefixes: z.array(z.string()),
        }),
      }),
    );
    return response.data;
  },

  /**
   * Get metadata for a specific object
   */
  async getObjectMeta(bucket: string, key: string): Promise<R2ObjectInfo> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/meta/${key}`,
      z.object({
        success: z.boolean(),
        data: z.object({
          key: z.string(),
          size: z.number(),
          etag: z.string(),
          uploaded: z.string(),
          httpMetadata: z
            .object({
              contentType: z.string().optional(),
              cacheControl: z.string().optional(),
              contentDisposition: z.string().optional(),
              contentLanguage: z.string().optional(),
              contentEncoding: z.string().optional(),
            })
            .optional(),
          customMetadata: z.record(z.string(), z.string()).optional(),
        }),
      }),
    );
    return response.data;
  },

  /**
   * Download an object as a blob
   */
  async downloadObject(bucket: string, key: string): Promise<Blob> {
    const url = new URL(`/api/storage/${encodeURIComponent(bucket)}/objects/${key}`, API_BASE);

    const response = await fetch(url.toString(), {
      headers: {
        'X-Admin-Key': API_KEY,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(
        response.status,
        (error as { error?: string }).error || `HTTP ${response.status}`,
      );
    }

    return response.blob();
  },

  /**
   * Upload a file to a bucket
   */
  async uploadObject(
    bucket: string,
    file: File,
    key: string,
    options?: { overwrite?: boolean },
  ): Promise<R2ObjectInfo> {
    const url = new URL(`/api/storage/${encodeURIComponent(bucket)}/upload`, API_BASE);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('key', key);
    if (options?.overwrite) {
      formData.append('overwrite', 'true');
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-Admin-Key': API_KEY,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(
        response.status,
        (error as { error?: string }).error || `HTTP ${response.status}`,
      );
    }

    const data = await response.json();
    return (data as { data: R2ObjectInfo }).data;
  },

  /**
   * Delete an object from a bucket
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/objects/${key}`,
      z.object({
        success: z.boolean(),
        message: z.string().optional(),
        error: z.string().optional(),
      }),
      { method: 'DELETE' },
    );
  },

  /**
   * Rename/move an object within a bucket
   */
  async renameObject(bucket: string, oldKey: string, newKey: string): Promise<R2ObjectInfo> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/rename`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            key: z.string(),
            size: z.number().optional(),
            etag: z.string().optional(),
            uploaded: z.string().optional(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      {
        method: 'POST',
        body: JSON.stringify({ oldKey, newKey }),
      },
    );
    return response.data as R2ObjectInfo;
  },

  /**
   * Move an object to a different bucket
   */
  async moveObject(
    bucket: string,
    key: string,
    destinationBucket: string,
    destinationKey?: string,
  ): Promise<R2ObjectInfo> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/move`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            key: z.string(),
            size: z.number().optional(),
            etag: z.string().optional(),
            uploaded: z.string().optional(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      {
        method: 'POST',
        body: JSON.stringify({ key, destinationBucket, destinationKey }),
      },
    );
    return response.data as R2ObjectInfo;
  },

  /**
   * Update object HTTP metadata
   */
  async updateObjectMetadata(
    bucket: string,
    key: string,
    metadata: R2MetadataUpdate,
  ): Promise<R2ObjectInfo> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/metadata/${key}`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            key: z.string(),
            size: z.number().optional(),
            etag: z.string().optional(),
            uploaded: z.string().optional(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      {
        method: 'PUT',
        body: JSON.stringify(metadata),
      },
    );
    return response.data as R2ObjectInfo;
  },

  /**
   * Purge CDN cache for an R2 object
   */
  async purgeCache(
    bucket: string,
    key: string,
  ): Promise<{ purged: number; failed: number; urls: string[] }> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/purge-cache/${encodeURIComponent(key)}`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            purged: z.number(),
            failed: z.number(),
            urls: z.array(z.string()),
          })
          .optional(),
        error: z.string().optional(),
      }),
      { method: 'POST' },
    );
    return response.data as { purged: number; failed: number; urls: string[] };
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
  storage: storageApi,
};

export { ApiError };
