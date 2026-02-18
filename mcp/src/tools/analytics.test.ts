import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  EdgeRouterClient,
  AnalyticsSummary,
  SlugStats,
  LinkClick,
  PageView,
  PaginatedResponse,
} from '@bifrost/shared';
import { getAnalyticsSummary, getClicks, getViews, getSlugStats } from './analytics.js';

describe('Analytics tool handlers', () => {
  let mockClient: EdgeRouterClient;

  const mockSummary: AnalyticsSummary = {
    period: '30d',
    domain: 'link.henrychong.com',
    clicks: { total: 1000, uniqueSlugs: 50 },
    views: { total: 5000, uniquePaths: 100 },
    topClicks: [
      {
        name: '/linkedin',
        count: 200,
        extra: 'https://linkedin.com/in/henrychong',
      },
      {
        name: '/github',
        count: 150,
        extra: 'https://github.com/henrychong-ai',
      },
    ],
    topPages: [
      { name: '/', count: 2000 },
      { name: '/about', count: 500 },
    ],
    topCountries: [
      { name: 'US', count: 400 },
      { name: 'SG', count: 300 },
    ],
    topReferrers: [
      { name: 'twitter.com', count: 200 },
      { name: 'linkedin.com', count: 150 },
    ],
    clicksByDay: [
      { date: '2026-01-10', count: 30 },
      { date: '2026-01-11', count: 35 },
    ],
    viewsByDay: [
      { date: '2026-01-10', count: 150 },
      { date: '2026-01-11', count: 180 },
    ],
    recentClicks: [
      {
        id: 1,
        slug: '/linkedin',
        targetUrl: 'https://linkedin.com/in/henrychong',
        country: 'US',
        createdAt: Math.floor(Date.now() / 1000) - 300,
      },
    ],
    recentViews: [],
  };

  const mockClicksResponse: PaginatedResponse<LinkClick> = {
    items: [
      {
        id: 1,
        slug: '/linkedin',
        targetUrl: 'https://linkedin.com/in/henrychong',
        domain: 'link.henrychong.com',
        country: 'US',
        createdAt: Math.floor(Date.now() / 1000) - 300,
      },
      {
        id: 2,
        slug: '/github',
        targetUrl: 'https://github.com/henrychong-ai',
        domain: 'link.henrychong.com',
        country: 'SG',
        createdAt: Math.floor(Date.now() / 1000) - 600,
      },
    ],
    meta: {
      total: 100,
      limit: 50,
      offset: 0,
      hasMore: true,
    },
  };

  const mockViewsResponse: PaginatedResponse<PageView> = {
    items: [
      {
        id: 1,
        path: '/',
        domain: 'henrychong.com',
        country: 'US',
        createdAt: Math.floor(Date.now() / 1000) - 120,
      },
      {
        id: 2,
        path: '/about',
        domain: 'henrychong.com',
        country: 'GB',
        createdAt: Math.floor(Date.now() / 1000) - 240,
      },
    ],
    meta: {
      total: 500,
      limit: 50,
      offset: 0,
      hasMore: true,
    },
  };

  const mockSlugStats: SlugStats = {
    slug: '/linkedin',
    totalClicks: 200,
    target: 'https://linkedin.com/in/henrychong',
    topCountries: [
      { name: 'US', count: 100 },
      { name: 'SG', count: 50 },
    ],
    topReferrers: [
      { name: 'twitter.com', count: 80 },
      { name: 'google.com', count: 40 },
    ],
    clicksByDay: [
      { date: '2026-01-10', count: 10 },
      { date: '2026-01-11', count: 12 },
    ],
  };

  beforeEach(() => {
    mockClient = {
      getAnalyticsSummary: vi.fn(),
      getClicks: vi.fn(),
      getViews: vi.fn(),
      getSlugStats: vi.fn(),
    } as unknown as EdgeRouterClient;
  });

  describe('getAnalyticsSummary', () => {
    it('returns formatted analytics summary', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Analytics Summary');
      expect(result).toContain('30d');
      expect(result).toContain('Total Clicks: 1,000');
      expect(result).toContain('Unique Links: 50');
      expect(result).toContain('Total Page Views: 5,000');
    });

    it('shows top clicks', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Top Links');
      expect(result).toContain('/linkedin');
      expect(result).toContain('200 clicks');
    });

    it('shows top pages', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Top Pages');
      expect(result).toContain('2,000 views');
    });

    it('shows top countries', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Top Countries');
      expect(result).toContain('US');
    });

    it('shows top referrers', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Top Referrers');
      expect(result).toContain('twitter.com');
    });

    it('shows recent clicks with relative time', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockResolvedValue(mockSummary);

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Recent Clicks');
      expect(result).toContain('/linkedin');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getAnalyticsSummary).mockRejectedValue(new Error('Database error'));

      const result = await getAnalyticsSummary(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Error getting analytics summary');
      expect(result).toContain('Database error');
    });
  });

  describe('getClicks', () => {
    it('returns formatted click list with pagination info', async () => {
      vi.mocked(mockClient.getClicks).mockResolvedValue(mockClicksResponse);

      const result = await getClicks(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Clicks');
      expect(result).toContain('1-2 of 100');
      expect(result).toContain('/linkedin');
      expect(result).toContain('/github');
    });

    it('shows country for each click', async () => {
      vi.mocked(mockClient.getClicks).mockResolvedValue(mockClicksResponse);

      const result = await getClicks(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('(US)');
      expect(result).toContain('(SG)');
    });

    it('shows more indicator when hasMore is true', async () => {
      vi.mocked(mockClient.getClicks).mockResolvedValue(mockClicksResponse);

      const result = await getClicks(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('more clicks');
    });

    it('returns empty message when no clicks found', async () => {
      vi.mocked(mockClient.getClicks).mockResolvedValue({
        items: [],
        meta: { total: 0, limit: 50, offset: 0, hasMore: false },
      });

      const result = await getClicks(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('No clicks found');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getClicks).mockRejectedValue(new Error('Query failed'));

      const result = await getClicks(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Error getting clicks');
      expect(result).toContain('Query failed');
    });
  });

  describe('getViews', () => {
    it('returns formatted view list with pagination info', async () => {
      vi.mocked(mockClient.getViews).mockResolvedValue(mockViewsResponse);

      const result = await getViews(mockClient, {}, 'henrychong.com');

      expect(result).toContain('Page Views');
      expect(result).toContain('1-2 of 500');
      expect(result).toContain('/');
      expect(result).toContain('/about');
    });

    it('shows country for each view', async () => {
      vi.mocked(mockClient.getViews).mockResolvedValue(mockViewsResponse);

      const result = await getViews(mockClient, {}, 'henrychong.com');

      expect(result).toContain('(US)');
      expect(result).toContain('(GB)');
    });

    it('returns empty message when no views found', async () => {
      vi.mocked(mockClient.getViews).mockResolvedValue({
        items: [],
        meta: { total: 0, limit: 50, offset: 0, hasMore: false },
      });

      const result = await getViews(mockClient, {}, 'henrychong.com');

      expect(result).toContain('No page views found');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getViews).mockRejectedValue(new Error('Query failed'));

      const result = await getViews(mockClient, {}, 'henrychong.com');

      expect(result).toContain('Error getting page views');
      expect(result).toContain('Query failed');
    });
  });

  describe('getSlugStats', () => {
    it('returns formatted slug statistics', async () => {
      vi.mocked(mockClient.getSlugStats).mockResolvedValue(mockSlugStats);

      const result = await getSlugStats(mockClient, { slug: '/linkedin' }, 'link.henrychong.com');

      expect(result).toContain('Statistics for /linkedin');
      expect(result).toContain('Total Clicks: 200');
      expect(result).toContain('Target URL: https://linkedin.com/in/henrychong');
    });

    it('shows top countries for slug', async () => {
      vi.mocked(mockClient.getSlugStats).mockResolvedValue(mockSlugStats);

      const result = await getSlugStats(mockClient, { slug: '/linkedin' }, 'link.henrychong.com');

      expect(result).toContain('Top Countries');
      expect(result).toContain('US');
      expect(result).toContain('100 clicks');
    });

    it('shows top referrers for slug', async () => {
      vi.mocked(mockClient.getSlugStats).mockResolvedValue(mockSlugStats);

      const result = await getSlugStats(mockClient, { slug: '/linkedin' }, 'link.henrychong.com');

      expect(result).toContain('Top Referrers');
      expect(result).toContain('twitter.com');
    });

    it('shows recent activity by day', async () => {
      vi.mocked(mockClient.getSlugStats).mockResolvedValue(mockSlugStats);

      const result = await getSlugStats(mockClient, { slug: '/linkedin' }, 'link.henrychong.com');

      expect(result).toContain('Recent Activity');
      expect(result).toContain('2026-01-10');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getSlugStats).mockRejectedValue(new Error('Slug not found'));

      const result = await getSlugStats(mockClient, { slug: '/notfound' }, 'link.henrychong.com');

      expect(result).toContain('Error getting slug statistics');
      expect(result).toContain('Slug not found');
    });
  });
});
