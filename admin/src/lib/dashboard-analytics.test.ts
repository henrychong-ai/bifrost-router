import { describe, expect, it } from 'vitest';
import { AnalyticsSummarySchema } from './schemas';
import {
  analyticsSummaryToCsv,
  dashboardFiltersToSearchParams,
  parseDashboardFilters,
} from './dashboard-analytics';

describe('dashboard filters', () => {
  it('accepts only bounded values and allowed domains', () => {
    const filters = parseDashboardFilters(
      new URLSearchParams(
        'days=7&domain=example.com&country=sg&search=%20route%20&includeMonitoring=true',
      ),
      ['example.com'],
    );
    expect(filters).toEqual({
      days: 7,
      domain: 'example.com',
      country: 'SG',
      search: 'route',
      includeMonitoring: true,
    });
    expect(dashboardFiltersToSearchParams(filters).toString()).toContain('includeMonitoring=true');
  });
});

describe('dashboard CSV', () => {
  it('exports full URLs and blocks spreadsheet formula injection', () => {
    const summary = AnalyticsSummarySchema.parse({
      period: '30d',
      domain: 'all',
      clicks: { total: 1, previousTotal: 0, deltaPercent: null, uniqueUrls: 1, uniqueSlugs: 1 },
      views: { total: 0, previousTotal: 0, deltaPercent: 0, uniqueUrls: 0, uniquePaths: 0 },
      downloads: { total: 0, previousTotal: 0, deltaPercent: 0, totalBytes: 0, cacheHitRate: null },
      proxy: { total: 0, previousTotal: 0, deltaPercent: 0, errorCount: 0, errorRate: null },
      overview: {
        recordedEvents: 1,
        previousRecordedEvents: 0,
        deltaPercent: null,
        activeDomains: 1,
        uniqueUrls: 1,
      },
      filters: { days: 30, country: null, search: null, includeMonitoring: false },
      monitoring: {
        included: false,
        classifier: 'cloudflare-healthchecks',
        rows: { clicks: 0, views: 0, downloads: 0, proxy: 0, total: 0 },
      },
      coverage: {
        status: 'partial',
        cutoverAt: null,
        note: 'partial',
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
          path: '/=SUM(1,1)',
          sourceUrl: 'https://example.com/%3DSUM(1,1)',
          targetUrl: '=cmd',
          count: 1,
          previousCount: 0,
          share: 1,
          deltaPercent: null,
          name: '/=SUM(1,1)',
          extra: '=cmd',
        },
      ],
      topProxies: [],
      topPages: [],
      topDomains: [{ domain: 'example.com', count: 1, share: 1 }],
      topCountries: [],
      topReferrers: [],
      clicksByDay: [],
      viewsByDay: [],
      activityByDay: [],
      recentClicks: [],
      recentViews: [],
      recentActivity: [],
      insights: [],
    });
    const csv = analyticsSummaryToCsv(summary);
    expect(csv).toContain('https://example.com/%3DSUM(1,1)');
    expect(csv).toContain("'=cmd");
  });
});
