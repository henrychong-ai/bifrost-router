/**
 * An invalid stored route through the admin API and the router (v1.38.0):
 * GET answers 404, a visitor gets a 404 rather than a broader wildcard, every
 * write except DELETE answers a fixed 409 ROUTE_RECORD_INVALID, and DELETE
 * removes it (the recovery). Nothing quotes the stored value.
 */
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv, Bindings } from '../../src/types';
import { ownHostResolver } from '../../src/utils/og-own-host';
import { clearAllRoutes } from '../helpers';

const ADMIN_HOST = 'example.com';
const DOMAIN = 'links.example.com';
const headers = { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' };
const secret = 'stored-secret-value';
const BAD = `{"path":"/bad","type":"redirect","target":"https://example.com/?token=${secret}"`;
const REFUSAL = {
  success: false,
  error: 'ROUTE_RECORD_INVALID',
  message: 'This route is stored in a shape that cannot be read. Delete it and create it again.',
};

const app = new Hono<AppEnv>().route('/api', adminRoutes);
const call = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`https://${ADMIN_HOST}/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

describe('an invalid stored route through the API', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearAllRoutes();
    await env.ROUTES.put(routeKey(DOMAIN, '/bad'), BAD);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('GET answers 404 and the listing leaves it out', async () => {
    const one = await call('GET', `/routes?path=/bad&domain=${DOMAIN}`);
    expect(one.status).toBe(404);
    const list = await call('GET', `/routes?domain=${DOMAIN}`);
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).toMatchObject({ data: { routes: [] } });
  });

  it('create over it answers 409 ROUTE_RECORD_INVALID and writes nothing', async () => {
    const response = await call('POST', `/routes?domain=${DOMAIN}`, {
      path: '/bad',
      type: 'redirect',
      target: 'https://example.com/new',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(REFUSAL);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBe(BAD);
  });

  it('update answers 409 ROUTE_RECORD_INVALID and writes nothing, even a toggle', async () => {
    for (const patch of [{ enabled: false }, { target: 'https://example.com/x' }]) {
      const response = await call('PUT', `/routes?path=/bad&domain=${DOMAIN}`, patch);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(REFUSAL);
    }
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBe(BAD);
  });

  it('migrate and transfer answer 409 and move nothing', async () => {
    const migrate = await call(
      'POST',
      `/routes/migrate?oldPath=/bad&newPath=/moved&domain=${DOMAIN}`,
    );
    expect(migrate.status).toBe(409);
    expect(await migrate.json()).toEqual(REFUSAL);
    const transfer = await call('POST', '/routes/transfer', {
      path: '/bad',
      fromDomain: DOMAIN,
      toDomain: 'secondary.example.net',
    });
    expect(transfer.status).toBe(409);
    expect(await transfer.json()).toEqual(REFUSAL);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/moved'))).toBeNull();
    expect(await env.ROUTES.get(routeKey('secondary.example.net', '/bad'))).toBeNull();
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBe(BAD);
  });

  it('seed skips it rather than overwriting it', async () => {
    const response = await call('POST', `/routes/seed?domain=${DOMAIN}`, {
      routes: [{ path: '/bad', type: 'redirect', target: 'https://example.com/new' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { created: 0, skipped: 1 } });
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBe(BAD);
  });

  it('DELETE removes it, and nothing logged or answered quotes the value', async () => {
    const response = await call('DELETE', `/routes?path=/bad&domain=${DOMAIN}`);
    expect(response.status).toBe(200);
    expect(await env.ROUTES.get(routeKey(DOMAIN, '/bad'))).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});

describe('an invalid stored route through the router', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it('a visitor gets a 404, not the wildcard above it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await env.ROUTES.put(routeKey(ADMIN_HOST, '/docs/private'), BAD);
      await env.ROUTES.put(
        routeKey(ADMIN_HOST, '/docs/*'),
        JSON.stringify({
          path: '/docs/*',
          type: 'redirect',
          target: 'https://example.net/public',
          createdAt: 0,
          updatedAt: 0,
        }),
      );
      const response = await SELF.fetch(`https://${ADMIN_HOST}/docs/private`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(secret);
      const other = await SELF.fetch(`https://${ADMIN_HOST}/docs/other`, { redirect: 'manual' });
      expect(other.status).toBe(302);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('an invalid stored route never yields to the service binding', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it('a visitor gets a 404, not the bound site, and a preview answers HTTP 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const binding = vi.fn<() => Promise<Response>>(
      async () => new Response('<title>Site</title>', { headers: { 'Content-Type': 'text/html' } }),
    );
    const testEnv = {
      ...env,
      EXAMPLE_SITE: { fetch: binding } as unknown as Fetcher,
    } as unknown as Bindings;
    try {
      await env.ROUTES.put(routeKey(ADMIN_HOST, '/about'), BAD);
      const ctx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext;
      const response = await worker.fetch(
        new Request(`https://${ADMIN_HOST}/about`, { redirect: 'manual' }),
        testEnv,
        ctx,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(secret);
      const answer = await ownHostResolver(testEnv).resolve(
        new URL(`https://${ADMIN_HOST}/about`),
        new AbortController().signal,
      );
      expect(answer.kind === 'response' ? answer.response.status : answer.kind).toBe(404);
      expect(binding).not.toHaveBeenCalled();
      // A path with no record still reaches the site
      const other = await worker.fetch(new Request(`https://${ADMIN_HOST}/other`), testEnv, ctx);
      expect(other.status).toBe(200);
      expect(binding).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('request bodies are read as unknown and validated', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it.each([
    ['not JSON', '{'],
    ['null', 'null'],
    ['an array', '[]'],
    ['routes as an object', '{"routes":{}}'],
  ])('seed refuses a body that is %s with a fixed 400', async (_label, text) => {
    const response = await app.fetch(
      new Request(`https://${ADMIN_HOST}/api/routes/seed?domain=${DOMAIN}`, {
        method: 'POST',
        headers,
        body: text,
      }),
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect([
      'Invalid JSON body',
      JSON.stringify({ success: false, error: 'Request body must contain a "routes" array' }),
    ]).toContain(body);
  });
});
