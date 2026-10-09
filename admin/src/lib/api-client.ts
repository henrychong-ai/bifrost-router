import {
  type BackupFileStatus,
  type BackupHealthResponse,
  BackupHealthResponseSchema,
  capSearchParam,
  type FeedbackItem,
  type FeedbackListParams,
  type HealthChecks,
  type HealthIssue,
  type InvalidQRRow,
  InvalidQRRowSchema,
  type InvalidRouteRow,
  isInvalidQRRow,
  isInvalidRouteRow,
  type LastBackupInfo,
  type ManifestSummary,
  objectKeySegments,
  pathSegments,
  plainErrorText,
  readErrorEnvelope,
  StoredQRCodeSchema,
  type TriageFeedbackInput,
} from '@bifrost/shared';
import { z } from 'zod';
import { env } from '@/env';
import { ApiError, UNCONFIRMED_ANSWER_STATUS } from './api-error';
import { DASHBOARD_REQUEST_HEADER, DASHBOARD_REQUEST_VALUE } from './dashboard-request';
import {
  type AnalyticsQueryParams,
  type AnalyticsSummary,
  AnalyticsSummaryResponseSchema,
  ApiResponseSchema,
  type AuditLog,
  AuditLogsListResponseSchema,
  type AuditQueryParams,
  ClicksListResponseSchema,
  type CreateRouteInput,
  type DownloadStats,
  DownloadStatsResponseSchema,
  DownloadsListResponseSchema,
  type FileDownload,
  type LinkClick,
  type PageView,
  type PaginationMeta,
  type PaginationQueryParams,
  type ProxyRequest,
  ProxyRequestsListResponseSchema,
  type ProxyStats,
  ProxyStatsResponseSchema,
  type QRCode,
  type Route,
  RouteResponseSchema,
  RoutesListResponseSchema,
  type RouteWithDomain,
  RouteWithDomainSchema,
  type SlugStats,
  SlugStatsResponseSchema,
  type UpdateRouteInput,
  ViewsListResponseSchema,
} from './schemas';

// =============================================================================
// API Client Configuration
// =============================================================================

// Every call goes to the dashboard's own origin; nginx (or the Vite dev
// server) adds the admin key there. The dashboard never holds it (v1.39.0).
const API_BASE = env.API_ORIGIN;

// =============================================================================
// Base Fetch Functions
// =============================================================================

/**
 * Every API request the dashboard makes (v1.39.0): the caller's request with
 * the dashboard header set last, so no caller can drop it. The server in
 * front of the dashboard adds the admin key only to requests that carry it
 * (`./dashboard-request`), so a request without it is refused there with 403.
 */
function apiFetch(url: URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(DASHBOARD_REQUEST_HEADER, DASHBOARD_REQUEST_VALUE);
  return fetch(url.toString(), { ...init, headers });
}

/**
 * A failed response's error, through the ONE envelope reader the shared
 * client uses too (`readErrorEnvelope`, v1.38.0), so both agree on the code:
 * an UPPER_SNAKE value only (`QR_NOT_FOUND`, `ROUTE_RECORD_INVALID`,
 * `QR_ALREADY_EXISTS`). The dashboard shows the sentence (the message, else
 * `error`) and keeps the code beside it. A body that is not JSON (a plain
 * HTTPException message such as `Route not found: /x`) is shown as its text,
 * cut to a length; an empty one leaves the status to the caller.
 */
async function readErrorBody(
  response: Response,
): Promise<{ error?: string | undefined; code?: string | undefined; details?: unknown }> {
  const text = await response.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const plain = plainErrorText(text);
    return plain === undefined ? {} : { error: plain };
  }
  const envelope = readErrorEnvelope(body);
  if (envelope === null) return {};
  return { error: envelope.text ?? envelope.code, code: envelope.code, details: envelope.details };
}

/** A response as JSON, validated, or the ApiError a failed one carries. */
async function fetchApi<T>(
  path: string,
  schema: z.ZodSchema<T>,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(path, API_BASE);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Caller headers win, in any HeadersInit form (a spread would drop a Headers
  // instance or an entry list).
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  const response = await apiFetch(url, { ...options, headers });

  if (!response.ok) {
    const error = await readErrorBody(response);
    throw new ApiError(response.status, error.error || `HTTP ${response.status}`, error.details, {
      code: error.code,
    });
  }

  const data: unknown = await response.json();
  return schema.parse(data);
}

/**
 * A route path or slug (`pathSegments`) or an object key (`objectKeySegments`)
 * as URL path segments (v1.39.0): the shared rules (`@bifrost/shared`), also
 * the API client's. Every key or path in a URL goes through one of them: a raw
 * key's `#`, `?`, backslash or `%2e` would address another object, and a whole
 * value through `encodeURIComponent` carries `%2F`, which the dashboard's /api
 * proxy refuses. An object key is sent exactly or not at all: one with a
 * leading slash, an empty segment or a segment of only dots throws
 * (`UNADDRESSABLE_OBJECT_KEY`), and the page reports that message.
 */
export { objectKeySegments, pathSegments };

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const filtered = Object.entries(params).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  );
  if (filtered.length === 0) return '';
  return '?' + new URLSearchParams(filtered.map(([k, v]) => [k, String(v)])).toString();
}

/**
 * A route write answered 2xx without confirming it (`success: false`, or no
 * route where one is due; v1.41.2): the server did not refuse the request, so
 * whether the write landed is unknown. The error carries no HTTP status of
 * its own (`UNCONFIRMED_ANSWER_STATUS`), so the route hooks read it as
 * uncertain (`isUncertainAnswer`: they drop what they knew and refetch), and
 * the QR editor marks a route create's retry for the read-back, never as a
 * 4xx refusal that changed nothing.
 */
function unconfirmedRouteWrite(message: string): ApiError {
  return new ApiError(UNCONFIRMED_ANSWER_STATUS, message);
}

/**
 * The one check every route write's 2xx answer passes (v1.41.2): it must say
 * `success`, or the write is unconfirmed ({@link unconfirmedRouteWrite}). The
 * deletes (the ordinary one and the recovery) need nothing more.
 */
function confirmRouteWrite(
  answer: { success: boolean; error?: string | undefined },
  fallback: string,
): void {
  if (!answer.success) throw unconfirmedRouteWrite(answer.error || fallback);
}

/**
 * A route write that answers with the route (create, update, migrate,
 * transfer): {@link confirmRouteWrite}, and the route itself, or the write is
 * unconfirmed.
 */
function confirmedRoute<T>(
  answer: { success: boolean; data?: T | undefined; error?: string | undefined },
  fallback: string,
): T {
  confirmRouteWrite(answer, fallback);
  if (!answer.data) throw unconfirmedRouteWrite(answer.error || fallback);
  return answer.data;
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
    /**
     * The page's rows for stored records that cannot be read (v1.38.0): only
     * the Routes page shows them (flagged, Delete only); every other reader
     * of `routes` never sees one.
     */
    invalidRoutes: InvalidRouteRow[];
    total: number;
    offset: number;
    hasMore: boolean;
  }> {
    const query = buildQueryString({
      domain,
      // Cut to the API's 2,048-unit bound (v1.38.0), so a long paste still
      // returns results instead of a 400
      search: options?.search === undefined ? undefined : capSearchParam(options.search),
      limit: options?.limit,
      offset: options?.offset,
    });
    const response = await fetchApi(`/api/routes${query}`, RoutesListResponseSchema);
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch routes');
    }
    const meta = (response.data as Record<string, unknown>)['meta'] as
      | { total?: number; offset?: number; hasMore?: boolean }
      | undefined;
    const routes: Route[] = [];
    const invalidRoutes: InvalidRouteRow[] = [];
    for (const row of response.data.routes) {
      if (isInvalidRouteRow(row)) invalidRoutes.push(row);
      else routes.push(row);
    }
    return {
      routes,
      invalidRoutes,
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
   * @param domain - Target domain for the route. Required: the API refuses a
   *   write that names no domain.
   */
  async create(
    data: CreateRouteInput,
    domain: string,
    acknowledgeCredentialTarget?: boolean,
  ): Promise<Route> {
    const query = buildQueryString({ domain });
    // Request-only override, never part of the stored route — the Worker reads
    // it off the raw body and Zod strips it before KV.
    const response = await fetchApi(`/api/routes${query}`, RouteResponseSchema, {
      method: 'POST',
      body: JSON.stringify(
        acknowledgeCredentialTarget ? { ...data, acknowledgeCredentialTarget } : data,
      ),
    });
    return confirmedRoute(response, 'Failed to create route');
  },

  /**
   * Update an existing route
   * @param path - Route path to update
   * @param data - Update data
   * @param domain - Target domain (required; the route's own in the all-domains view)
   * @param expectedUpdatedAt - The `updatedAt` of the route as loaded (v1.40.0): the
   *   Worker refuses the edit with 409 `ROUTE_SOURCE_CHANGED` if the route has changed since
   */
  async update(
    path: string,
    data: UpdateRouteInput,
    domain: string,
    acknowledgeCredentialTarget?: boolean,
    expectedUpdatedAt?: number,
  ): Promise<Route> {
    const query = buildQueryString({ path, domain });
    const response = await fetchApi(`/api/routes${query}`, RouteResponseSchema, {
      method: 'PUT',
      body: JSON.stringify({
        ...data,
        ...(acknowledgeCredentialTarget && { acknowledgeCredentialTarget }),
        ...(expectedUpdatedAt !== undefined && { expectedUpdatedAt }),
      }),
    });
    return confirmedRoute(response, 'Failed to update route');
  },

  /**
   * Delete a route
   * @param path - Route path to delete (the stored key's own path for a recovery)
   * @param domain - Target domain (required; the route's own in the all-domains view)
   */
  async delete(
    path: string,
    domain: string,
    options: { recoverInvalid?: boolean } = {},
  ): Promise<void> {
    // `recoverInvalid` (v1.38.0): delete the record at EXACTLY this key, only
    // when it cannot be read — the recovery for a listed unreadable record,
    // whose path may not round-trip through the ordinary delete's normalising
    const query = buildQueryString({
      path,
      domain,
      ...(options.recoverInvalid ? { recover: 'invalid' } : {}),
    });
    const response = await fetchApi(
      `/api/routes${query}`,
      z.object({ success: z.boolean(), error: z.string().optional() }),
      { method: 'DELETE' },
    );
    // A 2xx saying `success: false` confirms nothing (v1.41.2): it was taken
    // as a delete before
    confirmRouteWrite(
      response,
      options.recoverInvalid ? 'Failed to delete the unreadable record' : 'Failed to delete route',
    );
  },

  /**
   * Migrate a route to a new path, with the rest of an edit in the same write
   * @param oldPath - Current route path
   * @param newPath - New route path
   * @param domain - Target domain
   * @param updates - Other changed fields, applied to the moved record
   * @param acknowledgeCredentialTarget - Set only after the credential confirmation
   */
  async migrate(
    oldPath: string,
    newPath: string,
    domain: string,
    updates: UpdateRouteInput = {},
    acknowledgeCredentialTarget?: boolean,
    expectedUpdatedAt?: number,
  ): Promise<Route> {
    const query = buildQueryString({ oldPath, newPath, domain });
    // The rest of the edit goes in the same request (v1.38.0): the Worker
    // writes the moved record once, with the updates merged, so a second
    // write to the new key can never be lost to KV's one-write-per-second
    // limit. No updates: no body, the record moves unedited.
    const body = {
      ...updates,
      ...(acknowledgeCredentialTarget ? { acknowledgeCredentialTarget } : {}),
      // The source's updatedAt as loaded (v1.40.0): a route changed since is
      // refused (409 ROUTE_SOURCE_CHANGED) and nothing moves
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
    };
    const response = await fetchApi(`/api/routes/migrate${query}`, RouteResponseSchema, {
      method: 'POST',
      ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {}),
    });
    return confirmedRoute(response, 'Failed to migrate route');
  },

  /**
   * Transfer a route to a different domain
   * @param path - Route path
   * @param fromDomain - Current domain
   * @param toDomain - Target domain
   */
  async transfer(
    path: string,
    fromDomain: string,
    toDomain: string,
    acknowledgeCredentialTarget?: boolean,
  ): Promise<Route> {
    const response = await fetchApi(`/api/routes/transfer`, RouteResponseSchema, {
      method: 'POST',
      // A transfer re-publishes the target to a new audience, so it needs its
      // own acknowledgement.
      body: JSON.stringify({
        path,
        fromDomain,
        toDomain,
        ...(acknowledgeCredentialTarget ? { acknowledgeCredentialTarget } : {}),
      }),
    });
    return confirmedRoute(response, 'Failed to transfer route');
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
    const query = buildQueryString(params as Record<string, string | number | boolean | undefined>);
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
      `/api/analytics/clicks/${pathSegments(slug)}${query}`,
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
      `/api/analytics/downloads/${pathSegments(path)}${query}`,
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
      `/api/analytics/proxy/${pathSegments(path)}${query}`,
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

    const response = await apiFetch(url, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    return BackupHealthResponseSchema.parse(data);
  },
};

// =============================================================================
// Backup Health Types: one definition in `@bifrost/shared` (v1.38.0), the
// schemas the Worker builds the answer with
// =============================================================================

export type {
  BackupFileStatus,
  BackupHealthResponse,
  HealthChecks,
  HealthIssue,
  LastBackupInfo,
  ManifestSummary,
};

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
  comment?: string;
  commentUpdatedBy?: string | null;
  commentUpdatedAt?: number;
}

export interface R2ListResponse {
  objects: R2ObjectInfo[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
  /** Offset-mode pagination metadata (v1.29.0) — present when offset is sent. */
  meta?: {
    total: number;
    count: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  /** Offset mode: folder exceeds the materialise cap; total is a floor (first N). */
  capped?: boolean;
}

export interface StorageListParams {
  prefix?: string;
  cursor?: string;
  /** Offset-mode pagination (v1.29.0); mutually exclusive with cursor. */
  offset?: number;
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
      offset: params?.offset,
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
              comment: z.string().optional(),
              commentUpdatedBy: z.string().nullable().optional(),
              commentUpdatedAt: z.number().optional(),
            }),
          ),
          truncated: z.boolean(),
          cursor: z.string().optional(),
          delimitedPrefixes: z.array(z.string()),
          // Offset-mode pagination metadata (v1.29.0). Must be declared or Zod
          // strips it from the parsed result, leaving the dashboard with no meta.
          meta: z
            .object({
              total: z.number(),
              count: z.number(),
              offset: z.number(),
              limit: z.number(),
              hasMore: z.boolean(),
            })
            .optional(),
          capped: z.boolean().optional(),
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
      `/api/storage/${encodeURIComponent(bucket)}/meta/${objectKeySegments(key)}`,
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
          comment: z.string().optional(),
          commentUpdatedBy: z.string().nullable().optional(),
          commentUpdatedAt: z.number().optional(),
        }),
      }),
    );
    return response.data;
  },

  /**
   * Download an object as a blob
   */
  async downloadObject(bucket: string, key: string): Promise<Blob> {
    const url = new URL(
      `/api/storage/${encodeURIComponent(bucket)}/objects/${objectKeySegments(key)}`,
      API_BASE,
    );

    const response = await apiFetch(url);

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
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

    const response = await apiFetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    return (data as { data: R2ObjectInfo }).data;
  },

  /**
   * Delete an object from a bucket
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/objects/${objectKeySegments(key)}`,
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
      `/api/storage/${encodeURIComponent(bucket)}/metadata/${objectKeySegments(key)}`,
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
   * Set or clear an object's free-text comment / note. Pass null (or '') to clear.
   */
  async setComment(
    bucket: string,
    key: string,
    comment: string | null,
  ): Promise<{
    bucket: string;
    key: string;
    comment: string | null;
    commentUpdatedBy: string | null;
    commentUpdatedAt: number | null;
  }> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/comment/${objectKeySegments(key)}`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            bucket: z.string(),
            key: z.string(),
            comment: z.string().nullable(),
            commentUpdatedBy: z.string().nullable(),
            commentUpdatedAt: z.number().nullable(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      {
        method: 'PUT',
        body: JSON.stringify({ comment }),
      },
    );
    return response.data as {
      bucket: string;
      key: string;
      comment: string | null;
      commentUpdatedBy: string | null;
      commentUpdatedAt: number | null;
    };
  },

  /**
   * Purge CDN cache for an R2 object
   */
  async purgeCache(bucket: string, key: string): Promise<PurgeCacheResult> {
    const response = await fetchApi(
      `/api/storage/${encodeURIComponent(bucket)}/purge-cache/${objectKeySegments(key)}`,
      z.object({
        success: z.boolean(),
        data: z
          .object({
            purged: z.number(),
            failed: z.number(),
            urls: z.array(z.string()),
            // Absent from an older Worker: read as complete
            routeDiscoveryComplete: z.boolean().optional(),
          })
          .optional(),
        error: z.string().optional(),
      }),
      { method: 'POST' },
    );
    if (!response.data) throw new ApiError(500, response.error || 'Failed to purge cache');
    return {
      purged: response.data.purged,
      failed: response.data.failed,
      urls: response.data.urls,
      routeDiscoveryComplete: response.data.routeDiscoveryComplete ?? true,
    };
  },
};

/**
 * The answer of a manual cache purge. `routeDiscoveryComplete` is false when
 * the Worker could not list the routes serving the object (v1.38.0): the URLs
 * it knew without them were still purged, but a route URL may still serve the
 * old bytes until its max-age.
 */
export interface PurgeCacheResult {
  purged: number;
  failed: number;
  urls: string[];
  routeDiscoveryComplete: boolean;
}

// =============================================================================
// Feedback API
// =============================================================================

// FeedbackItem is a plain TS interface in @bifrost/shared (not a zod schema), so
// the response is validated structurally (success/error) and the data passed
// through — the same pattern storageApi uses for its R2 payloads.
const FeedbackEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export const feedbackApi = {
  /** List feedback (the single admin sees all). */
  async list(params?: FeedbackListParams): Promise<{ feedback: FeedbackItem[]; total: number }> {
    const query = buildQueryString((params ?? {}) as Record<string, string | number | undefined>);
    const response = await fetchApi(`/api/feedback${query}`, FeedbackEnvelopeSchema);
    if (!response.success || !response.data) {
      throw new ApiError(500, response.error || 'Failed to fetch feedback');
    }
    return response.data as { feedback: FeedbackItem[]; total: number };
  },

  /** Fetch a single feedback item. */
  async get(id: string): Promise<FeedbackItem> {
    const response = await fetchApi(
      `/api/feedback/${encodeURIComponent(id)}`,
      FeedbackEnvelopeSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'Feedback not found');
    }
    return response.data as FeedbackItem;
  },

  /** Submit feedback (multipart — screenshots + capture bundle + fields). */
  async submit(formData: FormData): Promise<FeedbackItem> {
    const url = new URL('/api/feedback', API_BASE);
    const response = await apiFetch(url, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    return (data as { data: FeedbackItem }).data;
  },

  /** Apply a triage patch. */
  async triage(id: string, patch: TriageFeedbackInput): Promise<FeedbackItem> {
    const response = await fetchApi(
      `/api/feedback/${encodeURIComponent(id)}`,
      FeedbackEnvelopeSchema,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to update feedback');
    }
    return response.data as FeedbackItem;
  },

  /** Delete a feedback item (cascades its R2 artifacts). */
  async remove(id: string): Promise<void> {
    await fetchApi(
      `/api/feedback/${encodeURIComponent(id)}`,
      z.object({ success: z.boolean(), error: z.string().optional() }),
      { method: 'DELETE' },
    );
  },

  /** Download an item-owned attachment (screenshot or capture bundle) as a blob. */
  async attachment(id: string, key: string): Promise<Blob> {
    const url = new URL(
      `/api/feedback/${encodeURIComponent(id)}/attachment/${objectKeySegments(key)}`,
      API_BASE,
    );
    const response = await apiFetch(url);
    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }
    return response.blob();
  },
};

// =============================================================================
// QR codes API (v1.30.0)
// =============================================================================
// Response schemas live here (not lib/schemas.ts) because they are thin
// envelope wrappers around the shared record shape, single-sourced in
// @bifrost/shared. QR responses are checked with the TOLERANT stored shape the Worker reads
// records with (`StoredQRCodeSchema`, v1.38.0), not the write schema: a code
// saved under earlier limits (a longer description, more tags) lists, renders
// and opens. Today's limits stay on what a write sends.
export const QRItemResponseSchema = z.object({
  success: z.boolean(),
  data: StoredQRCodeSchema.optional(),
  error: z.string().optional(),
});

export const QRListResponseSchema = z.object({
  success: z.boolean(),
  // A record that cannot be read is listed as a minimal row (v1.38.0)
  data: z.array(z.union([InvalidQRRowSchema, StoredQRCodeSchema])).optional(),
  error: z.string().optional(),
  meta: z
    .object({
      total: z.number(),
      count: z.number(),
      offset: z.number(),
      limit: z.number(),
      hasMore: z.boolean(),
    })
    .optional(),
});

export interface QrQueryParams {
  domain?: string;
  type?: string;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QRListMeta {
  total: number;
  count: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export const qrApi = {
  /**
   * One list page: the readable codes, the rows for stored records that
   * cannot be read (v1.38.0: shown flagged, Delete only), and the meta.
   */
  async list(
    params: QrQueryParams = {},
  ): Promise<{ items: QRCode[]; invalid?: InvalidQRRow[]; meta: QRListMeta }> {
    const query = {
      ...params,
      search: params.search === undefined ? undefined : capSearchParam(params.search),
    };
    const response = await fetchApi(`/api/qr${buildQueryString(query)}`, QRListResponseSchema);
    if (!response.success || !response.data || !response.meta) {
      throw new ApiError(500, response.error || 'Failed to fetch QR codes');
    }
    const items: QRCode[] = [];
    const invalid: InvalidQRRow[] = [];
    for (const row of response.data) {
      if (isInvalidQRRow(row)) invalid.push(row);
      else items.push(row);
    }
    return { items, invalid, meta: response.meta };
  },

  async get(id: string, domain?: string): Promise<QRCode> {
    const response = await fetchApi(
      `/api/qr/${encodeURIComponent(id)}${buildQueryString({ domain })}`,
      QRItemResponseSchema,
    );
    if (!response.success || !response.data) {
      throw new ApiError(404, response.error || 'QR code not found');
    }
    return response.data;
  },

  async create(input: Record<string, unknown>, domain: string): Promise<QRCode> {
    const response = await fetchApi(
      `/api/qr${buildQueryString({ domain })}`,
      QRItemResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to create QR code');
    }
    return response.data;
  },

  async update(id: string, input: Record<string, unknown>, domain: string): Promise<QRCode> {
    const response = await fetchApi(
      `/api/qr/${encodeURIComponent(id)}${buildQueryString({ domain })}`,
      QRItemResponseSchema,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    );
    if (!response.success || !response.data) {
      throw new ApiError(400, response.error || 'Failed to update QR code');
    }
    return response.data;
  },

  /**
   * Delete a code. Resolves with the deleted record's `createdAt` (v1.38.0),
   * naming the incarnation removed, for the dashboard's tombstone; absent
   * when the record could not be read.
   */
  async delete(id: string, domain: string): Promise<{ createdAt?: number | undefined }> {
    const response = await fetchApi(
      `/api/qr/${encodeURIComponent(id)}${buildQueryString({ domain })}`,
      z.object({
        success: z.boolean(),
        data: z
          .object({ deleted: z.literal(true), id: z.string(), createdAt: z.number().optional() })
          .optional(),
      }),
      { method: 'DELETE' },
    );
    return { createdAt: response.data?.createdAt };
  },
};

// =============================================================================
// Combined API Export
// =============================================================================

/**
 * The engineering changelog, fetched from the AUTHENTICATED `GET /api/changelog`
 * route.
 *
 * It used to be `import '../../../CHANGELOG.md?raw'` in the page, which
 * compiled the whole document into a JS chunk under `/assets` — served with no
 * credential check, so every release note was readable by anyone who could
 * reach the dashboard host. ⚠️ Never re-import the markdown into this bundle;
 * `pnpm run check` fails the build if a release heading reappears under
 * `admin/dist`.
 *
 * Deliberately not routed through `fetchApi`, which parses JSON: the body is
 * `text/markdown`.
 */
export const changelogApi = {
  async get(): Promise<string> {
    const url = new URL('/api/changelog', API_BASE);
    const response = await apiFetch(url);
    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new ApiError(response.status, error.error || `HTTP ${response.status}`);
    }
    return response.text();
  },
};

export const api = {
  routes: routesApi,
  analytics: analyticsApi,
  backup: backupApi,
  changelog: changelogApi,
  metadata: metadataApi,
  storage: storageApi,
  feedback: feedbackApi,
  qr: qrApi,
};

export { ApiError };
