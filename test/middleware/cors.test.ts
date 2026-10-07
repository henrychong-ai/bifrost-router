import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ADMIN_API_CORS_ORIGINS, cors } from '../../src/middleware/cors';
import type { AppEnv } from '../../src/types';

describe('cors middleware', () => {
  describe('preflight requests', () => {
    it('handles OPTIONS preflight with correct headers', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors());
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'POST',
          },
        }),
        env,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('includes configured headers in preflight response', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ headers: ['X-Custom-Header', 'Content-Type'] }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://example.com',
            'Access-Control-Request-Method': 'GET',
          },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Custom-Header');
    });
  });

  describe('actual requests', () => {
    it('adds CORS headers to response', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors());
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://example.com' },
        }),
        env,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('exposes configured headers', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ exposeHeaders: ['X-Custom-Exposed'] }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://example.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Custom-Exposed');
    });
  });

  describe('origin restrictions', () => {
    it('allows specific origin when configured', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ origins: 'https://allowed.com' }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://allowed.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.com');
    });

    it('rejects disallowed origin', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ origins: 'https://allowed.com' }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://notallowed.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('allows array of origins', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ origins: ['https://one.com', 'https://two.com'] }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://two.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://two.com');
    });
  });

  describe('credentials', () => {
    it('sets credentials header when enabled', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ credentials: true }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://example.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });
  });

  describe('function-based origins', () => {
    it('allows origin when function returns true', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ origins: origin => origin.endsWith('.example.com') }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://sub.example.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://sub.example.com');
    });

    it('rejects origin when function returns false', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', cors({ origins: origin => origin.endsWith('.example.com') }));
      app.get('/test', c => c.json({ success: true }));

      const response = await app.fetch(
        new Request('http://localhost/test', {
          headers: { Origin: 'https://other.com' },
        }),
        env,
      );

      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});

// v1.39.0: the dashboard is same-origin (its server calls the Worker), so
// no browser origin needs the admin API cross-origin
describe('ADMIN_API_CORS_ORIGINS', () => {
  it('allows no origin', () => {
    expect(ADMIN_API_CORS_ORIGINS).toEqual([]);
  });
});
