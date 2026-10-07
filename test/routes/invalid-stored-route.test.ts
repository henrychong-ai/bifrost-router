/**
 * An invalid stored route through the admin API and the router (v1.38.0):
 * GET and every write except DELETE answer a fixed 409 ROUTE_RECORD_INVALID,
 * the listing shows it as a minimal row, a visitor gets a 404 rather than a
 * broader wildcard, and DELETE removes it (the recovery), purging its public
 * URL and auditing its key. Nothing quotes the stored value.
 */
import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import { type AppEnv, type Bindings, CLOUDFLARE_ZONE_IDS } from '../../src/types';
import { ownHostResolver } from '../../src/utils/og-own-host';
import {
  clearAllRoutes,
  createAuditLogsTable,
  createSettlingExecutionContext,
  requestBodyText,
} from '../helpers';

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

/** The paths a one-domain route listing answers with. */
const listedPaths = async (query: string) =>
  (
    (await (await call('GET', `/routes?domain=${DOMAIN}${query}`)).json()) as {
      data: { routes: Array<{ path: string }> };
    }
  ).data.routes.map(route => route.path);

describe('an invalid stored route through the API', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearAllRoutes();
    await env.ROUTES.put(routeKey(DOMAIN, '/bad'), BAD);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('GET answers 409 ROUTE_RECORD_INVALID, never 404', async () => {
    const one = await call('GET', `/routes?path=/bad&domain=${DOMAIN}`);
    expect(one.status).toBe(409);
    expect(await one.json()).toEqual(REFUSAL);
  });

  it('the listings show it as a minimal row, after the readable routes', async () => {
    await env.ROUTES.put(
      routeKey(DOMAIN, '/good'),
      JSON.stringify({ path: '/good', type: 'redirect', target: 'https://example.com/g' }),
    );
    for (const query of [`?domain=${DOMAIN}`, '']) {
      const list = await call('GET', `/routes${query}`);
      expect(list.status).toBe(200);
      const body = await list.text();
      expect(body).not.toContain(secret);
      const { routes } = (JSON.parse(body) as { data: { routes: Array<Record<string, unknown>> } })
        .data;
      expect(routes.map(route => route['path'])).toEqual(['/good', '/bad']);
      expect(routes[1]).toEqual({ domain: DOMAIN, path: '/bad', invalid: true });
    }
  });

  it('an invalid row matches a search by its path, and no type or enabled filter', async () => {
    expect(await listedPaths('&search=bad')).toEqual(['/bad']);
    // In a one-domain list the domain every row shares is never matched
    expect(await listedPaths('&search=links.example')).toEqual([]);
    expect(await listedPaths('&search=secret')).toEqual([]);
    expect(await listedPaths('&type=redirect')).toEqual([]);
    expect(await listedPaths('&enabled=true')).toEqual([]);
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

describe('deleting an invalid stored route purges its URL and audits its key', () => {
  let purged: string[] = [];
  beforeAll(() => {
    CLOUDFLARE_ZONE_IDS['example.com'] = 'test-zone-id';
  });
  afterAll(() => {
    delete CLOUDFLARE_ZONE_IDS['example.com'];
  });
  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
    await env.DB.prepare('DELETE FROM audit_logs').run();
    purged = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/purge_cache')) {
          purged.push(...(JSON.parse(requestBodyText(init)) as { files: string[] }).files);
        }
        return Response.json({ success: true });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('purges the public URL from the key, whatever the record served, and audits the key', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/report'), BAD);
    const { ctx, settled } = createSettlingExecutionContext();
    const response = await app.fetch(
      new Request(`https://${ADMIN_HOST}/api/routes?path=/Report/&domain=${DOMAIN}`, {
        method: 'DELETE',
        headers,
      }),
      { ...env, CLOUDFLARE_API_TOKEN: 'test-cloudflare-api-token' },
      ctx,
    );
    await settled();
    expect(response.status).toBe(200);
    expect(purged).toEqual([`https://${DOMAIN}/report`]);
    const row = await env.DB.prepare(
      "SELECT details FROM audit_logs WHERE action = 'delete' ORDER BY id DESC LIMIT 1",
    ).first<{ details: string }>();
    expect(JSON.parse(row?.details ?? '{}')).toEqual({
      key: `${DOMAIN}:/report`,
      state: 'invalid',
    });
    expect(row?.details).not.toContain(secret);
  });

  it('a readable redirect route is still not purged on delete', async () => {
    await env.ROUTES.put(
      routeKey(DOMAIN, '/plain'),
      JSON.stringify({ path: '/plain', type: 'redirect', target: 'https://example.com/p' }),
    );
    const { ctx, settled } = createSettlingExecutionContext();
    await app.fetch(
      new Request(`https://${ADMIN_HOST}/api/routes?path=/plain&domain=${DOMAIN}`, {
        method: 'DELETE',
        headers,
      }),
      { ...env, CLOUDFLARE_API_TOKEN: 'test-cloudflare-api-token' },
      ctx,
    );
    await settled();
    expect(purged).toEqual([]);
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

describe('the route list refuses an invalid query (v1.38.0)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await env.ROUTES.put(
      routeKey(DOMAIN, '/good'),
      JSON.stringify({ path: '/good', type: 'redirect', target: 'https://example.com/g' }),
    );
  });

  it.each([
    'limit=abc',
    'limit=0',
    'limit=1001',
    'limit=1.5',
    'limit=',
    'offset=-1',
    'offset=x',
    'type=bogus',
    'enabled=maybe',
  ])('answers 400 for %s, never an unfiltered list', async query => {
    for (const scope of [`domain=${DOMAIN}&`, '']) {
      const response = await call('GET', `/routes?${scope}${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/^Invalid query: /);
    }
  });

  it('still answers a valid query', async () => {
    expect(await listedPaths('&limit=10&offset=0&type=redirect&enabled=true')).toEqual(['/good']);
  });
});

describe('a readable record that holds an `invalid` field (v1.38.0)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it('is listed as a route with its fields, matching type and enabled filters', async () => {
    const record = {
      path: '/flagged',
      type: 'redirect',
      target: 'https://example.com/f',
      invalid: true,
    };
    await env.ROUTES.put(routeKey(DOMAIN, '/flagged'), JSON.stringify(record));
    for (const query of [`?domain=${DOMAIN}`, '', `?domain=${DOMAIN}&type=redirect`]) {
      const body = (await (await call('GET', `/routes${query}`)).json()) as {
        data: { routes: Array<Record<string, unknown>> };
      };
      expect(body.data.routes).toEqual([{ ...record, domain: DOMAIN }]);
    }
  });
});
