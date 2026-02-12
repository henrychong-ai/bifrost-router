import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { cors, isAllowedOrigin, ALLOWED_ORIGINS } from '../../src/middleware/cors';
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

describe('isAllowedOrigin', () => {
  it('returns origin for allowed origins in ALLOWED_ORIGINS', () => {
    expect(isAllowedOrigin('https://bifrost.henrychong.com')).toBe(
      'https://bifrost.henrychong.com',
    );
    expect(isAllowedOrigin('http://localhost:3001')).toBe('http://localhost:3001');
    expect(isAllowedOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
  });

  it('returns empty string for disallowed origins', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe('');
    expect(isAllowedOrigin('https://notallowed.com')).toBe('');
  });

  it('returns empty string for undefined origin', () => {
    expect(isAllowedOrigin(undefined)).toBe('');
  });

  it('allows workers.dev origins in dev mode', () => {
    expect(isAllowedOrigin('https://my-worker.workers.dev', true)).toBe(
      'https://my-worker.workers.dev',
    );
    expect(isAllowedOrigin('https://test.my-worker.workers.dev', true)).toBe(
      'https://test.my-worker.workers.dev',
    );
  });

  it('blocks workers.dev origins when dev mode is false', () => {
    expect(isAllowedOrigin('https://my-worker.workers.dev', false)).toBe('');
  });

  it('handles invalid URLs gracefully', () => {
    expect(isAllowedOrigin('not-a-url', true)).toBe('');
  });
});

describe('ALLOWED_ORIGINS', () => {
  it('contains expected origins', () => {
    expect(ALLOWED_ORIGINS).toContain('https://bifrost.henrychong.com');
    expect(ALLOWED_ORIGINS).toContain('http://localhost:3001');
    expect(ALLOWED_ORIGINS).toContain('http://localhost:5173');
  });

  it('is readonly array', () => {
    expect(Array.isArray(ALLOWED_ORIGINS)).toBe(true);
    expect(ALLOWED_ORIGINS.length).toBeGreaterThan(0);
  });
});
