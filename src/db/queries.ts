import { sql, count, countDistinct, desc, gte, eq, and, isNotNull, like } from 'drizzle-orm';
import type { Database } from './index';
import { linkClicks, pageViews, fileDownloads, proxyRequests, auditLogs } from './schema';

/**
 * Query options for analytics endpoints
 */
export interface AnalyticsQueryOptions {
  /** Filter by domain */
  domain?: string;
  /** Time range in days (default: 30) */
  days?: number;
  /** Results per page (default: 100, max: 1000) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Filter clicks by slug */
  slug?: string;
  /** Filter views by path */
  path?: string;
  /** Filter by country code */
  country?: string;
  /** Filter downloads by R2 key */
  r2Key?: string;
  /** Filter proxy requests by target URL */
  targetUrl?: string;
}

/**
 * Top item with count
 */
export interface TopItem {
  name: string;
  count: number;
  extra?: string;
}

/**
 * Time series data point
 */
export interface TimeSeriesPoint {
  date: string;
  count: number;
}

/**
 * Analytics summary response
 */
export interface AnalyticsSummary {
  period: string;
  domain: string;
  clicks: {
    total: number;
    uniqueSlugs: number;
  };
  views: {
    total: number;
    uniquePaths: number;
  };
  topClicks: TopItem[];
  topPages: TopItem[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
  clicksByDay: TimeSeriesPoint[];
  viewsByDay: TimeSeriesPoint[];
  recentClicks: Array<{
    slug: string;
    target: string;
    country: string | null;
    createdAt: number;
  }>;
  recentViews: Array<{
    path: string;
    country: string | null;
    createdAt: number;
  }>;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * Calculate Unix timestamp for N days ago
 */
function getDaysAgoTimestamp(days: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - days * 24 * 60 * 60;
}

/**
 * Get analytics summary for dashboard
 */
export async function getAnalyticsSummary(
  db: Database,
  options: AnalyticsQueryOptions = {}
): Promise<AnalyticsSummary> {
  const { domain, days = 30 } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const clickConditions = [gte(linkClicks.createdAt, startTime)];
  const viewConditions = [gte(pageViews.createdAt, startTime)];

  if (domain) {
    clickConditions.push(eq(linkClicks.domain, domain));
    viewConditions.push(eq(pageViews.domain, domain));
  }

  // Execute queries in parallel for performance
  const [
    clickStats,
    viewStats,
    topClicks,
    topPages,
    topClickCountries,
    topReferrers,
    clicksByDay,
    viewsByDay,
    recentClicks,
    recentViews,
  ] = await Promise.all([
    // Click statistics
    db
      .select({
        total: count(),
        uniqueSlugs: countDistinct(linkClicks.slug),
      })
      .from(linkClicks)
      .where(and(...clickConditions)),

    // View statistics
    db
      .select({
        total: count(),
        uniquePaths: countDistinct(pageViews.path),
      })
      .from(pageViews)
      .where(and(...viewConditions)),

    // Top clicked links
    db
      .select({
        slug: linkClicks.slug,
        target: linkClicks.targetUrl,
        count: count(),
      })
      .from(linkClicks)
      .where(and(...clickConditions))
      .groupBy(linkClicks.slug, linkClicks.targetUrl)
      .orderBy(desc(count()))
      .limit(10),

    // Top viewed pages
    db
      .select({
        path: pageViews.path,
        count: count(),
      })
      .from(pageViews)
      .where(and(...viewConditions))
      .groupBy(pageViews.path)
      .orderBy(desc(count()))
      .limit(10),

    // Top countries (clicks)
    db
      .select({
        country: linkClicks.country,
        count: count(),
      })
      .from(linkClicks)
      .where(and(...clickConditions, isNotNull(linkClicks.country)))
      .groupBy(linkClicks.country)
      .orderBy(desc(count()))
      .limit(10),

    // Top referrers (clicks)
    db
      .select({
        referrer: linkClicks.referrer,
        count: count(),
      })
      .from(linkClicks)
      .where(and(...clickConditions, isNotNull(linkClicks.referrer)))
      .groupBy(linkClicks.referrer)
      .orderBy(desc(count()))
      .limit(10),

    // Clicks by day (raw SQL for DATE function)
    db.all<{ date: string; count: number }>(sql`
      SELECT DATE(created_at, 'unixepoch') as date, COUNT(*) as count
      FROM link_clicks
      WHERE created_at >= ${startTime}
      ${domain ? sql`AND domain = ${domain}` : sql``}
      GROUP BY date
      ORDER BY date ASC
    `),

    // Views by day
    db.all<{ date: string; count: number }>(sql`
      SELECT DATE(created_at, 'unixepoch') as date, COUNT(*) as count
      FROM page_views
      WHERE created_at >= ${startTime}
      ${domain ? sql`AND domain = ${domain}` : sql``}
      GROUP BY date
      ORDER BY date ASC
    `),

    // Recent clicks
    db
      .select({
        slug: linkClicks.slug,
        target: linkClicks.targetUrl,
        country: linkClicks.country,
        createdAt: linkClicks.createdAt,
      })
      .from(linkClicks)
      .where(and(...clickConditions))
      .orderBy(desc(linkClicks.createdAt))
      .limit(5),

    // Recent views
    db
      .select({
        path: pageViews.path,
        country: pageViews.country,
        createdAt: pageViews.createdAt,
      })
      .from(pageViews)
      .where(and(...viewConditions))
      .orderBy(desc(pageViews.createdAt))
      .limit(5),
  ]);

  return {
    period: `${days}d`,
    domain: domain || 'all',
    clicks: {
      total: clickStats[0]?.total ?? 0,
      uniqueSlugs: clickStats[0]?.uniqueSlugs ?? 0,
    },
    views: {
      total: viewStats[0]?.total ?? 0,
      uniquePaths: viewStats[0]?.uniquePaths ?? 0,
    },
    topClicks: topClicks.map((r) => ({
      name: r.slug,
      count: r.count,
      extra: r.target,
    })),
    topPages: topPages.map((r) => ({
      name: r.path,
      count: r.count,
    })),
    topCountries: topClickCountries.map((r) => ({
      name: r.country ?? 'Unknown',
      count: r.count,
    })),
    topReferrers: topReferrers.map((r) => ({
      name: r.referrer ?? 'Direct',
      count: r.count,
    })),
    clicksByDay: clicksByDay ?? [],
    viewsByDay: viewsByDay ?? [],
    recentClicks,
    recentViews,
  };
}

/**
 * Get paginated list of link clicks
 */
export async function getClicks(
  db: Database,
  options: AnalyticsQueryOptions = {}
): Promise<PaginatedResponse<typeof linkClicks.$inferSelect>> {
  const { domain, days = 30, limit = 100, offset = 0, slug, country } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const conditions = [gte(linkClicks.createdAt, startTime)];
  if (domain) conditions.push(eq(linkClicks.domain, domain));
  if (slug) conditions.push(eq(linkClicks.slug, slug));
  if (country) conditions.push(eq(linkClicks.country, country));

  // Get total count and items in parallel
  const [countResult, items] = await Promise.all([
    db
      .select({ total: count() })
      .from(linkClicks)
      .where(and(...conditions)),
    db
      .select()
      .from(linkClicks)
      .where(and(...conditions))
      .orderBy(desc(linkClicks.createdAt))
      .limit(Math.min(limit, 1000))
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;

  return {
    items,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  };
}

/**
 * Get paginated list of page views
 */
export async function getViews(
  db: Database,
  options: AnalyticsQueryOptions = {}
): Promise<PaginatedResponse<typeof pageViews.$inferSelect>> {
  const { domain, days = 30, limit = 100, offset = 0, path, country } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const conditions = [gte(pageViews.createdAt, startTime)];
  if (domain) conditions.push(eq(pageViews.domain, domain));
  if (path) conditions.push(eq(pageViews.path, path));
  if (country) conditions.push(eq(pageViews.country, country));

  // Get total count and items in parallel
  const [countResult, items] = await Promise.all([
    db
      .select({ total: count() })
      .from(pageViews)
      .where(and(...conditions)),
    db
      .select()
      .from(pageViews)
      .where(and(...conditions))
      .orderBy(desc(pageViews.createdAt))
      .limit(Math.min(limit, 1000))
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;

  return {
    items,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  };
}

/**
 * Get statistics for a specific slug
 */
export async function getSlugStats(
  db: Database,
  targetSlug: string,
  options: AnalyticsQueryOptions = {}
): Promise<{
  slug: string;
  totalClicks: number;
  target: string | null;
  clicksByDay: TimeSeriesPoint[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
}> {
  const { domain, days = 30 } = options;
  const startTime = getDaysAgoTimestamp(days);

  const conditions = [
    gte(linkClicks.createdAt, startTime),
    eq(linkClicks.slug, targetSlug),
  ];
  if (domain) conditions.push(eq(linkClicks.domain, domain));

  const [stats, clicksByDay, topCountries, topReferrers] = await Promise.all([
    db
      .select({
        total: count(),
        target: linkClicks.targetUrl,
      })
      .from(linkClicks)
      .where(and(...conditions))
      .groupBy(linkClicks.targetUrl)
      .limit(1),

    db.all<{ date: string; count: number }>(sql`
      SELECT DATE(created_at, 'unixepoch') as date, COUNT(*) as count
      FROM link_clicks
      WHERE created_at >= ${startTime} AND slug = ${targetSlug}
      ${domain ? sql`AND domain = ${domain}` : sql``}
      GROUP BY date
      ORDER BY date ASC
    `),

    db
      .select({
        country: linkClicks.country,
        count: count(),
      })
      .from(linkClicks)
      .where(and(...conditions, isNotNull(linkClicks.country)))
      .groupBy(linkClicks.country)
      .orderBy(desc(count()))
      .limit(10),

    db
      .select({
        referrer: linkClicks.referrer,
        count: count(),
      })
      .from(linkClicks)
      .where(and(...conditions, isNotNull(linkClicks.referrer)))
      .groupBy(linkClicks.referrer)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  return {
    slug: targetSlug,
    totalClicks: stats[0]?.total ?? 0,
    target: stats[0]?.target ?? null,
    clicksByDay: clicksByDay ?? [],
    topCountries: topCountries.map((r) => ({
      name: r.country ?? 'Unknown',
      count: r.count,
    })),
    topReferrers: topReferrers.map((r) => ({
      name: r.referrer ?? 'Direct',
      count: r.count,
    })),
  };
}

/**
 * Get paginated list of file downloads
 */
export async function getDownloads(
  db: Database,
  options: AnalyticsQueryOptions = {}
): Promise<PaginatedResponse<typeof fileDownloads.$inferSelect>> {
  const { domain, days = 30, limit = 100, offset = 0, path, r2Key, country } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const conditions = [gte(fileDownloads.createdAt, startTime)];
  if (domain) conditions.push(eq(fileDownloads.domain, domain));
  if (path) conditions.push(eq(fileDownloads.path, path));
  if (r2Key) conditions.push(eq(fileDownloads.r2Key, r2Key));
  if (country) conditions.push(eq(fileDownloads.country, country));

  // Get total count and items in parallel
  const [countResult, items] = await Promise.all([
    db
      .select({ total: count() })
      .from(fileDownloads)
      .where(and(...conditions)),
    db
      .select()
      .from(fileDownloads)
      .where(and(...conditions))
      .orderBy(desc(fileDownloads.createdAt))
      .limit(Math.min(limit, 1000))
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;

  return {
    items,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  };
}

/**
 * Get statistics for a specific file download path
 */
export async function getDownloadStats(
  db: Database,
  targetPath: string,
  options: AnalyticsQueryOptions = {}
): Promise<{
  path: string;
  totalDownloads: number;
  r2Key: string | null;
  totalBytes: number;
  downloadsByDay: TimeSeriesPoint[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
}> {
  const { domain, days = 30 } = options;
  const startTime = getDaysAgoTimestamp(days);

  const conditions = [
    gte(fileDownloads.createdAt, startTime),
    eq(fileDownloads.path, targetPath),
  ];
  if (domain) conditions.push(eq(fileDownloads.domain, domain));

  const [stats, totalBytesResult, downloadsByDay, topCountries, topReferrers] = await Promise.all([
    db
      .select({
        total: count(),
        r2Key: fileDownloads.r2Key,
      })
      .from(fileDownloads)
      .where(and(...conditions))
      .groupBy(fileDownloads.r2Key)
      .limit(1),

    db.all<{ totalBytes: number }>(sql`
      SELECT COALESCE(SUM(file_size), 0) as totalBytes
      FROM file_downloads
      WHERE created_at >= ${startTime} AND path = ${targetPath}
      ${domain ? sql`AND domain = ${domain}` : sql``}
    `),

    db.all<{ date: string; count: number }>(sql`
      SELECT DATE(created_at, 'unixepoch') as date, COUNT(*) as count
      FROM file_downloads
      WHERE created_at >= ${startTime} AND path = ${targetPath}
      ${domain ? sql`AND domain = ${domain}` : sql``}
      GROUP BY date
      ORDER BY date ASC
    `),

    db
      .select({
        country: fileDownloads.country,
        count: count(),
      })
      .from(fileDownloads)
      .where(and(...conditions, isNotNull(fileDownloads.country)))
      .groupBy(fileDownloads.country)
      .orderBy(desc(count()))
      .limit(10),

    db
      .select({
        referrer: fileDownloads.referrer,
        count: count(),
      })
      .from(fileDownloads)
      .where(and(...conditions, isNotNull(fileDownloads.referrer)))
      .groupBy(fileDownloads.referrer)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  return {
    path: targetPath,
    totalDownloads: stats[0]?.total ?? 0,
    r2Key: stats[0]?.r2Key ?? null,
    totalBytes: totalBytesResult?.[0]?.totalBytes ?? 0,
    downloadsByDay: downloadsByDay ?? [],
    topCountries: topCountries.map((r) => ({
      name: r.country ?? 'Unknown',
      count: r.count,
    })),
    topReferrers: topReferrers.map((r) => ({
      name: r.referrer ?? 'Direct',
      count: r.count,
    })),
  };
}

/**
 * Get paginated list of proxy requests
 */
export async function getProxyRequests(
  db: Database,
  options: AnalyticsQueryOptions = {}
): Promise<PaginatedResponse<typeof proxyRequests.$inferSelect>> {
  const { domain, days = 30, limit = 100, offset = 0, path, targetUrl, country } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const conditions = [gte(proxyRequests.createdAt, startTime)];
  if (domain) conditions.push(eq(proxyRequests.domain, domain));
  if (path) conditions.push(eq(proxyRequests.path, path));
  if (targetUrl) conditions.push(eq(proxyRequests.targetUrl, targetUrl));
  if (country) conditions.push(eq(proxyRequests.country, country));

  // Get total count and items in parallel
  const [countResult, items] = await Promise.all([
    db
      .select({ total: count() })
      .from(proxyRequests)
      .where(and(...conditions)),
    db
      .select()
      .from(proxyRequests)
      .where(and(...conditions))
      .orderBy(desc(proxyRequests.createdAt))
      .limit(Math.min(limit, 1000))
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;

  return {
    items,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  };
}

/**
 * Get statistics for a specific proxy path
 */
export async function getProxyStats(
  db: Database,
  targetPath: string,
  options: AnalyticsQueryOptions = {}
): Promise<{
  path: string;
  totalRequests: number;
  targetUrl: string | null;
  requestsByDay: TimeSeriesPoint[];
  topCountries: TopItem[];
  topReferrers: TopItem[];
  statusCodes: TopItem[];
}> {
  const { domain, days = 30 } = options;
  const startTime = getDaysAgoTimestamp(days);

  const conditions = [
    gte(proxyRequests.createdAt, startTime),
    eq(proxyRequests.path, targetPath),
  ];
  if (domain) conditions.push(eq(proxyRequests.domain, domain));

  const [stats, requestsByDay, topCountries, topReferrers, statusCodes] = await Promise.all([
    db
      .select({
        total: count(),
        targetUrl: proxyRequests.targetUrl,
      })
      .from(proxyRequests)
      .where(and(...conditions))
      .groupBy(proxyRequests.targetUrl)
      .limit(1),

    db.all<{ date: string; count: number }>(sql`
      SELECT DATE(created_at, 'unixepoch') as date, COUNT(*) as count
      FROM proxy_requests
      WHERE created_at >= ${startTime} AND path = ${targetPath}
      ${domain ? sql`AND domain = ${domain}` : sql``}
      GROUP BY date
      ORDER BY date ASC
    `),

    db
      .select({
        country: proxyRequests.country,
        count: count(),
      })
      .from(proxyRequests)
      .where(and(...conditions, isNotNull(proxyRequests.country)))
      .groupBy(proxyRequests.country)
      .orderBy(desc(count()))
      .limit(10),

    db
      .select({
        referrer: proxyRequests.referrer,
        count: count(),
      })
      .from(proxyRequests)
      .where(and(...conditions, isNotNull(proxyRequests.referrer)))
      .groupBy(proxyRequests.referrer)
      .orderBy(desc(count()))
      .limit(10),

    db
      .select({
        status: proxyRequests.responseStatus,
        count: count(),
      })
      .from(proxyRequests)
      .where(and(...conditions, isNotNull(proxyRequests.responseStatus)))
      .groupBy(proxyRequests.responseStatus)
      .orderBy(desc(count()))
      .limit(10),
  ]);

  return {
    path: targetPath,
    totalRequests: stats[0]?.total ?? 0,
    targetUrl: stats[0]?.targetUrl ?? null,
    requestsByDay: requestsByDay ?? [],
    topCountries: topCountries.map((r) => ({
      name: r.country ?? 'Unknown',
      count: r.count,
    })),
    topReferrers: topReferrers.map((r) => ({
      name: r.referrer ?? 'Direct',
      count: r.count,
    })),
    statusCodes: statusCodes.map((r) => ({
      name: String(r.status ?? 'Unknown'),
      count: r.count,
    })),
  };
}

/**
 * Query options for audit logs
 */
export interface AuditQueryOptions {
  /** Filter by domain */
  domain?: string;
  /** Filter by action type */
  action?: string;
  /** Filter by actor login */
  actor?: string;
  /** Search by path */
  path?: string;
  /** Time range in days (default: 30) */
  days?: number;
  /** Results per page (default: 100, max: 1000) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Get paginated list of audit logs
 */
export async function getAuditLogs(
  db: Database,
  options: AuditQueryOptions = {}
): Promise<PaginatedResponse<typeof auditLogs.$inferSelect>> {
  const { domain, action, actor, path, days = 30, limit = 100, offset = 0 } = options;
  const startTime = getDaysAgoTimestamp(days);

  // Build where conditions
  const conditions = [gte(auditLogs.createdAt, startTime)];
  if (domain) conditions.push(eq(auditLogs.domain, domain));
  if (action) conditions.push(eq(auditLogs.action, action));
  if (actor) conditions.push(eq(auditLogs.actorLogin, actor));
  if (path) conditions.push(like(auditLogs.path, `%${path}%`));

  // Get total count and items in parallel
  const [countResult, items] = await Promise.all([
    db
      .select({ total: count() })
      .from(auditLogs)
      .where(and(...conditions)),
    db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(Math.min(limit, 1000))
      .offset(offset),
  ]);

  const total = countResult[0]?.total ?? 0;

  return {
    items,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  };
}
