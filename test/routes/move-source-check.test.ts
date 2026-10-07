/**
 * A migrate or transfer moves the record its handler checked, and nothing
 * else (v1.38.0). The handler reads the source once (for the credential guard,
 * the merge and the audit row); the KV layer only confirms that the record is
 * still the same before it writes. KV has no compare-and-set, so a source that
 * has gone answers 404, one replaced in between answers 409
 * `ROUTE_SOURCE_CHANGED`, and an unreadable one 409 `ROUTE_RECORD_INVALID`;
 * nothing is ever re-read and merged onto a different record. A move to the
 * same path, or a transfer to the same domain, answers 400 before any read.
 */

import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv, Bindings } from '../../src/types';
import { clearAllRoutes, createAuditLogsTable, createSettlingExecutionContext } from '../helpers';

const DOMAIN = 'links.example.com';
const OTHER = 'secondary.example.net';
const headers = { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' };
const app = new Hono<AppEnv>().route('/api', adminRoutes);

const STORED = {
  path: '/promo',
  type: 'redirect',
  target: 'https://example.com/landing',
  statusCode: 302,
  enabled: true,
  createdAt: 1000,
  updatedAt: 1000,
};
const REPLACED = { ...STORED, target: 'https://example.com/replaced', updatedAt: 2000 };

/**
 * The routes namespace with a hook before every read of a key: `onRead(key,
 * n)` runs before the n-th read of `key`, so a test can change the record
 * between the handler's read and the KV layer's confirmation.
 */
function scriptedRoutes(onRead: (key: string, count: number) => Promise<void>): {
  kv: KVNamespace;
  reads: string[];
} {
  const counts = new Map<string, number>();
  const reads: string[] = [];
  const kv = new Proxy(env.ROUTES, {
    get(target, property) {
      if (property === 'get') {
        return async (key: string, ...rest: unknown[]) => {
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          reads.push(key);
          await onRead(key, count);
          return Reflect.apply(target.get, target, [key, ...rest]);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { kv, reads };
}

async function post(path: string, body: unknown, routes: KVNamespace = env.ROUTES) {
  const { ctx, settled } = createSettlingExecutionContext();
  const bindings = { ...env, ROUTES: routes } as Bindings;
  const response = await app.fetch(
    new Request(`https://example.com/api${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    bindings,
    ctx,
  );
  await settled();
  return response;
}

const stored = async (domain: string, path: string): Promise<unknown> => {
  const text = await env.ROUTES.get(routeKey(domain, path));
  return text === null ? null : JSON.parse(text);
};

const SOURCE_KEY = routeKey(DOMAIN, '/promo');
const migratePath = `/routes/migrate?oldPath=/promo&newPath=/promo-2&domain=${DOMAIN}`;
const transferBody = { path: '/promo', fromDomain: DOMAIN, toDomain: OTHER };

describe('a move confirms the record its handler checked', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
  });
  afterEach(() => vi.restoreAllMocks());

  describe.each([
    [
      'migrate',
      (kv: KVNamespace) => post(migratePath, { cacheControl: 'no-store' }, kv),
      DOMAIN,
      '/promo-2',
    ],
    [
      'migrate without a patch',
      (kv: KVNamespace) => post(migratePath, undefined, kv),
      DOMAIN,
      '/promo-2',
    ],
    ['transfer', (kv: KVNamespace) => post('/routes/transfer', transferBody, kv), OTHER, '/promo'],
  ] as const)('%s', (_label, send, toDomain, toPath) => {
    it('refuses a source replaced after the handler read it, writing nothing', async () => {
      await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
      const { kv } = scriptedRoutes(async (key, count) => {
        if (key === SOURCE_KEY && count === 2) {
          await env.ROUTES.put(SOURCE_KEY, JSON.stringify(REPLACED));
        }
      });
      const put = vi.spyOn(env.ROUTES, 'put');
      const response = await send(kv);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        success: false,
        error: 'ROUTE_SOURCE_CHANGED',
        message: expect.any(String),
      });
      // Only the test's own replacement was written
      expect(put.mock.calls.map(([key]) => key)).toEqual([SOURCE_KEY]);
      expect(await stored(toDomain, toPath)).toBeNull();
      expect(await stored(DOMAIN, '/promo')).toEqual(REPLACED);
    });

    it('answers 404 for a source that appears only after the handler read it', async () => {
      const { kv } = scriptedRoutes(async (key, count) => {
        if (key === SOURCE_KEY && count === 2) {
          await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
        }
      });
      const response = await send(kv);
      expect(response.status).toBe(404);
      expect(await stored(toDomain, toPath)).toBeNull();
    });

    it('answers 404 for a source deleted after the handler read it', async () => {
      await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
      const { kv } = scriptedRoutes(async (key, count) => {
        if (key === SOURCE_KEY && count === 2) await env.ROUTES.delete(SOURCE_KEY);
      });
      const response = await send(kv);
      expect(response.status).toBe(404);
      expect(await stored(toDomain, toPath)).toBeNull();
    });

    it('answers 409 ROUTE_RECORD_INVALID for a source made unreadable in between', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
      const { kv } = scriptedRoutes(async (key, count) => {
        if (key === SOURCE_KEY && count === 2) await env.ROUTES.put(SOURCE_KEY, '{"path":');
      });
      const response = await send(kv);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'ROUTE_RECORD_INVALID' });
      expect(await stored(toDomain, toPath)).toBeNull();
    });

    it('moves an unchanged source as before', async () => {
      await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
      const { kv } = scriptedRoutes(async () => {});
      const response = await send(kv);
      expect(response.status).toBe(200);
      expect(await stored(toDomain, toPath)).toMatchObject({ target: STORED.target });
      expect(await stored(DOMAIN, '/promo')).toBeNull();
    });
  });

  it('a move to the same path answers 400 before any read', async () => {
    await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
    const { kv, reads } = scriptedRoutes(async () => {});
    for (const newPath of ['/promo', '/Promo', '/promo/']) {
      const response = await post(
        `/routes/migrate?oldPath=/promo&newPath=${newPath}&domain=${DOMAIN}`,
        { cacheControl: 'no-store' },
        kv,
      );
      expect(response.status).toBe(400);
    }
    expect(reads).toEqual([]);
  });

  it('a transfer to the same domain answers 400 before any read', async () => {
    await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
    const { kv, reads } = scriptedRoutes(async () => {});
    const response = await post('/routes/transfer', { ...transferBody, toDomain: DOMAIN }, kv);
    expect(response.status).toBe(400);
    expect(reads).toEqual([]);
  });
});

/** One admin request with the routes namespace `routes`. */
async function call(method: string, path: string, body: unknown, routes: KVNamespace) {
  const { ctx, settled } = createSettlingExecutionContext();
  const bindings = { ...env, ROUTES: routes } as Bindings;
  const response = await app.fetch(
    new Request(`https://example.com/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    bindings,
    ctx,
  );
  await settled();
  return response;
}

// v1.39.0: PUT read the route for its guards and audit row, then updateRoute
// read the key again and merged the patch into whatever was stored then. The
// scripted namespace changes the record between the two reads; in production
// both reads usually come from the same KV edge cache, so this is a best-effort
// check, not a lock.
describe('an edit writes the record its handler checked', () => {
  const putPath = `/routes?path=/promo&domain=${DOMAIN}`;
  const patch = { cacheControl: 'no-store' };

  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a route replaced after the handler read it, writing nothing', async () => {
    await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
    const { kv } = scriptedRoutes(async (key, count) => {
      if (key === SOURCE_KEY && count === 2) {
        await env.ROUTES.put(SOURCE_KEY, JSON.stringify(REPLACED));
      }
    });
    const put = vi.spyOn(env.ROUTES, 'put');
    const response = await call('PUT', putPath, patch, kv);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'ROUTE_SOURCE_CHANGED',
      message:
        'This route changed while it was being edited, so nothing was saved. Reload it and try again.',
    });
    // Only the test's own replacement was written, and it stands unmerged
    expect(put.mock.calls.map(([key]) => key)).toEqual([SOURCE_KEY]);
    expect(await stored(DOMAIN, '/promo')).toEqual(REPLACED);
  });

  it('answers 404 for a route deleted after the handler read it', async () => {
    await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
    const { kv } = scriptedRoutes(async (key, count) => {
      if (key === SOURCE_KEY && count === 2) await env.ROUTES.delete(SOURCE_KEY);
    });
    const response = await call('PUT', putPath, patch, kv);
    expect(response.status).toBe(404);
    expect(await stored(DOMAIN, '/promo')).toBeNull();
  });

  it('merges the patch into the unchanged record it checked', async () => {
    await env.ROUTES.put(SOURCE_KEY, JSON.stringify(STORED));
    const { kv, reads } = scriptedRoutes(async () => {});
    const response = await call('PUT', putPath, patch, kv);
    expect(response.status).toBe(200);
    expect(reads.filter(key => key === SOURCE_KEY)).toHaveLength(2);
    expect(await stored(DOMAIN, '/promo')).toMatchObject({
      target: STORED.target,
      cacheControl: 'no-store',
      createdAt: STORED.createdAt,
    });
  });
});

// v1.39.0: normalize-case listed every route, then wrote each mixed-case one
// under its lowercase key and deleted the old key, so a route deleted after
// the listing came back, and one replaced after it was overwritten by the
// stale listed copy. It now confirms the old key first (best effort, as above).
describe('normalize-case moves only the record it listed', () => {
  const MIXED_KEY = routeKey(DOMAIN, '/Promo');
  const LOWER_KEY = routeKey(DOMAIN, '/promo');
  const MIXED = { ...STORED, path: '/Promo' };

  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
    await env.ROUTES.put(MIXED_KEY, JSON.stringify(MIXED));
  });
  afterEach(() => vi.restoreAllMocks());

  async function normalize(onSecondRead: () => Promise<void>) {
    const { kv } = scriptedRoutes(async (key, count) => {
      if (key === MIXED_KEY && count === 2) await onSecondRead();
    });
    const response = await call('POST', '/routes/normalize-case', undefined, kv);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      data: { migrated: number; skipped: number; errors: string[] };
    };
  }

  it('reports a route replaced after the listing and writes nothing', async () => {
    const replaced = { ...MIXED, target: 'https://example.com/replaced', updatedAt: 2000 };
    const { data } = await normalize(() => env.ROUTES.put(MIXED_KEY, JSON.stringify(replaced)));
    expect(data.migrated).toBe(0);
    expect(data.errors).toEqual([
      `${MIXED_KEY}: ROUTE_SOURCE_CHANGED: changed while being moved, skipping`,
    ]);
    expect(await env.ROUTES.get(LOWER_KEY)).toBeNull();
    expect(JSON.parse((await env.ROUTES.get(MIXED_KEY)) ?? 'null')).toEqual(replaced);
  });

  it('reports a route deleted after the listing and recreates nothing', async () => {
    const { data } = await normalize(() => env.ROUTES.delete(MIXED_KEY));
    expect(data.migrated).toBe(0);
    expect(data.errors).toEqual([
      `${MIXED_KEY}: ROUTE_NOT_FOUND: deleted while being moved, skipping`,
    ]);
    expect(await env.ROUTES.get(LOWER_KEY)).toBeNull();
    expect(await env.ROUTES.get(MIXED_KEY)).toBeNull();
  });

  it('reports a route made unreadable after the listing and leaves it alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { data } = await normalize(() => env.ROUTES.put(MIXED_KEY, '{"path":'));
    expect(data.migrated).toBe(0);
    expect(data.errors).toEqual([
      `${MIXED_KEY}: ROUTE_SOURCE_CHANGED: changed while being moved, skipping`,
    ]);
    expect(await env.ROUTES.get(LOWER_KEY)).toBeNull();
    expect(await env.ROUTES.get(MIXED_KEY)).toBe('{"path":');
  });

  it('moves an unchanged route as before', async () => {
    const { data } = await normalize(async () => {});
    expect(data).toMatchObject({ migrated: 1, errors: [] });
    expect(await env.ROUTES.get(MIXED_KEY)).toBeNull();
    expect(JSON.parse((await env.ROUTES.get(LOWER_KEY)) ?? 'null')).toMatchObject({
      path: '/promo',
      target: STORED.target,
      createdAt: STORED.createdAt,
    });
  });

  it('moves a legacy record that stores its own domain field, without that field', async () => {
    await env.ROUTES.put(MIXED_KEY, JSON.stringify({ ...MIXED, domain: DOMAIN }));
    const { data } = await normalize(async () => {});
    expect(data).toMatchObject({ migrated: 1, errors: [] });
    expect(await env.ROUTES.get(MIXED_KEY)).toBeNull();
    const moved = JSON.parse((await env.ROUTES.get(LOWER_KEY)) ?? 'null') as Record<
      string,
      unknown
    >;
    expect(moved).toMatchObject({ path: '/promo', target: STORED.target });
    expect(moved).not.toHaveProperty('domain');
  });
});
