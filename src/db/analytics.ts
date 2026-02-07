import { createDb } from './index';
import { linkClicks, pageViews, fileDownloads, proxyRequests, auditLogs } from './schema';

/**
 * Data for recording a link click
 */
export interface LinkClickData {
  /** Domain that received the click */
  domain: string;
  /** Path/slug that was clicked */
  slug: string;
  /** Target URL the user was redirected to */
  targetUrl: string;
  /** Query string from the request (e.g., '?utm_source=twitter') */
  queryString?: string | null;
  /** HTTP Referer header */
  referrer?: string | null;
  /** User-Agent header */
  userAgent?: string | null;
  /** Country code from Cloudflare cf.country */
  country?: string | null;
  /** City from Cloudflare cf.city */
  city?: string | null;
  /** Cloudflare datacenter code from cf.colo */
  colo?: string | null;
  /** Continent code from cf.continent */
  continent?: string | null;
  /** HTTP protocol version from cf.httpProtocol */
  httpProtocol?: string | null;
  /** IANA timezone from cf.timezone */
  timezone?: string | null;
  /** Client IP address */
  ipAddress?: string | null;
}

/**
 * Data for recording a page view
 */
export interface PageViewData {
  /** Domain that received the view */
  domain: string;
  /** Path that was viewed */
  path: string;
  /** Query string from the request (e.g., '?page=2') */
  queryString?: string | null;
  /** HTTP Referer header */
  referrer?: string | null;
  /** User-Agent header */
  userAgent?: string | null;
  /** Country code from Cloudflare cf.country */
  country?: string | null;
  /** City from Cloudflare cf.city */
  city?: string | null;
  /** Cloudflare datacenter code from cf.colo */
  colo?: string | null;
  /** Continent code from cf.continent */
  continent?: string | null;
  /** HTTP protocol version from cf.httpProtocol */
  httpProtocol?: string | null;
  /** IANA timezone from cf.timezone */
  timezone?: string | null;
  /** Client IP address */
  ipAddress?: string | null;
}

/**
 * Record a link click in the analytics database
 *
 * IMPORTANT: This function is designed to be called via waitUntil()
 * and should never throw errors that would affect the main response.
 * All errors are logged but swallowed.
 *
 * @param db - D1Database binding
 * @param data - Click data to record
 */
export async function recordClick(db: D1Database, data: LinkClickData): Promise<void> {
  try {
    const drizzleDb = createDb(db);

    await drizzleDb.insert(linkClicks).values({
      domain: data.domain,
      slug: data.slug,
      targetUrl: data.targetUrl,
      queryString: data.queryString ?? null,
      referrer: data.referrer ?? null,
      userAgent: data.userAgent ?? null,
      country: data.country ?? null,
      city: data.city ?? null,
      colo: data.colo ?? null,
      continent: data.continent ?? null,
      httpProtocol: data.httpProtocol ?? null,
      timezone: data.timezone ?? null,
      ipAddress: data.ipAddress ?? null,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Link click recorded',
        domain: data.domain,
        slug: data.slug,
      })
    );
  } catch (error) {
    // Log error but don't throw - analytics should never break main functionality
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to record link click',
        error: error instanceof Error ? error.message : String(error),
        domain: data.domain,
        slug: data.slug,
      })
    );
  }
}

/**
 * Record a page view in the analytics database
 *
 * IMPORTANT: This function is designed to be called via waitUntil()
 * and should never throw errors that would affect the main response.
 * All errors are logged but swallowed.
 *
 * @param db - D1Database binding
 * @param data - Page view data to record
 */
export async function recordPageView(db: D1Database, data: PageViewData): Promise<void> {
  try {
    const drizzleDb = createDb(db);

    await drizzleDb.insert(pageViews).values({
      domain: data.domain,
      path: data.path,
      queryString: data.queryString ?? null,
      referrer: data.referrer ?? null,
      userAgent: data.userAgent ?? null,
      country: data.country ?? null,
      city: data.city ?? null,
      colo: data.colo ?? null,
      continent: data.continent ?? null,
      httpProtocol: data.httpProtocol ?? null,
      timezone: data.timezone ?? null,
      ipAddress: data.ipAddress ?? null,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Page view recorded',
        domain: data.domain,
        path: data.path,
      })
    );
  } catch (error) {
    // Log error but don't throw - analytics should never break main functionality
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to record page view',
        error: error instanceof Error ? error.message : String(error),
        domain: data.domain,
        path: data.path,
      })
    );
  }
}

/**
 * Cache status values for R2 file downloads
 */
export type CacheStatus = 'HIT' | 'MISS';

/**
 * Data for recording a file download
 */
export interface FileDownloadData {
  /** Domain that received the request */
  domain: string;
  /** Path that was requested */
  path: string;
  /** R2 object key that was served */
  r2Key: string;
  /** Content-Type of the served file */
  contentType?: string | null;
  /** File size in bytes */
  fileSize?: number | null;
  /** Cache status (HIT/MISS) from Cloudflare Cache API */
  cacheStatus?: CacheStatus | null;
  /** Query string from the request */
  queryString?: string | null;
  /** HTTP Referer header */
  referrer?: string | null;
  /** User-Agent header */
  userAgent?: string | null;
  /** Country code from Cloudflare cf.country */
  country?: string | null;
  /** City from Cloudflare cf.city */
  city?: string | null;
  /** Cloudflare datacenter code from cf.colo */
  colo?: string | null;
  /** Continent code from cf.continent */
  continent?: string | null;
  /** HTTP protocol version from cf.httpProtocol */
  httpProtocol?: string | null;
  /** IANA timezone from cf.timezone */
  timezone?: string | null;
  /** Client IP address */
  ipAddress?: string | null;
}

/**
 * Record a file download in the analytics database
 *
 * IMPORTANT: This function is designed to be called via waitUntil()
 * and should never throw errors that would affect the main response.
 * All errors are logged but swallowed.
 *
 * @param db - D1Database binding
 * @param data - File download data to record
 */
export async function recordFileDownload(db: D1Database, data: FileDownloadData): Promise<void> {
  try {
    const drizzleDb = createDb(db);

    await drizzleDb.insert(fileDownloads).values({
      domain: data.domain,
      path: data.path,
      r2Key: data.r2Key,
      contentType: data.contentType ?? null,
      fileSize: data.fileSize ?? null,
      cacheStatus: data.cacheStatus ?? null,
      queryString: data.queryString ?? null,
      referrer: data.referrer ?? null,
      userAgent: data.userAgent ?? null,
      country: data.country ?? null,
      city: data.city ?? null,
      colo: data.colo ?? null,
      continent: data.continent ?? null,
      httpProtocol: data.httpProtocol ?? null,
      timezone: data.timezone ?? null,
      ipAddress: data.ipAddress ?? null,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'File download recorded',
        domain: data.domain,
        path: data.path,
        r2Key: data.r2Key,
      })
    );
  } catch (error) {
    // Log error but don't throw - analytics should never break main functionality
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to record file download',
        error: error instanceof Error ? error.message : String(error),
        domain: data.domain,
        path: data.path,
        r2Key: data.r2Key,
      })
    );
  }
}

/**
 * Data for recording a proxy request
 */
export interface ProxyRequestData {
  /** Domain that received the request */
  domain: string;
  /** Path that was requested */
  path: string;
  /** Target URL being proxied to */
  targetUrl: string;
  /** HTTP response status code from proxy target */
  responseStatus?: number | null;
  /** Content-Type of the proxied response */
  contentType?: string | null;
  /** Content-Length of the proxied response */
  contentLength?: number | null;
  /** Query string from the request */
  queryString?: string | null;
  /** HTTP Referer header */
  referrer?: string | null;
  /** User-Agent header */
  userAgent?: string | null;
  /** Country code from Cloudflare cf.country */
  country?: string | null;
  /** City from Cloudflare cf.city */
  city?: string | null;
  /** Cloudflare datacenter code from cf.colo */
  colo?: string | null;
  /** Continent code from cf.continent */
  continent?: string | null;
  /** HTTP protocol version from cf.httpProtocol */
  httpProtocol?: string | null;
  /** IANA timezone from cf.timezone */
  timezone?: string | null;
  /** Client IP address */
  ipAddress?: string | null;
}

/**
 * Record a proxy request in the analytics database
 *
 * IMPORTANT: This function is designed to be called via waitUntil()
 * and should never throw errors that would affect the main response.
 * All errors are logged but swallowed.
 *
 * @param db - D1Database binding
 * @param data - Proxy request data to record
 */
export async function recordProxyRequest(db: D1Database, data: ProxyRequestData): Promise<void> {
  try {
    const drizzleDb = createDb(db);

    await drizzleDb.insert(proxyRequests).values({
      domain: data.domain,
      path: data.path,
      targetUrl: data.targetUrl,
      responseStatus: data.responseStatus ?? null,
      contentType: data.contentType ?? null,
      contentLength: data.contentLength ?? null,
      queryString: data.queryString ?? null,
      referrer: data.referrer ?? null,
      userAgent: data.userAgent ?? null,
      country: data.country ?? null,
      city: data.city ?? null,
      colo: data.colo ?? null,
      continent: data.continent ?? null,
      httpProtocol: data.httpProtocol ?? null,
      timezone: data.timezone ?? null,
      ipAddress: data.ipAddress ?? null,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Proxy request recorded',
        domain: data.domain,
        path: data.path,
        targetUrl: data.targetUrl,
      })
    );
  } catch (error) {
    // Log error but don't throw - analytics should never break main functionality
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to record proxy request',
        error: error instanceof Error ? error.message : String(error),
        domain: data.domain,
        path: data.path,
        targetUrl: data.targetUrl,
      })
    );
  }
}

/**
 * Audit action types
 */
export type AuditAction = 'create' | 'update' | 'delete' | 'toggle' | 'seed' | 'migrate';

/**
 * Data for recording an audit log entry
 */
export interface AuditLogData {
  /** Domain affected by the action */
  domain: string;
  /** Action type: create, update, delete, toggle, seed */
  action: AuditAction;
  /** Actor identifier from Tailscale-User-Login header, or 'api-key' */
  actorLogin?: string | null;
  /** Actor display name from Tailscale-User-Name header */
  actorName?: string | null;
  /** Route path affected by the action */
  path?: string | null;
  /** JSON string with action-specific details */
  details?: string | null;
  /** Client IP address */
  ipAddress?: string | null;
}

/**
 * Record an audit log entry in the database
 *
 * IMPORTANT: This function is designed to be called via waitUntil()
 * and should never throw errors that would affect the main response.
 * All errors are logged but swallowed.
 *
 * @param db - D1Database binding
 * @param data - Audit log data to record
 */
export async function recordAuditLog(db: D1Database, data: AuditLogData): Promise<void> {
  try {
    const drizzleDb = createDb(db);

    await drizzleDb.insert(auditLogs).values({
      domain: data.domain,
      action: data.action,
      actorLogin: data.actorLogin ?? null,
      actorName: data.actorName ?? null,
      path: data.path ?? null,
      details: data.details ?? null,
      ipAddress: data.ipAddress ?? null,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Audit log recorded',
        domain: data.domain,
        action: data.action,
        actor: data.actorLogin,
        path: data.path,
      })
    );
  } catch (error) {
    // Log error but don't throw - audit logging should never break main functionality
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Failed to record audit log',
        error: error instanceof Error ? error.message : String(error),
        domain: data.domain,
        action: data.action,
        path: data.path,
      })
    );
  }
}
