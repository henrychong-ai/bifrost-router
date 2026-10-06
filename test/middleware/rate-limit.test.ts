import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  const makeRequest = () =>
    app.fetch(
      new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '5.6.7.8' },
      }),
      env,
    );

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
    expect(response.headers.get('Retry-After')).not.toBeNull();
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

  const makeRequest = () =>
    app.fetch(
      new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '20.0.0.2' },
      }),
      env,
    );

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
    await makeRequest();
    await makeRequest();
    const response = await makeRequest();
    expect(response.status).toBe(429);
  });
});

describe('a stored rate-limit entry is validated (v1.38.0)', () => {
  const ip = '9.9.9.9';
  const key = `ratelimit:${ip}`;
  beforeEach(async () => {
    const list = await env.ROUTES.list({ prefix: 'ratelimit:' });
    for (const listed of list.keys) await env.ROUTES.delete(listed.name);
  });

  it.each([
    ['not JSON', '{"count":'],
    ['the wrong shape', JSON.stringify({ count: 'many', resetAt: Date.now() + 60_000 })],
    ['a JSON array', JSON.stringify([99, Date.now() + 60_000])],
  ])('an entry that is %s resets the window, logged as fixed text', async (_label, stored) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const make of [rateLimit, rateLimitStrict]) {
        await env.ROUTES.put(key, stored);
        const app = new Hono<AppEnv>();
        app.use('*', make({ maxRequests: 3, windowSeconds: 60 }));
        app.get('/test', c => c.json({ success: true }));
        const response = await app.fetch(
          new Request('http://localhost/test', { headers: { 'CF-Connecting-IP': ip } }),
          env,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('X-RateLimit-Remaining')).toBe('2');
      }
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          message: 'boundary-invalid-value',
          category: 'rate-limit',
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ip);
    } finally {
      warn.mockRestore();
    }
  });
});
