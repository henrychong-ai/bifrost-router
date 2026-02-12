import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { rateLimit, rateLimitStrict } from '../../src/middleware/rate-limit';
import type { AppEnv } from '../../src/types';

describe('rateLimit middleware', () => {
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    // Clear rate limit entries from KV
    const list = await env.ROUTES.list({ prefix: 'ratelimit:' });
    for (const key of list.keys) {
      await env.ROUTES.delete(key.name);
    }

    app = new Hono<AppEnv>();
    app.use('*', rateLimit({ maxRequests: 3, windowSeconds: 60 }));
    app.get('/test', c => c.json({ success: true }));
  });

  it('allows requests within rate limit', async () => {
    const request = new Request('http://localhost/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });

    const response = await app.fetch(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('2');
  });

  it('blocks requests exceeding rate limit', async () => {
    const makeRequest = () =>
      app.fetch(
        new Request('http://localhost/test', {
          headers: { 'CF-Connecting-IP': '5.6.7.8' },
        }),
        env,
      );

    // First 3 requests should succeed
    for (let i = 0; i < 3; i++) {
      const response = await makeRequest();
      expect(response.status).toBe(200);
    }

    // 4th request should be rate limited
    const response = await makeRequest();
    expect(response.status).toBe(429);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Too Many Requests');
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });

  it('tracks rate limits per IP', async () => {
    // Request from first IP
    const response1 = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '10.0.0.1' },
      }),
      env,
    );
    expect(response1.status).toBe(200);
    expect(response1.headers.get('X-RateLimit-Remaining')).toBe('2');

    // Request from second IP should have full quota
    const response2 = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '10.0.0.2' },
      }),
      env,
    );
    expect(response2.status).toBe(200);
    expect(response2.headers.get('X-RateLimit-Remaining')).toBe('2');
  });
});

describe('rateLimitStrict middleware', () => {
  let app: Hono<AppEnv>;

  beforeEach(async () => {
    const list = await env.ROUTES.list({ prefix: 'ratelimit:' });
    for (const key of list.keys) {
      await env.ROUTES.delete(key.name);
    }

    app = new Hono<AppEnv>();
    app.use('*', rateLimitStrict({ maxRequests: 2, windowSeconds: 60 }));
    app.get('/test', c => c.json({ success: true }));
  });

  it('allows requests within limit', async () => {
    const response = await app.fetch(
      new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '20.0.0.1' },
      }),
      env,
    );
    expect(response.status).toBe(200);
  });

  it('blocks excess requests', async () => {
    const makeRequest = () =>
      app.fetch(
        new Request('http://localhost/test', {
          headers: { 'CF-Connecting-IP': '20.0.0.2' },
        }),
        env,
      );

    await makeRequest();
    await makeRequest();
    const response = await makeRequest();
    expect(response.status).toBe(429);
  });
});
