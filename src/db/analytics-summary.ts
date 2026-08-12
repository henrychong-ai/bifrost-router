import { sql } from 'drizzle-orm';
import {
  CLOUDFLARE_HEALTHCHECK_UA_TOKEN,
  MONITORING_CLASSIFIER,
  analyticsDeltaPercent,
  analyticsShare,
  canonicalAnalyticsUrl,
  normalizeAnalyticsPath,
  type AnalyticsSummary,
} from '@bifrost/shared';
import type { Database } from './index';

export interface AnalyticsSummaryOptions {
  domain?: string;
  days?: number;
  country?: string;
  search?: string;
  includeMonitoring?: boolean;
  unifiedTrafficEnabled?: boolean;
  unifiedTrafficMode?: 'off' | 'shadow';
  unifiedTrafficCutoverAt?: number | null;
  unifiedTrafficRetentionDays?: number | null;
}

function getDaysAgoTimestamp(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
}

function domainFilter(domain?: string) {
  return domain ? sql`AND domain = ${domain}` : sql``;
}

function countryFilter(country?: string) {
  return country ? sql`AND country = ${country}` : sql``;
}

function monitoringFilter(includeMonitoring: boolean) {
  return includeMonitoring
    ? sql``
    : sql`AND (user_agent IS NULL OR instr(user_agent, ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}) = 0)`;
}

function searchFilter(search: string | undefined, kind: 'click' | 'view' | 'download' | 'proxy') {
  if (!search) return sql``;
  const pathColumn = kind === 'click' ? sql`slug` : sql`path`;
  const targetColumn =
    kind === 'click' || kind === 'proxy'
      ? sql`target_url`
      : kind === 'download'
        ? sql`r2_key`
        : sql`NULL`;
  return sql`AND (
    instr(lower(coalesce(domain, '')), lower(${search})) > 0 OR
    instr(lower(coalesce(${pathColumn}, '')), lower(${search})) > 0 OR
    instr(lower(coalesce(${targetColumn}, '')), lower(${search})) > 0 OR
    instr(lower(coalesce(referrer, '')), lower(${search})) > 0
  )`;
}

function normalizedPath(column: 'slug' | 'path') {
  const value = column === 'slug' ? sql`slug` : sql`path`;
  return sql`CASE
    WHEN TRIM(${value}) = '' OR LTRIM(TRIM(${value}), '/') = '' THEN '/'
    ELSE '/' || LTRIM(TRIM(${value}), '/')
  END`;
}

/** Bound D1 work to the documented six simultaneous connections. */
export function createAnalyticsConcurrencyLimiter(maxConcurrent = 6) {
  const active = new Set<Promise<void>>();
  return async function run<T>(operation: () => PromiseLike<T>): Promise<T> {
    while (active.size >= maxConcurrent) await Promise.race(active);
    const pending = Promise.resolve().then(operation);
    const slot = pending.then(
      () => undefined,
      () => undefined,
    );
    active.add(slot);
    try {
      return await pending;
    } finally {
      active.delete(slot);
    }
  };
}

type StreamStats = {
  total: number;
  previousTotal: number;
  uniqueUrls: number;
  totalBytes?: number;
  cacheHits?: number;
  cacheKnown?: number;
  errorCount?: number;
};

type LeaderRow = {
  domain: string;
  path: string;
  targetUrl?: string;
  count: number;
  previousCount: number;
};

type RecentRow = {
  eventId: string;
  type: 'click' | 'view' | 'download' | 'proxy';
  domain: string;
  path: string;
  targetUrl: string | null;
  country: string | null;
  createdAt: number;
};

/**
 * Build the dashboard read model from four legacy streams plus an explicitly
 * separate unified shadow count. Unified rows never affect headline totals.
 */
export async function getAnalyticsSummary(
  db: Database,
  options: AnalyticsSummaryOptions = {},
): Promise<AnalyticsSummary> {
  const days = options.days ?? 30;
  const startTime = getDaysAgoTimestamp(days);
  const previousStartTime = getDaysAgoTimestamp(days * 2);
  const domain = options.domain;
  const country = options.country;
  const search = options.search?.trim() || undefined;
  const includeMonitoring = options.includeMonitoring ?? false;
  const clickPath = normalizedPath('slug');
  const routePath = normalizedPath('path');
  const run = createAnalyticsConcurrencyLimiter();
  const all = <T>(query: ReturnType<typeof sql>) => run(() => db.all<T>(query));

  const [
    clickStatsRows,
    viewStatsRows,
    downloadStatsRows,
    proxyStatsRows,
    topClickRows,
    topPageRows,
    topProxyRows,
    topCountryRows,
    topReferrerRows,
    activityRows,
    recentRows,
    topDomainRows,
    overviewRows,
    monitoringRows,
    unifiedRows,
  ] = await Promise.all([
    all<StreamStats>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END), 0) AS "previousTotal",
        COUNT(DISTINCT CASE WHEN created_at >= ${startTime} THEN domain || CHAR(31) || ${clickPath} END) AS "uniqueUrls"
      FROM link_clicks WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'click')}
    `),
    all<StreamStats>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END), 0) AS "previousTotal",
        COUNT(DISTINCT CASE WHEN created_at >= ${startTime} THEN domain || CHAR(31) || ${routePath} END) AS "uniqueUrls"
      FROM page_views WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'view')}
    `),
    all<StreamStats>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END), 0) AS "previousTotal",
        0 AS "uniqueUrls",
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} THEN file_size ELSE 0 END), 0) AS "totalBytes",
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} AND cache_status = 'HIT' THEN 1 ELSE 0 END), 0) AS "cacheHits",
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} AND cache_status IN ('HIT', 'MISS') THEN 1 ELSE 0 END), 0) AS "cacheKnown"
      FROM file_downloads WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'download')}
    `),
    all<StreamStats>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END), 0) AS "previousTotal",
        0 AS "uniqueUrls",
        COALESCE(SUM(CASE WHEN created_at >= ${startTime} AND response_status >= 500 THEN 1 ELSE 0 END), 0) AS "errorCount"
      FROM proxy_requests WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'proxy')}
    `),
    all<LeaderRow>(sql`
      SELECT domain, ${clickPath} AS path, target_url AS "targetUrl",
        SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END) AS "previousCount"
      FROM link_clicks WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'click')}
      GROUP BY domain, ${clickPath}, target_url HAVING count > 0
      ORDER BY count DESC, domain ASC, path ASC, "targetUrl" ASC LIMIT 10
    `),
    all<LeaderRow>(sql`
      SELECT domain, ${routePath} AS path,
        SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END) AS "previousCount"
      FROM page_views WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'view')}
      GROUP BY domain, ${routePath} HAVING count > 0
      ORDER BY count DESC, domain ASC, path ASC LIMIT 10
    `),
    all<LeaderRow>(sql`
      SELECT domain, ${routePath} AS path, target_url AS "targetUrl",
        SUM(CASE WHEN created_at >= ${startTime} THEN 1 ELSE 0 END) AS count,
        SUM(CASE WHEN created_at >= ${previousStartTime} AND created_at < ${startTime} THEN 1 ELSE 0 END) AS "previousCount"
      FROM proxy_requests WHERE created_at >= ${previousStartTime}
      ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)}
      ${searchFilter(search, 'proxy')}
      GROUP BY domain, ${routePath}, target_url HAVING count > 0
      ORDER BY count DESC, domain ASC, path ASC, "targetUrl" ASC LIMIT 10
    `),
    all<{ name: string; count: number }>(sql`
      SELECT country AS name, SUM(n) AS count FROM (
        SELECT country, COUNT(*) n FROM link_clicks WHERE created_at >= ${startTime} AND country IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')} GROUP BY country
        UNION ALL SELECT country, COUNT(*) FROM page_views WHERE created_at >= ${startTime} AND country IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')} GROUP BY country
        UNION ALL SELECT country, COUNT(*) FROM file_downloads WHERE created_at >= ${startTime} AND country IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')} GROUP BY country
        UNION ALL SELECT country, COUNT(*) FROM proxy_requests WHERE created_at >= ${startTime} AND country IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')} GROUP BY country
      ) GROUP BY country ORDER BY count DESC, name ASC LIMIT 10
    `),
    all<{ name: string; count: number }>(sql`
      SELECT referrer AS name, SUM(n) AS count FROM (
        SELECT referrer, COUNT(*) n FROM link_clicks WHERE created_at >= ${startTime} AND referrer IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')} GROUP BY referrer
        UNION ALL SELECT referrer, COUNT(*) FROM page_views WHERE created_at >= ${startTime} AND referrer IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')} GROUP BY referrer
        UNION ALL SELECT referrer, COUNT(*) FROM file_downloads WHERE created_at >= ${startTime} AND referrer IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')} GROUP BY referrer
        UNION ALL SELECT referrer, COUNT(*) FROM proxy_requests WHERE created_at >= ${startTime} AND referrer IS NOT NULL ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')} GROUP BY referrer
      ) GROUP BY referrer ORDER BY count DESC, name ASC LIMIT 10
    `),
    all<{
      date: string;
      clicks: number;
      views: number;
      downloads: number;
      proxy: number;
      total: number;
    }>(sql`
      SELECT date, SUM(clicks) clicks, SUM(views) views, SUM(downloads) downloads, SUM(proxy) proxy,
        SUM(clicks + views + downloads + proxy) total FROM (
        SELECT DATE(created_at, 'unixepoch') date, COUNT(*) clicks, 0 views, 0 downloads, 0 proxy FROM link_clicks WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')} GROUP BY date
        UNION ALL SELECT DATE(created_at, 'unixepoch'), 0, COUNT(*), 0, 0 FROM page_views WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')} GROUP BY DATE(created_at, 'unixepoch')
        UNION ALL SELECT DATE(created_at, 'unixepoch'), 0, 0, COUNT(*), 0 FROM file_downloads WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')} GROUP BY DATE(created_at, 'unixepoch')
        UNION ALL SELECT DATE(created_at, 'unixepoch'), 0, 0, 0, COUNT(*) FROM proxy_requests WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')} GROUP BY DATE(created_at, 'unixepoch')
      ) GROUP BY date ORDER BY date ASC
    `),
    all<RecentRow>(sql`
      SELECT eventId, type, domain, path, targetUrl, country, createdAt FROM (
        SELECT 'click:' || id eventId, 'click' type, domain, ${clickPath} path, target_url targetUrl, country, created_at createdAt FROM link_clicks WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')}
        UNION ALL SELECT 'view:' || id, 'view', domain, ${routePath}, NULL, country, created_at FROM page_views WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')}
        UNION ALL SELECT 'download:' || id, 'download', domain, ${routePath}, NULL, country, created_at FROM file_downloads WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')}
        UNION ALL SELECT 'proxy:' || id, 'proxy', domain, ${routePath}, target_url, country, created_at FROM proxy_requests WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')}
      ) ORDER BY createdAt DESC, eventId DESC LIMIT 20
    `),
    all<{ domain: string; count: number }>(sql`
      SELECT domain, SUM(n) count FROM (
        SELECT domain, COUNT(*) n FROM link_clicks WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')} GROUP BY domain
        UNION ALL SELECT domain, COUNT(*) FROM page_views WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')} GROUP BY domain
        UNION ALL SELECT domain, COUNT(*) FROM file_downloads WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')} GROUP BY domain
        UNION ALL SELECT domain, COUNT(*) FROM proxy_requests WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')} GROUP BY domain
      ) GROUP BY domain ORDER BY count DESC, domain ASC LIMIT 10
    `),
    all<{ activeDomains: number; uniqueUrls: number }>(sql`
      SELECT COUNT(DISTINCT domain) "activeDomains", COUNT(DISTINCT domain || CHAR(31) || path) "uniqueUrls" FROM (
        SELECT domain, ${clickPath} path FROM link_clicks WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'click')}
        UNION ALL SELECT domain, ${routePath} FROM page_views WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'view')}
        UNION ALL SELECT domain, ${routePath} FROM file_downloads WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'download')}
        UNION ALL SELECT domain, ${routePath} FROM proxy_requests WHERE created_at >= ${startTime} ${domainFilter(domain)} ${countryFilter(country)} ${monitoringFilter(includeMonitoring)} ${searchFilter(search, 'proxy')}
      )
    `),
    all<{ type: 'clicks' | 'views' | 'downloads' | 'proxy'; count: number }>(sql`
      SELECT type, COUNT(*) count FROM (
        SELECT 'clicks' type FROM link_clicks WHERE created_at >= ${startTime} AND user_agent IS NOT NULL AND instr(user_agent, ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}) > 0 ${domainFilter(domain)} ${countryFilter(country)} ${searchFilter(search, 'click')}
        UNION ALL SELECT 'views' FROM page_views WHERE created_at >= ${startTime} AND user_agent IS NOT NULL AND instr(user_agent, ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}) > 0 ${domainFilter(domain)} ${countryFilter(country)} ${searchFilter(search, 'view')}
        UNION ALL SELECT 'downloads' FROM file_downloads WHERE created_at >= ${startTime} AND user_agent IS NOT NULL AND instr(user_agent, ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}) > 0 ${domainFilter(domain)} ${countryFilter(country)} ${searchFilter(search, 'download')}
        UNION ALL SELECT 'proxy' FROM proxy_requests WHERE created_at >= ${startTime} AND user_agent IS NOT NULL AND instr(user_agent, ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}) > 0 ${domainFilter(domain)} ${countryFilter(country)} ${searchFilter(search, 'proxy')}
      ) GROUP BY type
    `),
    options.unifiedTrafficCutoverAt === null || options.unifiedTrafficCutoverAt === undefined
      ? Promise.resolve([] as Array<{ recordedRequests: number }>)
      : all<{ recordedRequests: number }>(sql`
          SELECT COUNT(*) "recordedRequests" FROM unified_traffic_events
          WHERE created_at >= ${startTime} ${domainFilter(domain)}
          ${countryFilter(country)}
          ${search ? sql`AND (instr(lower(domain), lower(${search})) > 0 OR instr(lower(path), lower(${search})) > 0)` : sql``}
        `),
  ]);

  const clicks = clickStatsRows[0] ?? { total: 0, previousTotal: 0, uniqueUrls: 0 };
  const views = viewStatsRows[0] ?? { total: 0, previousTotal: 0, uniqueUrls: 0 };
  const downloads = downloadStatsRows[0] ?? { total: 0, previousTotal: 0, uniqueUrls: 0 };
  const proxy = proxyStatsRows[0] ?? { total: 0, previousTotal: 0, uniqueUrls: 0 };
  const recordedEvents = clicks.total + views.total + downloads.total + proxy.total;
  const previousRecordedEvents =
    clicks.previousTotal + views.previousTotal + downloads.previousTotal + proxy.previousTotal;
  const cacheHitRate = downloads.cacheKnown
    ? (downloads.cacheHits ?? 0) / downloads.cacheKnown
    : null;
  const proxyErrorRate = proxy.total ? (proxy.errorCount ?? 0) / proxy.total : null;
  const monitoring = { clicks: 0, views: 0, downloads: 0, proxy: 0 };
  for (const row of monitoringRows) monitoring[row.type] = row.count;
  const monitoringTotal =
    monitoring.clicks + monitoring.views + monitoring.downloads + monitoring.proxy;

  const insights: AnalyticsSummary['insights'] = [];
  const trafficDelta = analyticsDeltaPercent(recordedEvents, previousRecordedEvents);
  if (trafficDelta !== null && Math.abs(trafficDelta) >= 25 && recordedEvents >= 10) {
    insights.push({
      id: 'traffic-change',
      severity: trafficDelta > 0 ? 'positive' : 'warning',
      title: `Recorded traffic ${trafficDelta > 0 ? 'increased' : 'decreased'} materially`,
      description: `${Math.abs(trafficDelta).toFixed(1)}% change versus the previous ${days}-day period. Review routes and monitoring before treating this as demand change.`,
      href: '/routes',
    });
  }
  if (proxy.total >= 5 && proxyErrorRate !== null && proxyErrorRate >= 0.05) {
    insights.push({
      id: 'proxy-errors',
      severity: 'warning',
      title: 'Proxy 5xx rate needs attention',
      description: `${Math.round(proxyErrorRate * 100)}% of recorded proxy requests returned 5xx responses.`,
      href: '/analytics/proxy',
    });
  }
  if ((downloads.cacheKnown ?? 0) >= 10 && cacheHitRate !== null && cacheHitRate < 0.5) {
    insights.push({
      id: 'cache-hit-rate',
      severity: 'warning',
      title: 'Download cache hit rate is low',
      description: `Only ${Math.round(cacheHitRate * 100)}% of downloads with cache metadata were hits.`,
      href: '/analytics/downloads',
    });
  }
  if (monitoringTotal > 0) {
    insights.push({
      id: 'monitoring-traffic',
      severity: 'info',
      title: `Monitoring traffic ${includeMonitoring ? 'included' : 'excluded'}`,
      description: `${monitoringTotal.toLocaleString()} Cloudflare Health Checks rows match the current filters.`,
      href: null,
    });
  }
  const scannerPattern =
    /(?:^|\/)(?:wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|actuator|vendor\/phpunit)|(?:^|\/)\.env(?:$|\/)/i;
  const scannerCount = [...topClickRows, ...topPageRows, ...topProxyRows]
    .filter(row => scannerPattern.test(normalizeAnalyticsPath(row.path)))
    .reduce((sum, row) => sum + row.count, 0);
  if (scannerCount >= 3) {
    insights.push({
      id: 'scanner-noise',
      severity: 'warning',
      title: 'Scanner-like paths are prominent',
      description: `At least ${scannerCount.toLocaleString()} events in the current leaders target common probe paths. They remain visible for investigation.`,
      href: '/analytics/redirects',
    });
  }
  insights.push({
    id: 'partial-coverage',
    severity: 'info',
    title: 'Historical coverage is partial',
    description:
      'Legacy streams are useful operational signals, but they are not a count of every routed request.',
    href: '/guide#analytics-and-audit',
  });

  const recentActivity = recentRows.map(row => ({
    ...row,
    path: normalizeAnalyticsPath(row.path),
    sourceUrl: canonicalAnalyticsUrl(row.domain, row.path),
  }));

  return {
    period: `${days}d`,
    domain: domain ?? 'all',
    clicks: {
      total: clicks.total,
      previousTotal: clicks.previousTotal,
      deltaPercent: analyticsDeltaPercent(clicks.total, clicks.previousTotal),
      uniqueUrls: clicks.uniqueUrls,
      uniqueSlugs: clicks.uniqueUrls,
    },
    views: {
      total: views.total,
      previousTotal: views.previousTotal,
      deltaPercent: analyticsDeltaPercent(views.total, views.previousTotal),
      uniqueUrls: views.uniqueUrls,
      uniquePaths: views.uniqueUrls,
    },
    downloads: {
      total: downloads.total,
      previousTotal: downloads.previousTotal,
      deltaPercent: analyticsDeltaPercent(downloads.total, downloads.previousTotal),
      totalBytes: downloads.totalBytes ?? 0,
      cacheHitRate,
    },
    proxy: {
      total: proxy.total,
      previousTotal: proxy.previousTotal,
      deltaPercent: analyticsDeltaPercent(proxy.total, proxy.previousTotal),
      errorCount: proxy.errorCount ?? 0,
      errorRate: proxyErrorRate,
    },
    overview: {
      recordedEvents,
      previousRecordedEvents,
      deltaPercent: trafficDelta,
      activeDomains: overviewRows[0]?.activeDomains ?? 0,
      uniqueUrls: overviewRows[0]?.uniqueUrls ?? 0,
    },
    filters: { days, country: country ?? null, search: search ?? null, includeMonitoring },
    monitoring: {
      included: includeMonitoring,
      classifier: MONITORING_CLASSIFIER,
      rows: { ...monitoring, total: monitoringTotal },
    },
    coverage: {
      status: 'partial',
      cutoverAt: options.unifiedTrafficCutoverAt ?? null,
      note: 'Headline totals use legacy event streams. Unified shadow rows remain separate until an operator validates reconciliation.',
      unifiedTraffic: {
        mode: options.unifiedTrafficMode ?? 'off',
        enabled: options.unifiedTrafficEnabled ?? false,
        retentionDays: options.unifiedTrafficRetentionDays ?? null,
        recordedRequests: unifiedRows[0]?.recordedRequests ?? 0,
        reconciled: false,
        includedInHeadline: false,
      },
      streams: {
        clicks: 'Redirect responses recorded by Bifrost.',
        views: 'HTML responses served through a configured service binding.',
        downloads: 'Successful R2-backed responses recorded by Bifrost.',
        proxy: 'Reverse-proxy responses recorded by Bifrost.',
      },
    },
    topClicks: topClickRows.map(row => ({
      domain: row.domain,
      path: normalizeAnalyticsPath(row.path),
      sourceUrl: canonicalAnalyticsUrl(row.domain, row.path),
      targetUrl: row.targetUrl ?? '',
      count: row.count,
      previousCount: row.previousCount,
      share: analyticsShare(row.count, clicks.total),
      deltaPercent: analyticsDeltaPercent(row.count, row.previousCount),
      name: normalizeAnalyticsPath(row.path),
      extra: row.targetUrl ?? '',
    })),
    topProxies: topProxyRows.map(row => ({
      domain: row.domain,
      path: normalizeAnalyticsPath(row.path),
      sourceUrl: canonicalAnalyticsUrl(row.domain, row.path),
      targetUrl: row.targetUrl ?? '',
      count: row.count,
      previousCount: row.previousCount,
      share: analyticsShare(row.count, proxy.total),
      deltaPercent: analyticsDeltaPercent(row.count, row.previousCount),
    })),
    topPages: topPageRows.map(row => ({
      domain: row.domain,
      path: normalizeAnalyticsPath(row.path),
      sourceUrl: canonicalAnalyticsUrl(row.domain, row.path),
      count: row.count,
      previousCount: row.previousCount,
      share: analyticsShare(row.count, views.total),
      deltaPercent: analyticsDeltaPercent(row.count, row.previousCount),
      name: normalizeAnalyticsPath(row.path),
    })),
    topDomains: topDomainRows.map(row => ({
      domain: row.domain,
      count: row.count,
      share: analyticsShare(row.count, recordedEvents),
    })),
    topCountries: topCountryRows,
    topReferrers: topReferrerRows,
    clicksByDay: activityRows.map(({ date, clicks: count }) => ({ date, count })),
    viewsByDay: activityRows.map(({ date, views: count }) => ({ date, count })),
    activityByDay: activityRows,
    recentClicks: recentActivity
      .filter(row => row.type === 'click')
      .slice(0, 5)
      .map(row => ({
        domain: row.domain,
        slug: row.path,
        path: row.path,
        sourceUrl: row.sourceUrl,
        target: row.targetUrl ?? '',
        targetUrl: row.targetUrl ?? '',
        country: row.country,
        createdAt: row.createdAt,
      })),
    recentViews: recentActivity
      .filter(row => row.type === 'view')
      .slice(0, 5)
      .map(row => ({
        domain: row.domain,
        path: row.path,
        sourceUrl: row.sourceUrl,
        country: row.country,
        createdAt: row.createdAt,
      })),
    recentActivity,
    insights,
  };
}
