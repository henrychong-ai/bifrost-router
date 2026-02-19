/**
 * EdgeRouterClient - HTTP client for Bifrost Admin API
 *
 * This client wraps the Admin API endpoints and is used by both
 * the MCP server and the Slackbot Worker.
 */

import type {
  Route,
  CreateRouteInput,
  UpdateRouteInput,
  AnalyticsSummary,
  SlugStats,
  LinkClick,
  PageView,
  PaginatedResponse,
  ApiResponse,
  PaginatedApiResponse,
  AnalyticsQueryOptions,
  R2ObjectInfo,
  R2ListResponse,
  R2BucketsResponse,
  R2ListObjectsParams,
  R2UpdateMetadataParams,
} from './types.js';

/**
 * Type for fetch function
 */
type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Configuration for EdgeRouterClient
 */
export interface EdgeRouterClientConfig {
  /** Base URL for the Admin API (e.g., 'https://henrychong.com') */
  baseUrl: string;

  /** Admin API key for authentication */
  apiKey: string;

  /** Default domain for requests (optional, can be overridden per request) */
  defaultDomain?: string;

  /** Custom fetch implementation (for testing or Workers) */
  fetch?: FetchFunction;
}

/**
 * Error thrown by EdgeRouterClient
 */
export class EdgeRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EdgeRouterError';
  }
}

/**
 * HTTP client for Bifrost Admin API
 */
export class EdgeRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultDomain?: string;
  private readonly fetch: FetchFunction;

  constructor(config: EdgeRouterClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
    this.defaultDomain = config.defaultDomain;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /**
   * Make an authenticated request to the Admin API
   */
  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    } = {},
  ): Promise<T> {
    // Build URL with query params
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Make request
    const response = await this.fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': this.apiKey,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Parse response
    let data: ApiResponse<T> | PaginatedApiResponse<T>;
    try {
      data = await response.json();
    } catch {
      throw new EdgeRouterError(
        `Failed to parse response: ${response.statusText}`,
        response.status,
      );
    }

    // Handle errors
    if (!response.ok || !data.success) {
      throw new EdgeRouterError(
        (data as ApiResponse).error ?? `Request failed: ${response.statusText}`,
        response.status,
        (data as ApiResponse).details,
      );
    }

    // Return data (handle both ApiResponse and PaginatedApiResponse)
    if ('meta' in data && data.meta) {
      return { items: data.data, meta: data.meta } as T;
    }
    return (data as ApiResponse<T>).data as T;
  }

  /**
   * Get the effective domain, resolving default if not provided
   */
  private getDomain(domain?: string): string | undefined {
    return domain ?? this.defaultDomain;
  }

  // ===========================================================================
  // Route Management
  // ===========================================================================

  /**
   * List routes for a domain with optional search and pagination
   */
  async listRoutes(
    domain?: string,
    options?: { search?: string; limit?: number; offset?: number },
  ): Promise<{ routes: Route[]; total: number }> {
    const effectiveDomain = this.getDomain(domain);
    const response = await this.request<{ routes: Route[]; total: number }>('GET', '/api/routes', {
      params: {
        ...(effectiveDomain && { domain: effectiveDomain }),
        ...(options?.search && { search: options.search }),
        ...(options?.limit !== undefined && { limit: options.limit }),
        ...(options?.offset !== undefined && { offset: options.offset }),
      },
    });
    return response;
  }

  /**
   * Get a single route by path
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async getRoute(path: string, domain?: string): Promise<Route> {
    const effectiveDomain = this.getDomain(domain);
    return this.request<Route>('GET', '/api/routes', {
      params: {
        path,
        ...(effectiveDomain && { domain: effectiveDomain }),
      },
    });
  }

  /**
   * Create a new route
   */
  async createRoute(input: CreateRouteInput, domain?: string): Promise<Route> {
    const effectiveDomain = this.getDomain(domain);
    return this.request<Route>('POST', '/api/routes', {
      body: input,
      params: effectiveDomain ? { domain: effectiveDomain } : undefined,
    });
  }

  /**
   * Update an existing route
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async updateRoute(path: string, input: UpdateRouteInput, domain?: string): Promise<Route> {
    const effectiveDomain = this.getDomain(domain);
    return this.request<Route>('PUT', '/api/routes', {
      body: input,
      params: {
        path,
        ...(effectiveDomain && { domain: effectiveDomain }),
      },
    });
  }

  /**
   * Delete a route
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async deleteRoute(path: string, domain?: string): Promise<void> {
    const effectiveDomain = this.getDomain(domain);
    await this.request<void>('DELETE', '/api/routes', {
      params: {
        path,
        ...(effectiveDomain && { domain: effectiveDomain }),
      },
    });
  }

  /**
   * Toggle a route's enabled status
   */
  async toggleRoute(path: string, enabled: boolean, domain?: string): Promise<Route> {
    return this.updateRoute(path, { enabled }, domain);
  }

  /**
   * Migrate a route to a new path
   */
  async migrateRoute(oldPath: string, newPath: string, domain?: string): Promise<Route> {
    const effectiveDomain = this.getDomain(domain);
    return this.request<Route>('POST', '/api/routes/migrate', {
      params: {
        oldPath,
        newPath,
        ...(effectiveDomain && { domain: effectiveDomain }),
      },
    });
  }

  // ===========================================================================
  // Analytics
  // ===========================================================================

  /**
   * Get analytics summary
   */
  async getAnalyticsSummary(options: AnalyticsQueryOptions = {}): Promise<AnalyticsSummary> {
    const effectiveDomain = this.getDomain(options.domain);
    return this.request<AnalyticsSummary>('GET', '/api/analytics/summary', {
      params: {
        domain: effectiveDomain,
        days: options.days,
      },
    });
  }

  /**
   * Get paginated list of clicks
   */
  async getClicks(options: AnalyticsQueryOptions = {}): Promise<PaginatedResponse<LinkClick>> {
    const effectiveDomain = this.getDomain(options.domain);
    return this.request<PaginatedResponse<LinkClick>>('GET', '/api/analytics/clicks', {
      params: {
        domain: effectiveDomain,
        days: options.days,
        limit: options.limit,
        offset: options.offset,
        slug: options.slug,
        country: options.country,
      },
    });
  }

  /**
   * Get paginated list of page views
   */
  async getViews(options: AnalyticsQueryOptions = {}): Promise<PaginatedResponse<PageView>> {
    const effectiveDomain = this.getDomain(options.domain);
    return this.request<PaginatedResponse<PageView>>('GET', '/api/analytics/views', {
      params: {
        domain: effectiveDomain,
        days: options.days,
        limit: options.limit,
        offset: options.offset,
        path: options.path,
        country: options.country,
      },
    });
  }

  /**
   * Get detailed statistics for a specific slug
   */
  async getSlugStats(slug: string, options: AnalyticsQueryOptions = {}): Promise<SlugStats> {
    const effectiveDomain = this.getDomain(options.domain);
    // Remove leading slash from slug for URL path
    const cleanSlug = slug.startsWith('/') ? slug.slice(1) : slug;
    return this.request<SlugStats>(
      'GET',
      `/api/analytics/clicks/${encodeURIComponent(cleanSlug)}`,
      {
        params: {
          domain: effectiveDomain,
          days: options.days,
        },
      },
    );
  }

  // ===========================================================================
  // Storage Management
  // ===========================================================================

  /**
   * Make a raw request (for binary downloads)
   */
  private async requestRaw(
    method: string,
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const response = await this.fetch(url.toString(), {
      method,
      headers: { 'X-Admin-Key': this.apiKey },
    });
    if (!response.ok) {
      let errorMsg = response.statusText;
      try {
        const data = await response.json();
        errorMsg = (data as ApiResponse).error ?? errorMsg;
      } catch {
        /* ignore parse errors */
      }
      throw new EdgeRouterError(errorMsg, response.status);
    }
    return response;
  }

  /**
   * Make a multipart form data request (for uploads)
   */
  private async requestMultipart<T>(path: string, formData: FormData): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const response = await this.fetch(url.toString(), {
      method: 'POST',
      headers: { 'X-Admin-Key': this.apiKey },
      body: formData,
    });
    let data: ApiResponse<T>;
    try {
      data = await response.json();
    } catch {
      throw new EdgeRouterError(
        `Failed to parse response: ${response.statusText}`,
        response.status,
      );
    }
    if (!response.ok || !data.success) {
      throw new EdgeRouterError(
        data.error ?? `Request failed: ${response.statusText}`,
        response.status,
        data.details,
      );
    }
    return data.data as T;
  }

  /**
   * List all R2 buckets with access levels
   */
  async listBuckets(): Promise<R2BucketsResponse> {
    return this.request<R2BucketsResponse>('GET', '/api/storage/buckets');
  }

  /**
   * List objects in an R2 bucket
   */
  async listObjects(bucket: string, params?: R2ListObjectsParams): Promise<R2ListResponse> {
    return this.request<R2ListResponse>('GET', `/api/storage/${bucket}/objects`, {
      params: {
        prefix: params?.prefix,
        cursor: params?.cursor,
        limit: params?.limit,
        delimiter: params?.delimiter,
      },
    });
  }

  /**
   * Get object metadata
   */
  async getObjectMeta(bucket: string, key: string): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>('GET', `/api/storage/${bucket}/meta/${key}`);
  }

  /**
   * Download an object (returns raw response)
   */
  async downloadObject(
    bucket: string,
    key: string,
  ): Promise<{ meta: R2ObjectInfo; body: ArrayBuffer }> {
    const meta = await this.getObjectMeta(bucket, key);
    const response = await this.requestRaw('GET', `/api/storage/${bucket}/objects/${key}`);
    const body = await response.arrayBuffer();
    return { meta, body };
  }

  /**
   * Upload an object via multipart form data
   */
  async uploadObject(
    bucket: string,
    key: string,
    content: Blob | File,
    contentType: string,
    options?: { overwrite?: boolean },
  ): Promise<R2ObjectInfo> {
    const formData = new FormData();
    formData.append('key', key);
    formData.append('file', new Blob([content], { type: contentType }), key.split('/').pop());
    if (options?.overwrite) formData.append('overwrite', 'true');
    return this.requestMultipart<R2ObjectInfo>(`/api/storage/${bucket}/upload`, formData);
  }

  /**
   * Delete an object
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.request<void>('DELETE', `/api/storage/${bucket}/objects/${key}`);
  }

  /**
   * Rename/move an object within a bucket
   */
  async renameObject(bucket: string, oldKey: string, newKey: string): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>('POST', `/api/storage/${bucket}/rename`, {
      body: { oldKey, newKey },
    });
  }

  /**
   * Update object HTTP metadata
   */
  async updateObjectMetadata(
    bucket: string,
    key: string,
    metadata: R2UpdateMetadataParams,
  ): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>('PUT', `/api/storage/${bucket}/metadata/${key}`, {
      body: metadata,
    });
  }
}

/**
 * Create an EdgeRouterClient from environment variables
 *
 * Expected environment variables:
 * - EDGE_ROUTER_API_KEY: Admin API key (required)
 * - EDGE_ROUTER_URL: Base URL (default: 'https://henrychong.com')
 * - EDGE_ROUTER_DOMAIN: Default domain (optional)
 */
export function createClientFromEnv(env?: Record<string, string | undefined>): EdgeRouterClient {
  // Use provided env or try to use process.env if available
  const resolvedEnv = env ?? (typeof process !== 'undefined' ? process.env : {});
  const apiKey = resolvedEnv.EDGE_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('EDGE_ROUTER_API_KEY environment variable is required');
  }

  return new EdgeRouterClient({
    baseUrl: resolvedEnv.EDGE_ROUTER_URL ?? 'https://henrychong.com',
    apiKey,
    defaultDomain: resolvedEnv.EDGE_ROUTER_DOMAIN,
  });
}
