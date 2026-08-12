/**
 * Tests for Slack message formatting
 */

import { describe, it, expect } from 'vitest';
import {
  formatRouteList,
  formatAnalyticsSummary,
  formatRouteCreated,
  formatRouteUpdated,
  formatRouteDeleted,
  formatError,
  formatPermissionDenied,
  formatHelp,
} from '../src/slack/format';
import type { Route, AnalyticsSummary } from '@bifrost/shared';

function makeAnalyticsSummary(input: {
  period: string;
  domain: string;
  clicks: { total: number; uniqueSlugs: number };
  views: { total: number; uniquePaths: number };
  topClicks: Array<{ name: string; count: number }>;
  topPages: Array<{ name: string; count: number }>;
  topCountries: AnalyticsSummary['topCountries'];
  topReferrers: AnalyticsSummary['topReferrers'];
}): AnalyticsSummary {
  const domain = input.domain === 'all' ? 'example.com' : input.domain;
  return {
    period: input.period,
    domain: input.domain,
    clicks: {
      ...input.clicks,
      previousTotal: 0,
      deltaPercent: null,
      uniqueUrls: input.clicks.uniqueSlugs,
    },
    views: {
      ...input.views,
      previousTotal: 0,
      deltaPercent: null,
      uniqueUrls: input.views.uniquePaths,
    },
    downloads: {
      total: 0,
      previousTotal: 0,
      deltaPercent: 0,
      totalBytes: 0,
      cacheHitRate: null,
    },
    proxy: {
      total: 0,
      previousTotal: 0,
      deltaPercent: 0,
      errorCount: 0,
      errorRate: null,
    },
    overview: {
      recordedEvents: input.clicks.total + input.views.total,
      previousRecordedEvents: 0,
      deltaPercent: null,
      activeDomains: input.clicks.total + input.views.total > 0 ? 1 : 0,
      uniqueUrls: input.clicks.uniqueSlugs + input.views.uniquePaths,
    },
    filters: {
      days: Number.parseInt(input.period, 10),
      country: null,
      search: null,
      includeMonitoring: false,
    },
    monitoring: {
      included: false,
      classifier: 'cloudflare-healthchecks',
      rows: { clicks: 0, views: 0, downloads: 0, proxy: 0, total: 0 },
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
    topClicks: input.topClicks.map(item => ({
      ...item,
      domain,
      path: item.name,
      sourceUrl: `https://${domain}${item.name}`,
      targetUrl: '',
      previousCount: 0,
      share: input.clicks.total > 0 ? item.count / input.clicks.total : 0,
      deltaPercent: null,
      extra: '',
    })),
    topProxies: [],
    topPages: input.topPages.map(item => ({
      ...item,
      domain,
      path: item.name,
      sourceUrl: `https://${domain}${item.name}`,
      previousCount: 0,
      share: input.views.total > 0 ? item.count / input.views.total : 0,
      deltaPercent: null,
    })),
    topDomains: [],
    topCountries: input.topCountries,
    topReferrers: input.topReferrers,
    clicksByDay: [],
    viewsByDay: [],
    activityByDay: [],
    recentClicks: [],
    recentViews: [],
    recentActivity: [],
    insights: [],
  };
}

describe('formatRouteList', () => {
  const domain = 'links.example.com';

  it('should format empty route list', () => {
    const result = formatRouteList([], domain);

    expect(result).toContain('*Routes for links.example.com*');
    expect(result).toContain('No routes configured.');
  });

  it('should group routes by type', () => {
    const routes: Route[] = [
      {
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/user',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        path: '/api/*',
        type: 'proxy',
        target: 'https://api.example.com',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        path: '/media-kit',
        type: 'r2',
        target: 'media-kit.pdf',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const result = formatRouteList(routes, domain);

    expect(result).toContain('*Redirects (1)*');
    expect(result).toContain('*Proxies (1)*');
    expect(result).toContain('*R2 Files (1)*');
    expect(result).toContain('`/github`');
    expect(result).toContain('`/api/*`');
    expect(result).toContain('`/media-kit`');
  });

  it('should show disabled indicator for disabled routes', () => {
    const routes: Route[] = [
      {
        path: '/disabled-route',
        type: 'redirect',
        target: 'https://example.com',
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const result = formatRouteList(routes, domain);

    expect(result).toContain(':no_entry_sign:');
    expect(result).toContain('`/disabled-route`');
  });

  it('should show total count', () => {
    const routes: Route[] = [
      {
        path: '/one',
        type: 'redirect',
        target: 'https://one.com',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        path: '/two',
        type: 'redirect',
        target: 'https://two.com',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const result = formatRouteList(routes, domain);

    expect(result).toContain('_Total: 2 routes_');
  });

  it('should truncate long redirect lists', () => {
    const routes: Route[] = Array.from({ length: 15 }, (_, i) => ({
      path: `/route-${i}`,
      type: 'redirect' as const,
      target: `https://example.com/${i}`,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const result = formatRouteList(routes, domain);

    expect(result).toContain('_...and 5 more_');
    expect(result).toContain('`/route-0`');
    expect(result).toContain('`/route-9`');
    expect(result).not.toContain('`/route-10`');
  });
});

describe('formatAnalyticsSummary', () => {
  it('should format analytics summary with all sections', () => {
    const summary = makeAnalyticsSummary({
      period: '30d',
      domain: 'links.example.com',
      clicks: { total: 1234, uniqueSlugs: 50 },
      views: { total: 5678, uniquePaths: 100 },
      topClicks: [
        { name: '/linkedin', count: 200 },
        { name: '/github', count: 150 },
      ],
      topPages: [
        { name: '/', count: 1000 },
        { name: '/about', count: 500 },
      ],
      topCountries: [
        { name: 'US', count: 500 },
        { name: 'SG', count: 300 },
      ],
      topReferrers: [],
    });

    const result = formatAnalyticsSummary(summary);

    expect(result).toContain('*Analytics Summary (30d)*');
    expect(result).toContain('Domain: `links.example.com`');
    expect(result).toContain(':chart_with_upwards_trend: *Totals*');
    expect(result).toContain('Total Clicks: 1,234');
    expect(result).toContain('Unique Links: 50');
    expect(result).toContain('Total Page Views: 5,678');
    expect(result).toContain(':link: *Top Routes - Redirect*');
    expect(result).toContain(':first_place_medal:');
    expect(result).toContain('https://links.example.com/linkedin');
    expect(result).toContain(':page_facing_up: *Top Website Pages*');
    expect(result).toContain(':earth_americas: *Top Countries*');
  });

  it('should handle empty top lists', () => {
    const summary = makeAnalyticsSummary({
      period: '7d',
      domain: 'all',
      clicks: { total: 0, uniqueSlugs: 0 },
      views: { total: 0, uniquePaths: 0 },
      topClicks: [],
      topPages: [],
      topCountries: [],
      topReferrers: [],
    });

    const result = formatAnalyticsSummary(summary);

    expect(result).toContain('*Analytics Summary (7d)*');
    expect(result).not.toContain(':link: *Top Routes - Redirect*');
    expect(result).not.toContain(':page_facing_up: *Top Website Pages*');
  });

  it('should not show domain for "all" domains', () => {
    const summary = makeAnalyticsSummary({
      period: '30d',
      domain: 'all',
      clicks: { total: 100, uniqueSlugs: 10 },
      views: { total: 200, uniquePaths: 20 },
      topClicks: [],
      topPages: [],
      topCountries: [],
      topReferrers: [],
    });

    const result = formatAnalyticsSummary(summary);

    expect(result).not.toContain('Domain:');
  });

  it('should show medal emojis for top 3 positions', () => {
    const summary = makeAnalyticsSummary({
      period: '30d',
      domain: 'example.com',
      clicks: { total: 100, uniqueSlugs: 5 },
      views: { total: 200, uniquePaths: 10 },
      topClicks: [
        { name: '/first', count: 50 },
        { name: '/second', count: 30 },
        { name: '/third', count: 15 },
        { name: '/fourth', count: 5 },
      ],
      topPages: [],
      topCountries: [],
      topReferrers: [],
    });

    const result = formatAnalyticsSummary(summary);

    expect(result).toContain(':first_place_medal:');
    expect(result).toContain(':second_place_medal:');
    expect(result).toContain(':third_place_medal:');
    expect(result).toContain('4.');
  });
});

describe('formatRouteCreated', () => {
  it('should format route creation confirmation', () => {
    const result = formatRouteCreated({
      path: '/twitter',
      type: 'redirect',
      target: 'https://twitter.com/user',
      domain: 'links.example.com',
    });

    expect(result).toContain(':white_check_mark: *Route Created*');
    expect(result).toContain('Path: `/twitter`');
    expect(result).toContain('Type: redirect');
    expect(result).toContain('Target: https://twitter.com/user');
    expect(result).toContain('Domain: links.example.com');
  });
});

describe('formatRouteUpdated', () => {
  it('should format route update confirmation', () => {
    const result = formatRouteUpdated('/github', [
      'target: https://github.com/newuser',
      'statusCode: 301',
    ]);

    expect(result).toContain(':pencil: *Route Updated*');
    expect(result).toContain('Path: `/github`');
    expect(result).toContain('Changes:');
    expect(result).toContain('• target: https://github.com/newuser');
    expect(result).toContain('• statusCode: 301');
  });
});

describe('formatRouteDeleted', () => {
  it('should format route deletion confirmation', () => {
    const result = formatRouteDeleted('/old-route');

    expect(result).toContain(':wastebasket:');
    expect(result).toContain('`/old-route`');
    expect(result).toContain('has been deleted');
  });
});

describe('formatError', () => {
  it('should format error message', () => {
    const result = formatError('Route not found');

    expect(result).toContain(':x: *Error*');
    expect(result).toContain('Route not found');
  });
});

describe('formatPermissionDenied', () => {
  it('should format permission denied message', () => {
    const result = formatPermissionDenied("You don't have edit access");

    expect(result).toContain(':no_entry: *Permission Denied*');
    expect(result).toContain("You don't have edit access");
  });
});

describe('formatHelp', () => {
  it('should format help with accessible domains', () => {
    const domains = ['links.example.com', 'example.com'];
    const result = formatHelp(domains);

    expect(result).toContain(':wave: *Bifrost Bot*');
    expect(result).toContain('*Examples:*');
    expect(result).toContain('*Your accessible domains:*');
    expect(result).toContain('`links.example.com`');
    expect(result).toContain('`example.com`');
  });

  it('should show message when no domains accessible', () => {
    const result = formatHelp([]);

    expect(result).toContain(':wave: *Bifrost Bot*');
    expect(result).toContain("don't have access to any domains");
  });

  it('should include example commands', () => {
    const result = formatHelp(['links.example.com']);

    expect(result).toContain('List all routes');
    expect(result).toContain('Create a redirect');
    expect(result).toContain('Show me analytics');
    expect(result).toContain('Delete /old-page');
  });
});
