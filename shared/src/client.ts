/**
 * EdgeRouterClient - HTTP client for Bifrost Admin API
 *
 * This client wraps the Admin API endpoints and is used by both
 * the MCP server and the Slackbot Worker.
 */

import { isRecord, isString } from './guards.js';
import type { InvalidQRRow, QRCode } from './qr.js';
import type { InvalidRouteRow } from './stored-route.js';
import type {
  AnalyticsQueryOptions,
  AnalyticsSummary,
  CreateRouteInput,
  LinkClick,
  PageView,
  PaginatedResponse,
  R2BucketsResponse,
  R2CommentUpdateResult,
  R2ListObjectsParams,
  R2ListResponse,
  R2ObjectInfo,
  R2UpdateMetadataParams,
  R2UploadResponse,
  Route,
  SlugStats,
  UpdateRouteInput,
} from './types.js';

/**
 * The Admin API's response envelope as the client reads it (v1.38.0): the
 * body is read as unknown and must be a JSON object; `success` counts only
 * when it is `true`, and `error`, `message` and `meta` only when they have
 * their declared types. Anything else reads as a parse failure. The `data`
 * payload is the endpoint's own documented contract and is passed on as the
 * caller's declared type, as before.
 */
interface ResponseEnvelope {
  success: boolean;
  data: unknown;
  meta: Record<string, unknown> | undefined;
  error: string | undefined;
  message: string | undefined;
  code: string | undefined;
  details: unknown;
}

/** A non-empty string, else undefined. */
const nonEmpty = (value: unknown): string | undefined =>
  isString(value) && value !== '' ? value : undefined;

/** `body` as a {@link ResponseEnvelope}, or null when it is not a JSON object. */
function readEnvelope(body: unknown): ResponseEnvelope | null {
  if (!isRecord(body)) return null;
  const field = (name: string): unknown => (Object.hasOwn(body, name) ? body[name] : undefined);
  const meta = field('meta');
  const error = field('error');
  const message = field('message');
  const code = field('code');
  return {
    success: field('success') === true,
    data: field('data'),
    meta: isRecord(meta) ? Object.fromEntries(Object.entries(meta)) : undefined,
    // An empty string says nothing: it reads as absent, so the status text stands in
    error: nonEmpty(error),
    message: nonEmpty(message),
    code: nonEmpty(code),
    details: field('details'),
  };
}

/**
 * The error a failed answer's envelope describes (v1.38.0). A handler that
 * sends a `message` beside `error` is using `error` as a machine code
 * (`QR_NOT_FOUND`, `QR_RECORD_INVALID`, `ROUTE_RECORD_INVALID`,
 * `ROUTE_TARGET_CREDENTIAL`); an explicit `code` field wins over it. The code
 * is kept on the error (`EdgeRouterError.code`) and the text is
 * `code: message`, or the message alone when the two are the same, so a
 * human or MCP caller reads the sentence once. A body with `error` only keeps
 * it as the text.
 */
function envelopeError(
  data: ResponseEnvelope | null,
  response: Response,
): { message: string; code: string | undefined } {
  const fallback = `Request failed: ${response.statusText}`;
  if (data === null) return { message: fallback, code: undefined };
  const code = data.code ?? (data.message === undefined ? undefined : data.error);
  const text = data.message ?? data.error ?? fallback;
  return {
    message: code === undefined || code === text ? text : `${code}: ${text}`,
    code,
  };
}

/** A response body read as unknown: null when it is not JSON (the parser's message is dropped). */
async function readBody(response: Response): Promise<{ value: unknown } | null> {
  try {
    const value: unknown = await response.json();
    return { value };
  } catch {
    return null;
  }
}

/** Pagination meta returned by the QR list endpoint (mirrors the routes meta). */
export interface QRListMeta {
  total: number;
  count: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

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
    /** The server's machine code, when it sent one (`QR_NOT_FOUND`, …). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'EdgeRouterError';
  }
}

/**
 * The request-only acknowledgement that unlocks a credential-shaped route
 * target. It is NOT part of a stored route: it travels in the write request,
 * the Worker reads it off the raw body, and the stored-shape Zod schema strips
 * it before anything reaches KV.
 */
export interface CredentialTargetAcknowledgement {
  acknowledgeCredentialTarget?: boolean | undefined;
}

/** Attach the acknowledgement to a write body only when it was actually set. */
function withCredentialTargetAcknowledgement<T extends object>(
  input: T,
  options: CredentialTargetAcknowledgement,
): T | (T & { acknowledgeCredentialTarget: boolean }) {
  return options.acknowledgeCredentialTarget === undefined
    ? input
    : { ...input, acknowledgeCredentialTarget: options.acknowledgeCredentialTarget };
}

/**
 * HTTP client for Bifrost Admin API
 */
export class EdgeRouterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetch: FetchFunction;

  constructor(config: EdgeRouterClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = config.apiKey;
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

    // Make request. The `body` key is present only when there is a body: fetch
    // reads an absent key and an explicit `undefined` as the same "no body".
    const response = await this.fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': this.apiKey,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    // Parse response, as unknown
    const read = await readBody(response);
    const data = read === null ? null : readEnvelope(read.value);
    if (data === null) {
      throw new EdgeRouterError(
        `Failed to parse response: ${response.statusText}`,
        response.status,
      );
    }

    // Handle errors: the code and the sentence (envelopeError)
    if (!response.ok || !data.success) {
      const error = envelopeError(data, response);
      throw new EdgeRouterError(error.message, response.status, data.details, error.code);
    }

    // Return data (handle both ApiResponse and PaginatedApiResponse); the
    // payload is the endpoint's documented contract
    if (data.meta) {
      return { items: data.data, meta: data.meta } as T;
    }
    return data.data as T;
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

    const read = await readBody(response);
    const data = read === null ? null : readEnvelope(read.value);
    if (data === null) {
      throw new EdgeRouterError(
        `Failed to parse response: ${response.statusText}`,
        response.status,
      );
    }

    if (!response.ok || !data.success) {
      const error = envelopeError(data, response);
      throw new EdgeRouterError(error.message, response.status, data.details, error.code);
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
      // As request() (envelopeError): the markdown and SVG paths come through
      // here, a QR image of a deleted code included. A body that is not JSON,
      // or not an object, keeps the default text.
      const read = await readBody(response);
      const data = read === null ? null : readEnvelope(read.value);
      const error = envelopeError(data, response);
      throw new EdgeRouterError(error.message, response.status, data?.details, error.code);
    }

    return response;
  }

  // ===========================================================================
  // Route Management
  // ===========================================================================

  /**
   * List all routes for a domain
   * @param domain - Domain whose routes are listed (required; never defaulted)
   * @param search - Optional search term to filter routes (case-insensitive)
   */
  async listRoutes(domain: string, search?: string): Promise<Array<Route | InvalidRouteRow>> {
    const params: Record<string, string> = { domain };
    if (search) params['search'] = search;
    // A stored record that cannot be read is listed as an InvalidRouteRow
    // (v1.38.0): its domain and path, flagged `invalid`
    const response = await this.request<{
      routes: Array<Route | InvalidRouteRow>;
      total: number;
    }>('GET', '/api/routes', { params });
    return response.routes;
  }

  /**
   * Get a single route by path
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async getRoute(path: string, domain: string): Promise<Route> {
    return this.request<Route>('GET', '/api/routes', {
      params: { path, domain },
    });
  }

  /**
   * Create a new route
   */
  async createRoute(
    input: CreateRouteInput,
    domain: string,
    options: CredentialTargetAcknowledgement = {},
  ): Promise<Route> {
    return this.request<Route>('POST', '/api/routes', {
      body: withCredentialTargetAcknowledgement(input, options),
      params: { domain },
    });
  }

  /**
   * Update an existing route
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async updateRoute(
    path: string,
    input: UpdateRouteInput,
    domain: string,
    options: CredentialTargetAcknowledgement = {},
  ): Promise<Route> {
    return this.request<Route>('PUT', '/api/routes', {
      body: withCredentialTargetAcknowledgement(input, options),
      params: { path, domain },
    });
  }

  /**
   * Delete a route
   *
   * Uses query parameter for path to handle "/" and other special characters correctly.
   */
  async deleteRoute(path: string, domain: string): Promise<void> {
    await this.request<void>('DELETE', '/api/routes', {
      params: { path, domain },
    });
  }

  /**
   * Toggle a route's enabled status
   */
  async toggleRoute(
    path: string,
    enabled: boolean,
    domain: string,
    options: CredentialTargetAcknowledgement = {},
  ): Promise<Route> {
    return this.updateRoute(path, { enabled }, domain, options);
  }

  /**
   * Migrate a route to a new path
   */
  async migrateRoute(oldPath: string, newPath: string, domain: string): Promise<Route> {
    return this.request<Route>('POST', '/api/routes/migrate', {
      params: { oldPath, newPath, domain },
    });
  }

  /**
   * Transfer a route to a different domain
   */
  async transferRoute(
    path: string,
    fromDomain: string,
    toDomain: string,
    options: CredentialTargetAcknowledgement = {},
  ): Promise<Route> {
    return this.request<Route>('POST', '/api/routes/transfer', {
      body: withCredentialTargetAcknowledgement({ path, fromDomain, toDomain }, options),
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
    return this.request<AnalyticsSummary>('GET', '/api/analytics/summary', {
      params: {
        domain: options.domain,
        days: options.days,
        country: options.country,
        search: options.search,
        includeMonitoring: options.includeMonitoring ? 'true' : undefined,
      },
    });
  }

  /**
   * Get paginated list of clicks
   */
  async getClicks(options: AnalyticsQueryOptions = {}): Promise<PaginatedResponse<LinkClick>> {
    return this.request<PaginatedResponse<LinkClick>>('GET', '/api/analytics/clicks', {
      params: {
        domain: options.domain,
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
    return this.request<PaginatedResponse<PageView>>('GET', '/api/analytics/views', {
      params: {
        domain: options.domain,
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
   *
   * `domain` is REQUIRED: the same slug can exist on several domains and an
   * unscoped read silently merges their clicks.
   */
  async getSlugStats(
    slug: string,
    options: AnalyticsQueryOptions & { domain: string },
  ): Promise<SlugStats> {
    // Remove leading slash from slug for URL path
    const cleanSlug = slug.startsWith('/') ? slug.slice(1) : slug;
    return this.request<SlugStats>(
      'GET',
      `/api/analytics/clicks/${encodeURIComponent(cleanSlug)}`,
      {
        params: {
          domain: options.domain,
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
          offset: params?.offset,
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
    options?: { overwrite?: boolean | undefined },
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

  /**
   * Set or clear the free-text comment on an R2 object (v1.30.0). Writes the D1 `file_comments` sidecar — no object
   * copy, works at any file size. Pass `null` (or an empty string) to clear.
   */
  async updateObjectComment(
    bucket: string,
    key: string,
    comment: string | null,
  ): Promise<R2CommentUpdateResult> {
    return this.request<R2CommentUpdateResult>(
      'PUT',
      `/api/storage/${encodeURIComponent(bucket)}/comment/${encodeURIComponent(key)}`,
      {
        body: { comment },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // QR codes (v1.30.0)
  // ---------------------------------------------------------------------------

  /**
   * List QR codes for a domain with optional filters + pagination.
   * Returns { items, meta } (paginated envelope unwrap).
   */
  async listQrs(options: {
    domain: string;
    type?: string;
    tag?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Array<QRCode | InvalidQRRow>; meta: QRListMeta }> {
    // A stored record that cannot be read is listed as an InvalidQRRow
    // (v1.38.0): its domain and id, flagged `invalid`
    return this.request<{ items: Array<QRCode | InvalidQRRow>; meta: QRListMeta }>(
      'GET',
      '/api/qr',
      {
        params: {
          domain: options.domain,
          type: options.type,
          tag: options.tag,
          search: options.search,
          limit: options.limit,
          offset: options.offset,
        },
      },
    );
  }

  /** Get a single QR code record. */
  async getQr(id: string, domain: string): Promise<QRCode> {
    return this.request<QRCode>('GET', `/api/qr/${encodeURIComponent(id)}`, {
      params: { domain },
    });
  }

  /** Create a QR code. The API validates with the strict discriminated schemas. */
  async createQr(input: Record<string, unknown>, domain: string): Promise<QRCode> {
    return this.request<QRCode>('POST', '/api/qr', {
      params: { domain },
      body: input,
    });
  }

  /** Update a QR code (type is immutable server-side). */
  async updateQr(id: string, input: Record<string, unknown>, domain: string): Promise<QRCode> {
    return this.request<QRCode>('PUT', `/api/qr/${encodeURIComponent(id)}`, {
      params: { domain },
      body: input,
    });
  }

  /**
   * Delete a QR code (hard delete; the audit log preserves the record). The
   * answer names the deleted record's `createdAt` (v1.38.0; absent for a
   * record that could not be read).
   */
  async deleteQr(
    id: string,
    domain: string,
  ): Promise<{ deleted: true; id: string; createdAt?: number }> {
    return this.request<{ deleted: true; id: string; createdAt?: number }>(
      'DELETE',
      `/api/qr/${encodeURIComponent(id)}`,
      { params: { domain } },
    );
  }

  /**
   * Fetch the engineering changelog as Markdown.
   *
   * The dashboard used to compile CHANGELOG.md into its public JS bundle,
   * which published every release note to anonymous callers. The document is
   * now served only from this authenticated route.
   */
  async getChangelogMarkdown(): Promise<string> {
    const response = await this.requestRaw('GET', '/api/changelog');
    return response.text();
  }

  /** Fetch the rendered QR SVG source for a stored record. */
  async getQrImageSvg(id: string, domain: string): Promise<string> {
    const response = await this.requestRaw('GET', `/api/qr/${encodeURIComponent(id)}/image`, {
      domain,
    });
    return response.text();
  }

  /** Render an ephemeral QR SVG for an existing route (persists nothing). */
  async getRouteQrSvg(
    path: string,
    options: {
      domain: string;
      fg?: string | undefined;
      bg?: string | undefined;
      size?: number | undefined;
    },
  ): Promise<string> {
    const response = await this.requestRaw('GET', '/api/qr/from-route', {
      domain: options.domain,
      path,
      fg: options.fg,
      bg: options.bg,
      size: options.size,
    });
    return response.text();
  }
}

/**
 * Create an EdgeRouterClient from environment variables
 *
 * Expected environment variables:
 * - EDGE_ROUTER_API_KEY: Admin API key (required)
 * - EDGE_ROUTER_URL: Base URL (default: 'https://example.com')
 *
 * There is no default domain: every route, QR and slug-stats call names its
 * own domain. `EDGE_ROUTER_DOMAIN` was removed in v1.35.0 and is not read.
 */
export function createClientFromEnv(env?: Record<string, string | undefined>): EdgeRouterClient {
  // Use provided env or try to use process.env if available
  const resolvedEnv = env ?? (typeof process !== 'undefined' ? process.env : {});
  const apiKey = resolvedEnv['EDGE_ROUTER_API_KEY'];
  if (!apiKey) {
    throw new Error('EDGE_ROUTER_API_KEY environment variable is required');
  }

  return new EdgeRouterClient({
    baseUrl: resolvedEnv['EDGE_ROUTER_URL'] ?? 'https://example.com',
    apiKey,
  });
}
