import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { SUPPORTED_DOMAINS } from '../../src/types';
import { seedRoutes, clearAllRoutes, TEST_DOMAIN } from '../helpers';

describe('admin routes - search and pagination', () => {
  const validApiKey = 'test-api-key-12345';
  const testEnv = { ...env, ADMIN_API_DOMAIN: TEST_DOMAIN };

  beforeEach(async () => {
    await clearAllRoutes();
  });

  describe('GET /routes - basic list with meta', () => {
    it('returns routes with meta object', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/a',
            type: 'redirect',
            target: 'https://example.com/a',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/b',
            type: 'proxy',
            target: 'https://example.com/b',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.routes).toHaveLength(2);
      expect(data.data.meta).toBeDefined();
      expect(data.data.meta.total).toBe(2);
      expect(data.data.meta.count).toBe(2);
      expect(data.data.meta.offset).toBe(0);
      expect(data.data.meta.hasMore).toBe(false);
    });
  });

  describe('GET /routes?search=', () => {
    it('filters routes by path substring', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/github',
            type: 'redirect',
            target: 'https://github.com',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/blog',
            type: 'redirect',
            target: 'https://blog.example.com',
            createdAt: 2,
            updatedAt: 2,
          },
          {
            path: '/docs',
            type: 'proxy',
            target: 'https://docs.example.com',
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=git`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/github');
      expect(data.data.meta.total).toBe(1);
    });

    it('filters routes by target substring', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/one',
            type: 'redirect',
            target: 'https://alpha.example.com',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/two',
            type: 'redirect',
            target: 'https://beta.example.com',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=alpha`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/one');
    });

    it('search is case-insensitive', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/GitHub',
            type: 'redirect',
            target: 'https://github.com',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=GITHUB`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
    });

    it('returns empty results for no matches', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/a',
            type: 'redirect',
            target: 'https://example.com',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=zzznomatch`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(0);
      expect(data.data.meta.total).toBe(0);
    });
  });

  describe('GET /routes?type=', () => {
    it('filters routes by type', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/r1',
            type: 'redirect',
            target: 'https://example.com',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/p1',
            type: 'proxy',
            target: 'https://api.example.com',
            createdAt: 2,
            updatedAt: 2,
          },
          {
            path: '/r2',
            type: 'redirect',
            target: 'https://other.com',
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?type=redirect`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(2);
      expect(data.data.routes.every((r: { type: string }) => r.type === 'redirect')).toBe(true);
    });

    it('filters proxy routes', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/r1',
            type: 'redirect',
            target: 'https://example.com',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/p1',
            type: 'proxy',
            target: 'https://api.example.com',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?type=proxy`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/p1');
    });
  });

  describe('GET /routes?enabled=', () => {
    it('filters enabled routes', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/active',
            type: 'redirect',
            target: 'https://example.com',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/disabled',
            type: 'redirect',
            target: 'https://other.com',
            enabled: false,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?enabled=true`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/active');
    });

    it('filters disabled routes', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/active',
            type: 'redirect',
            target: 'https://example.com',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/disabled',
            type: 'redirect',
            target: 'https://other.com',
            enabled: false,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?enabled=false`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/disabled');
    });
  });

  describe('GET /routes - pagination', () => {
    it('returns paginated results with limit', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        Array.from({ length: 5 }, (_, i) => ({
          path: `/page-${i}`,
          type: 'redirect' as const,
          target: 'https://example.com',
          createdAt: i,
          updatedAt: i,
        })),
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?limit=2`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(2);
      expect(data.data.meta.total).toBe(5);
      expect(data.data.meta.count).toBe(2);
      expect(data.data.meta.hasMore).toBe(true);
    });

    it('returns second page with offset', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        Array.from({ length: 5 }, (_, i) => ({
          path: `/page-${i}`,
          type: 'redirect' as const,
          target: 'https://example.com',
          createdAt: i,
          updatedAt: i,
        })),
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?limit=2&offset=2`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(2);
      expect(data.data.meta.total).toBe(5);
      expect(data.data.meta.offset).toBe(2);
      expect(data.data.meta.hasMore).toBe(true);
    });

    it('reports hasMore false on last page', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        Array.from({ length: 3 }, (_, i) => ({
          path: `/last-${i}`,
          type: 'redirect' as const,
          target: 'https://example.com',
          createdAt: i,
          updatedAt: i,
        })),
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?limit=2&offset=2`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.meta.hasMore).toBe(false);
    });

    it('returns 400 for invalid limit', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?limit=notanumber`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
    });
  });

  describe('GET /routes - combined filters', () => {
    it('combines search and type filter', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        [
          {
            path: '/api/v1',
            type: 'proxy',
            target: 'https://api.example.com',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            path: '/api/v2',
            type: 'redirect',
            target: 'https://api.example.com',
            createdAt: 2,
            updatedAt: 2,
          },
          {
            path: '/web',
            type: 'proxy',
            target: 'https://web.example.com',
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=/api&type=proxy`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.routes).toHaveLength(1);
      expect(data.data.routes[0].path).toBe('/api/v1');
    });

    it('combines search and pagination', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);

      await seedRoutes(
        Array.from({ length: 5 }, (_, i) => ({
          path: `/search-${i}`,
          type: 'redirect' as const,
          target: 'https://example.com',
          createdAt: i,
          updatedAt: i,
        })),
        TEST_DOMAIN,
      );

      const response = await app.fetch(
        new Request(`http://${TEST_DOMAIN}/api/routes?search=search&limit=2`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        testEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.meta.total).toBe(5);
      expect(data.data.routes).toHaveLength(2);
      expect(data.data.meta.hasMore).toBe(true);
    });
  });

  describe('GET /routes?domain= - multi-domain', () => {
    it('filters routes by domain when ADMIN_API_DOMAIN not set', async () => {
      const app = new Hono<AppEnv>().route('/api', adminRoutes);
      // No ADMIN_API_DOMAIN restriction
      const openEnv = { ...env };

      const domain2 = SUPPORTED_DOMAINS[1];
      await seedRoutes(
        [
          {
            path: '/d1-route',
            type: 'redirect',
            target: 'https://example.com',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        TEST_DOMAIN,
      );
      await seedRoutes(
        [
          {
            path: '/d2-route',
            type: 'redirect',
            target: 'https://other.com',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        domain2,
      );

      const response = await app.fetch(
        new Request(`http://localhost/api/routes?domain=${encodeURIComponent(domain2)}`, {
          headers: { 'X-Admin-Key': validApiKey },
        }),
        openEnv,
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      const paths = data.data.routes.map((r: { path: string }) => r.path);
      expect(paths).toContain('/d2-route');
      expect(paths).not.toContain('/d1-route');
    });
  });
});
