import { AnalyticsSummarySchema } from '@/lib/schemas';

/**
 * One canonical analytics summary for the dashboard suites.
 *
 * Parsed through the real schema so a contract change breaks the fixture rather
 * than letting the tests drift onto a shape the API no longer returns. Shared
 * by the static-markup suite and the client-render suite so the two cannot
 * diverge into testing different dashboards.
 */
export const summary = AnalyticsSummarySchema.parse({
  period: '30d',
  domain: 'all',
  clicks: { total: 4, previousTotal: 2, deltaPercent: 100, uniqueUrls: 1, uniqueSlugs: 1 },
  views: { total: 3, previousTotal: 3, deltaPercent: 0, uniqueUrls: 1, uniquePaths: 1 },
  downloads: {
    total: 1,
    previousTotal: 0,
    deltaPercent: null,
    totalBytes: 2048,
    cacheHitRate: 1,
  },
  proxy: { total: 2, previousTotal: 1, deltaPercent: 100, errorCount: 0, errorRate: 0 },
  overview: {
    recordedEvents: 10,
    previousRecordedEvents: 6,
    deltaPercent: 66.7,
    activeDomains: 1,
    uniqueUrls: 3,
  },
  filters: { days: 30, country: null, search: null, includeMonitoring: false },
  monitoring: {
    included: false,
    classifier: 'cloudflare-healthchecks',
    rows: { clicks: 1, views: 0, downloads: 0, proxy: 0, total: 1 },
  },
  coverage: {
    status: 'partial',
    cutoverAt: null,
    note: 'Legacy streams are partial.',
    unifiedTraffic: {
      mode: 'off',
      enabled: false,
      retentionDays: 30,
      recordedRequests: 0,
      reconciled: false,
      includedInHeadline: false,
    },
    streams: { clicks: 'legacy', views: 'legacy', downloads: 'legacy', proxy: 'legacy' },
  },
  topClicks: [
    {
      domain: 'example.com',
      path: '/welcome',
      sourceUrl: 'https://example.com/welcome',
      targetUrl: 'https://destination.example/welcome',
      count: 4,
      previousCount: 2,
      share: 1,
      deltaPercent: 100,
      name: '/welcome',
      extra: 'https://destination.example/welcome',
    },
  ],
  topProxies: [
    {
      domain: 'example.com',
      path: '/api-status',
      sourceUrl: 'https://example.com/api-status',
      targetUrl: 'https://upstream.example/status',
      count: 2,
      previousCount: 1,
      share: 1,
      deltaPercent: 100,
    },
  ],
  topPages: [
    {
      domain: 'example.com',
      path: '/about',
      sourceUrl: 'https://example.com/about',
      count: 3,
      previousCount: 3,
      share: 1,
      deltaPercent: 0,
      name: '/about',
    },
  ],
  topDomains: [{ domain: 'example.com', count: 10, share: 1 }],
  topCountries: [{ name: 'SG', count: 8 }],
  topReferrers: [{ name: 'https://search.example/', count: 5 }],
  clicksByDay: [],
  viewsByDay: [],
  activityByDay: [],
  recentClicks: [],
  recentViews: [],
  recentActivity: [
    {
      eventId: 'click:1',
      type: 'click',
      domain: 'example.com',
      path: '/welcome',
      sourceUrl: 'https://example.com/welcome',
      targetUrl: 'https://destination.example/welcome',
      country: 'SG',
      createdAt: 1_700_000_000,
    },
  ],
  insights: [
    {
      id: 'monitoring-traffic',
      severity: 'info',
      title: 'Monitoring traffic excluded',
      description: 'One matching row.',
      href: null,
    },
  ],
});
