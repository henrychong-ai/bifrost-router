import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EdgeRouterClient, EdgeRouterError, createClientFromEnv } from './client.js';

describe('EdgeRouterClient', () => {
  const mockFetch = vi.fn();
  let client: EdgeRouterClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new EdgeRouterClient({
      baseUrl: 'https://test.example.com',
      apiKey: 'test-api-key',
      defaultDomain: 'link.example.com',
      fetch: mockFetch,
    });
  });

  describe('constructor', () => {
    it('removes trailing slash from baseUrl', () => {
      const clientWithSlash = new EdgeRouterClient({
        baseUrl: 'https://test.example.com/',
        apiKey: 'test-api-key',
        fetch: mockFetch,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      clientWithSlash.listRoutes();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://test.example.com/api/routes'),
        expect.any(Object)
      );
    });
  });

  describe('listRoutes', () => {
    it('calls GET /api/routes with domain param', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      await client.listRoutes();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/routes?domain=link.example.com',
        expect.objectContaining({
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Key': 'test-api-key',
          },
        })
      );
    });

    it('uses provided domain over default', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: [] }),
      });

      await client.listRoutes('example.com');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/routes?domain=example.com',
        expect.any(Object)
      );
    });

    it('returns routes array', async () => {
      const mockRoutes = [
        { path: '/test', type: 'redirect', target: 'https://example.com' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        // API returns { routes: [...], total: N }
        json: async () => ({ success: true, data: { routes: mockRoutes, total: 1 } }),
      });

      const routes = await client.listRoutes();

      expect(routes).toEqual(mockRoutes);
    });
  });

  describe('getRoute', () => {
    it('calls GET /api/routes with path query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { path: '/test/path', type: 'redirect', target: 'https://example.com' },
        }),
      });

      await client.getRoute('/test/path');

      // Path is passed as query parameter, URLSearchParams handles encoding
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.any(Object)
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest%2Fpath');
    });
  });

  describe('createRoute', () => {
    it('calls POST /api/routes with body', async () => {
      const input = { path: '/new', type: 'redirect' as const, target: 'https://new.com' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: input }),
      });

      await client.createRoute(input);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(input),
        })
      );
    });
  });

  describe('updateRoute', () => {
    it('calls PUT /api/routes with path query parameter', async () => {
      const input = { target: 'https://updated.com' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { path: '/test', type: 'redirect', target: 'https://updated.com' },
        }),
      });

      await client.updateRoute('/test', input);

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(input),
        })
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('deleteRoute', () => {
    it('calls DELETE /api/routes with path query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await client.deleteRoute('/test');

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({ method: 'DELETE' })
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('toggleRoute', () => {
    it('calls updateRoute with enabled field via query parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { path: '/test', type: 'redirect', target: 'https://example.com', enabled: false },
        }),
      });

      await client.toggleRoute('/test', false);

      // Path is passed as query parameter
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/routes?'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabled: false }),
        })
      );
      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('path=%2Ftest');
    });
  });

  describe('getAnalyticsSummary', () => {
    it('calls GET /api/analytics/summary', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { period: '30d', domain: 'all', clicks: { total: 0, uniqueSlugs: 0 } },
        }),
      });

      await client.getAnalyticsSummary({ days: 7 });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/analytics/summary?domain=link.example.com&days=7',
        expect.any(Object)
      );
    });
  });

  describe('getClicks', () => {
    it('calls GET /api/analytics/clicks with filters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: [],
          meta: { total: 0, limit: 50, offset: 0, hasMore: false },
        }),
      });

      await client.getClicks({ limit: 10, offset: 5, slug: '/linkedin' });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
      expect(url).toContain('slug=%2Flinkedin');
    });
  });

  describe('getSlugStats', () => {
    it('calls GET /api/analytics/clicks/:slug', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: { slug: '/linkedin', totalClicks: 100 },
        }),
      });

      await client.getSlugStats('/linkedin');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/analytics/clicks/linkedin'),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('throws EdgeRouterError on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ success: false, error: 'Route not found' }),
      });

      try {
        await client.getRoute('/notfound');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EdgeRouterError);
        expect((error as EdgeRouterError).message).toBe('Route not found');
        expect((error as EdgeRouterError).status).toBe(404);
      }
    });

    it('throws EdgeRouterError on parse failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      try {
        await client.listRoutes();
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(EdgeRouterError);
        expect((error as EdgeRouterError).message).toContain('Failed to parse response');
        expect((error as EdgeRouterError).status).toBe(500);
      }
    });
  });
});

describe('createClientFromEnv', () => {
  it('creates client from env object', () => {
    const client = createClientFromEnv({
      EDGE_ROUTER_API_KEY: 'test-key',
      EDGE_ROUTER_URL: 'https://custom.com',
      EDGE_ROUTER_DOMAIN: 'example.com',
    });

    expect(client).toBeInstanceOf(EdgeRouterClient);
  });

  it('uses default URL when not provided', () => {
    const client = createClientFromEnv({
      EDGE_ROUTER_API_KEY: 'test-key',
    });

    expect(client).toBeInstanceOf(EdgeRouterClient);
  });

  it('throws when API key is missing', () => {
    expect(() => createClientFromEnv({})).toThrow('EDGE_ROUTER_API_KEY environment variable is required');
  });
});
