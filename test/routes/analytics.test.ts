import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

describe('analytics routes', () => {
  const validApiKey = 'test-api-key-12345';

  // Create test env with ADMIN_API_DOMAIN set to enable domain restriction
  const testEnv = { ...env, ADMIN_API_DOMAIN: 'henrychong.com' };

  // Initialize D1 database schema before tests
  beforeAll(async () => {
    // Create tables using prepare().run() for each statement
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS link_clicks (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        domain TEXT NOT NULL,
        slug TEXT NOT NULL,
        target_url TEXT NOT NULL,
        referrer TEXT,
        user_agent TEXT,
        country TEXT,
        city TEXT,
        colo TEXT,
        continent TEXT,
        http_protocol TEXT,
        timezone TEXT,
        ip_address TEXT,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        domain TEXT NOT NULL,
        path TEXT NOT NULL,
        referrer TEXT,
        user_agent TEXT,
        country TEXT,
        city TEXT,
        colo TEXT,
        continent TEXT,
        http_protocol TEXT,
        timezone TEXT,
        ip_address TEXT,
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL
      )
    `).run();
  });

  // Helper to make authenticated requests
  const makeRequest = (app: Hono<AppEnv>, path: string, options: RequestInit = {}) => {
    return app.fetch(
      new Request(`http://henrychong.com${path}`, {
        ...options,
        headers: {
          'X-Admin-Key': validApiKey,
          ...options.headers,
        },
      }),
      testEnv,
    );
  };

  describe('authentication', () => {
    it('rejects unauthenticated requests to /api/analytics/summary', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/analytics/summary'),
        testEnv,
      );

      expect(response.status).toBe(401);
    });

    it('rejects unauthenticated requests to /api/analytics/clicks', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/analytics/clicks'),
        testEnv,
      );

      expect(response.status).toBe(401);
    });

    it('rejects unauthenticated requests to /api/analytics/views', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://henrychong.com/api/analytics/views'),
        testEnv,
      );

      expect(response.status).toBe(401);
    });
  });

  describe('domain restriction', () => {
    it('returns 404 for analytics requests from non-allowed domains', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request('http://evil.com/api/analytics/summary', {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/analytics/summary', () => {
    it('returns analytics summary with default parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/summary');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('period');
      expect(data.data).toHaveProperty('domain');
      expect(data.data).toHaveProperty('clicks');
      expect(data.data).toHaveProperty('views');
      expect(data.data).toHaveProperty('topClicks');
      expect(data.data).toHaveProperty('topPages');
      expect(data.data).toHaveProperty('topCountries');
      expect(data.data).toHaveProperty('clicksByDay');
      expect(data.data).toHaveProperty('viewsByDay');
    });

    it('accepts days parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/summary?days=7');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.period).toBe('7d');
    });

    it('accepts domain parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/summary?domain=henrychong.com');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.domain).toBe('henrychong.com');
    });

    it('validates days parameter range', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Test days > 365
      const response = await makeRequest(app, '/api/analytics/summary?days=500');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid query parameters');
    });

    it('validates days parameter minimum', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Test days < 1
      const response = await makeRequest(app, '/api/analytics/summary?days=0');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  describe('GET /api/analytics/clicks', () => {
    it('returns paginated click list with default parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(data.meta).toHaveProperty('total');
      expect(data.meta).toHaveProperty('limit');
      expect(data.meta).toHaveProperty('offset');
      expect(data.meta).toHaveProperty('hasMore');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('includes X-Total-Count header', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks');

      expect(response.status).toBe(200);
      expect(response.headers.has('X-Total-Count')).toBe(true);
    });

    it('accepts pagination parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks?limit=10&offset=5');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.meta.limit).toBe(10);
      expect(data.meta.offset).toBe(5);
    });

    it('accepts filter parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(
        app,
        '/api/analytics/clicks?domain=henrychong.com&country=SG&slug=/github',
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('validates limit maximum', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks?limit=2000');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid query parameters');
    });

    it('validates country code format', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      // Country code must be exactly 2 characters
      const response = await makeRequest(app, '/api/analytics/clicks?country=USA');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  describe('GET /api/analytics/views', () => {
    it('returns paginated view list with default parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/views');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('meta');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('includes X-Total-Count header', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/views');

      expect(response.status).toBe(200);
      expect(response.headers.has('X-Total-Count')).toBe(true);
    });

    it('accepts path filter parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/views?path=/about');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('accepts pagination parameters', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/views?limit=50&offset=10');

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.meta.limit).toBe(50);
      expect(data.meta.offset).toBe(10);
    });
  });

  describe('GET /api/analytics/clicks/:slug', () => {
    it('returns 404 for non-existent slug', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks/nonexistent-slug-12345');

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.success).toBe(false);
    });

    it('accepts days parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks/test?days=7');

      // Will return 404 if no clicks, but validates the parameter
      expect([200, 404]).toContain(response.status);
    });

    it('validates days parameter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await makeRequest(app, '/api/analytics/clicks/test?days=500');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });
});
