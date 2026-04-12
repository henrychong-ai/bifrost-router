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
  R2ListObjectsParams,
  R2ObjectInfo,
  R2ListResponse,
  R2UploadResponse,
  R2BucketsResponse,
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
  /** Base URL for the Admin API (e.g., 'https://example.com') */
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
   * Make an authenticated multipart request (for file uploads)
   */
  private async requestMultipart<T>(path: string, formData: FormData): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const response = await this.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-Admin-Key': this.apiKey,
      },
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
        (data as ApiResponse).error ?? `Request failed: ${response.statusText}`,
        response.status,
        (data as ApiResponse).details,
      );
    }

    return data.data as T;
  }

  /**
   * Make an authenticated request that returns the raw Response (for binary downloads)
   */
  private async requestRaw(
    method: string,
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await this.fetch(url.toString(), {
      method,
      headers: {
        'X-Admin-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      let errorMessage = `Request failed: ${response.statusText}`;
      try {
        const data = await response.json();
        if (data.error) errorMessage = data.error;
      } catch {
        // Use default message
      }
      throw new EdgeRouterError(errorMessage, response.status);
    }

    return response;
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
   * List all routes for a domain
   * @param domain - Optional domain to filter routes
   * @param search - Optional search term to filter routes (case-insensitive)
   */
  async listRoutes(domain?: string, search?: string): Promise<Route[]> {
    const effectiveDomain = this.getDomain(domain);
    const params: Record<string, string> = {};
    if (effectiveDomain) params.domain = effectiveDomain;
    if (search) params.search = search;
    const response = await this.request<{ routes: Route[]; total: number }>('GET', '/api/routes', {
      params: Object.keys(params).length > 0 ? params : undefined,
    });
    return response.routes;
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

  /**
   * Transfer a route to a different domain
   */
  async transferRoute(path: string, fromDomain: string, toDomain: string): Promise<Route> {
    return this.request<Route>('POST', '/api/routes/transfer', {
      body: { path, fromDomain, toDomain },
    });
  }

  /**
   * Find all R2-type routes serving a specific R2 object
   */
  async getRoutesByTarget(bucket: string, target: string): Promise<{ routes: Route[] }> {
    return this.request<{ routes: Route[] }>('GET', '/api/routes/by-target', {
      params: { bucket, target },
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
  // R2 Storage
  // ===========================================================================

  /**
   * List available R2 buckets
   */
  async listBuckets(): Promise<R2BucketsResponse> {
    return this.request<R2BucketsResponse>('GET', '/api/storage/buckets');
  }

  /**
   * List objects in an R2 bucket
   */
  async listObjects(bucket: string, params?: R2ListObjectsParams): Promise<R2ListResponse> {
    return this.request<R2ListResponse>(
      'GET',
      `/api/storage/${encodeURIComponent(bucket)}/objects`,
      {
        params: {
          prefix: params?.prefix,
          cursor: params?.cursor,
          limit: params?.limit,
          delimiter: params?.delimiter,
        },
      },
    );
  }

  /**
   * Get metadata for an R2 object
   */
  async getObjectMeta(bucket: string, key: string): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>(
      'GET',
      `/api/storage/${encodeURIComponent(bucket)}/meta/${encodeURIComponent(key)}`,
    );
  }

  /**
   * Download an R2 object with its metadata
   */
  async downloadObject(
    bucket: string,
    key: string,
  ): Promise<{ meta: R2ObjectInfo; body: ArrayBuffer }> {
    const meta = await this.getObjectMeta(bucket, key);
    const response = await this.requestRaw(
      'GET',
      `/api/storage/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
    );
    const body = await response.arrayBuffer();
    return { meta, body };
  }

  /**
   * Upload a file to an R2 bucket
   */
  async uploadObject(
    bucket: string,
    key: string,
    content: Blob | Buffer,
    contentType: string,
    options?: { overwrite?: boolean },
  ): Promise<R2UploadResponse> {
    const formData = new FormData();
    const blob =
      content instanceof Blob
        ? content
        : new Blob([new Uint8Array(content)], { type: contentType });
    formData.append('file', blob, key.split('/').pop() ?? 'file');
    formData.append('key', key);
    if (options?.overwrite) {
      formData.append('overwrite', 'true');
    }
    return this.requestMultipart<R2UploadResponse>(
      `/api/storage/${encodeURIComponent(bucket)}/upload`,
      formData,
    );
  }

  /**
   * Delete an R2 object
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/api/storage/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`,
    );
  }

  /**
   * Rename/move an R2 object
   */
  async renameObject(bucket: string, oldKey: string, newKey: string): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>('POST', `/api/storage/${encodeURIComponent(bucket)}/rename`, {
      body: { oldKey, newKey },
    });
  }

  /**
   * Move an object to a different R2 bucket
   */
  async moveObject(
    bucket: string,
    key: string,
    destinationBucket: string,
    destinationKey?: string,
  ): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>('POST', `/api/storage/${encodeURIComponent(bucket)}/move`, {
      body: { key, destinationBucket, destinationKey },
    });
  }

  /**
   * Update HTTP metadata for an R2 object
   */
  async updateObjectMetadata(
    bucket: string,
    key: string,
    metadata: R2UpdateMetadataParams,
  ): Promise<R2ObjectInfo> {
    return this.request<R2ObjectInfo>(
      'PUT',
      `/api/storage/${encodeURIComponent(bucket)}/metadata/${encodeURIComponent(key)}`,
      {
        body: metadata,
      },
    );
  }

  /**
   * Purge CDN cache for an R2 object across all associated routes and custom domains
   */
  async purgeCache(
    bucket: string,
    key: string,
  ): Promise<{ purged: number; failed: number; urls: string[] }> {
    // Encode each path segment individually to preserve / as path separators
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    return this.request<{ purged: number; failed: number; urls: string[] }>(
      'POST',
      `/api/storage/${encodeURIComponent(bucket)}/purge-cache/${encodedKey}`,
    );
  }
}

/**
 * Create an EdgeRouterClient from environment variables
 *
 * Expected environment variables:
 * - EDGE_ROUTER_API_KEY: Admin API key (required)
 * - EDGE_ROUTER_URL: Base URL (default: 'https://example.com')
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
    baseUrl: resolvedEnv.EDGE_ROUTER_URL ?? 'https://example.com',
    apiKey,
    defaultDomain: resolvedEnv.EDGE_ROUTER_DOMAIN,
  });
}
